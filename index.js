/**
 * 无限人类命运:RP 长局记忆插件。
 * 任务书:memory-graph/项目记忆/酒馆/20260911-RP记忆插件任务书.md
 *
 * 第一段(地基):换聊天时读记忆文件;每层消息落地后按正文指纹对账,新楼解析记账块或导入旧 Narrative_Matrix。
 * 第二段(三级结构):生成前把副本重新组装成 正文区 + 摘要区 + 更早,后两区换成一个记忆块,
 *   块头是记忆层级提示词;档位跟着模型走;梦游助手的大总结整轮放行。
 * 第三段(召回):后台给每层补向量;生成前 向量粗筛 + 点名 → 重排 → 专名加分 × 时间衰减 → 按上限取,
 *   放进记忆块的 [回忆] 一节。任何一步失败都往下降级,永不卡生成。
 * 第四段(收尾):补记账、压时间线(主 API 或副 API)、面板改设置。
 *
 * 只用 SillyTavern.getContext(),不 import 酒馆内部文件,酒馆升级时少挨打。
 */

import { buildLedgerInstruction, stripLedger } from './core/ledger.js';
import { emptyMemory, reconcile, recordFromLedgerText } from './core/memory.js';
import { formatDate } from './core/calendar.js';
import { fingerprint } from './core/fingerprint.js';
import { alignCoreToRaw, buildMemoryBlock, planZones } from './core/assemble.js';
import { bestCosine, buildQueries, cosineMaps, docText, extractNarrative, makeVec, nameIdf, normalize, pickPool, scoreCandidates, selectRecall, vecFresh } from './core/recall.js';
import { buildAffinityInitMessages, buildBackfillMessages, buildBreakIfMessages, buildFateIdeaMessages, buildFateSurveyMessages, buildOriginMessages, buildTimelineMessages, parseAffinityInit, parseBreakIf, parseFateIdeas, parseFateSurvey } from './core/prompts.js';
import { activeArc, affinityTierOf, anchorKey, arcStageOf, buildAnchorPrompt, buildStatusSection, describeItems, needsAffinityInit, pendingAnchors, pendingOrigins, presentNames } from './core/people.js';
import { normalizeTimeline, parseTimelineLines, planTimelineChunks } from './core/timeline.js';
import { COMMON, WORLD, buildActsPrompt, buildNowPrompt, buildSurfacePrompt, canSurface, canSurfaceNow, coPresence, currentLimit, emptyFate, emptyThread, leakCheck, limitSteps, makePending, needsSurvey, pushLog, settlePending } from './core/fate.js';
import { embed, rerank } from './siliconflow.js';
import { FILES, loadConfig, loadIndex, mergeMemory, newMemId, readJson, saveConfigPatch, writeJson } from './store.js';

/** 跟 manifest.json 的 version 和 ?v= 手动保持一致。
 *  酒馆加载扩展脚本的网址本身不带版本号,Cloudflare 会喂旧副本,靠这行在控制台辨认在跑哪一版。 */
const VERSION = '0.6.1';
const LOG = '[无限人类命运]';
const TITLE = '无限人类命运';

/** setExtensionPrompt 的键 */
const KEY_LEDGER = 'ihf_ledger';
const KEY_MEMORY = 'ihf_memory';
/** 已定型的性格 + 当前情绪,挂 injectDepth(默认倒数第 1 条,紧挨用户末句之前) */
const KEY_ANCHOR = 'ihf_anchor';
/** 聊天还短、没有记忆块的时候,人物现状单独发 */
const KEY_STATUS = 'ihf_status';
/** extension_prompt_types.IN_CHAT / extension_prompt_roles.SYSTEM(public/script.js:483-497) */
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;

const ctx = () => SillyTavern.getContext();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const state = {
    config: null,
    index: null,
    chatId: null,
    memId: null,
    memory: null,
    view: null,
    error: '',
    saveTimer: null,
    loading: null,
    model: '',
    lastTier: null,
    tierHow: '',
    lastRun: null,
    /** 酒馆正在生成(不含预演)。主 API 的活要等它结束 */
    generating: false,
    /** 后台补向量的进度 */
    emb: { running: false, error: '' },
    /** 补记账、压时间线的进度 */
    jobs: { running: false, kind: '', done: 0, total: 0, failed: 0, stop: false, error: '' },
    /** 开局好感自动估过几次。模型老不按格式写就别一直重试,面板按钮照样能手动再来 */
    affinityInitTried: 0,
};

/** 排障用:控制台里 ihf_state 能看到当前状态,用户报 bug 时可以让她截这个。只在内存里,不存盘 */
globalThis.ihf_state = state;

function setError(msg, err) {
    state.error = msg;
    console.error(LOG, msg, err ?? '');
    render();
}

async function saveIndex() {
    await writeJson(FILES.index, state.index, ctx().getRequestHeaders());
}

/** 换聊天:读索引找记忆文件;没有就新建,是分支就照抄主线的记录 */
async function openChat() {
    const c = ctx();
    const chatId = c.getCurrentChatId();
    state.chatId = chatId;
    state.memory = null;
    state.memId = null;
    state.view = null;
    state.lastRun = null;
    if (!chatId) return render();

    const job = (async () => {
        state.index = await loadIndex();
        let memId = state.index.chats[chatId] ?? null;
        let memory = memId ? await readJson(FILES.mem(memId)) : null;
        if (!memory) {
            memory = emptyMemory(chatId);
            // 分支的元数据里只有 main_chat 一项(public/scripts/bookmarks.js:199),主线元数据不会抄过来
            const main = c.chatMetadata?.main_chat;
            const mainId = main ? state.index.chats[main] : null;
            const mainMem = mainId ? await readJson(FILES.mem(mainId)) : null;
            if (mainMem) {
                memory.floors = structuredClone(mainMem.floors ?? {});
                memory.calendar = structuredClone(mainMem.calendar ?? { start: null });
                memory.timeline = structuredClone(normalizeTimeline(mainMem).timeline);
                memory.origins = structuredClone(mainMem.origins ?? {});
                memory.anchors = structuredClone(mainMem.anchors ?? {});
                memory.affinityStart = structuredClone(mainMem.affinityStart ?? {});
                memory.affinityInitAt = mainMem.affinityInitAt ?? 0;
                memory.fate = structuredClone(mainMem.fate ?? emptyFate());
                memory.branchOf = main;
                console.info(LOG, `新分支,已从主线「${main}」复制 ${Object.keys(memory.floors).length} 条记录`);
            }
            memId = memId ?? newMemId();
            state.index.chats[chatId] = memId;
            await saveIndex();
        }
        // 第一期写的记忆文件没有这几项,补上
        memory.origins ??= {};
        memory.anchors ??= {};
        memory.affinityStart ??= {};
        memory.fate ??= emptyFate();
        return { memId, memory: normalizeTimeline(memory) };
    })();
    state.loading = job;

    try {
        const { memId, memory } = await job;
        if (ctx().getCurrentChatId() !== chatId) return; // 读的途中又换了聊天
        state.memId = memId;
        state.memory = memory;
        state.error = '';
        refresh(true);
        autoJobs();
    } catch (e) {
        setError('读记忆文件失败,本场聊天暂不记账', e);
    } finally {
        if (state.loading === job) state.loading = null;
    }
}

/** 对账。有新记录就排队存盘,并把缺的向量补上 */
function refresh(forceSave = false) {
    const c = ctx();
    if (!state.memory || c.getCurrentChatId() !== state.chatId) return;
    state.view = reconcile(state.memory, c.chat, state.config.people);
    if (state.view.added || (forceSave && !state.memory.updated)) scheduleSave();
    settleFate();
    render();
    ensureVectors();
}

function scheduleSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveMemory, 1500);
}

/** 存盘前先读一次远端:别的设备刚写过就合并再写 */
async function saveMemory() {
    const memId = state.memId;
    const memory = state.memory;
    if (!memId || !memory) return;
    try {
        const remote = await readJson(FILES.mem(memId));
        const merged = mergeMemory(memory, remote ? normalizeTimeline(remote) : null);
        merged.rev = (merged.rev ?? 0) + 1;
        merged.updated = Date.now();
        await writeJson(FILES.mem(memId), merged, ctx().getRequestHeaders());
        if (state.memId === memId) {
            state.memory = merged;
            state.error = '';
        }
    } catch (e) {
        setError('记忆文件存盘失败,稍后会重试', e);
        state.saveTimer = setTimeout(saveMemory, 15000);
    }
    render();
}

function vectorCounts() {
    const model = state.config?.siliconflow.embed_model;
    const recs = Object.values(state.memory?.floors ?? {}).filter(r => r.summary);
    return { total: recs.length, done: recs.filter(r => vecFresh(r, model)).length };
}

/** 后台补向量:一批一批算,算好就存进记忆文件。不拖生成,生成时只用已经算好的 */
async function ensureVectors() {
    const cfg = state.config;
    if (state.emb.running || !state.memory || !cfg?.recall.enabled || !cfg.siliconflow.key) return;
    const memId = state.memId;
    const model = cfg.siliconflow.embed_model;
    const todo = Object.values(state.memory.floors).filter(r => r.summary && !vecFresh(r, model));
    if (!todo.length) return;
    state.emb.running = true;
    state.emb.error = '';
    render();
    try {
        const batch = Math.max(1, cfg.recall.embedBatch);
        for (let i = 0; i < todo.length; i += batch) {
            if (state.memId !== memId) break; // 换聊天了,下次打开再接着补
            const part = todo.slice(i, i + batch);
            const vecs = await embed(part.map(docText), cfg.siliconflow);
            part.forEach((r, k) => { r.vec = makeVec(r, model, vecs[k]); });
            scheduleSave();
            render();
            await sleep(300);
        }
    } catch (e) {
        state.emb.error = String(e?.message ?? e);
        console.warn(LOG, '后台补向量失败,召回会先只按专名找', e);
    } finally {
        state.emb.running = false;
        render();
    }
}

/* ---------------- 补记账、压时间线 ---------------- */

/** 'main',或副 API 的连接编号(st:<酒馆连接配置 id> / acm:<API 管理器里的配置名>);副 API 没选返回 '' */
function backendOf(which) {
    if (which !== 'sub') return 'main';
    const id = state.config.jobs.subProfile || '';
    // 早期版本存的是不带前缀的酒馆连接配置 id
    return id && !/^(st|acm):/.test(id) ? `st:${id}` : id;
}

/**
 * 副 API 的候选,照织梦OS 的做法(zhimengos/index.js:155-176、1436-1476):
 *   酒馆自己的连接配置 → ConnectionManagerRequestService.sendRequest
 *   API 管理器(api-config-manager)里的配置 → 固定是自定义源,走 ChatCompletionService.processRequest
 * 两条都由酒馆服务端发出,公益站看到的是酒馆;key 用酒馆密钥库里的,插件一个字不存。
 * API 管理器那条没记下密钥编号就挡住:酒馆在 secret_id 为空时会默默改用当前默认的那把 key。
 * 本机地址(127.0.0.1 / localhost,比如她的本地 KoboldCpp)不挡:本来就不要 key,默认 key 也出不了这台电脑。
 */
function listConnections() {
    const c = ctx();
    const list = [];
    try {
        for (const p of c.ConnectionManagerRequestService.getSupportedProfiles()) {
            list.push({ id: `st:${p.id}`, name: p.name, group: '酒馆的连接配置', model: p.model || '', blocked: '' });
        }
    } catch { /* 连接配置扩展被关了 */ }
    const acm = c.extensionSettings?.['api-config-manager'];
    for (const a of Array.isArray(acm?.configs) ? acm.configs : []) {
        if (!a?.name) continue;
        const secretId = a.secretIds?.api_key_custom || '';
        const url = a.customUrl || a.url || '';
        const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(url);
        list.push({
            id: `acm:${a.name}`,
            name: a.name,
            group: 'API 管理器里的配置',
            url,
            model: a.model || '',
            secretId,
            blocked: secretId || local ? '' : '这条没记下密钥编号,去 API 管理器里重新保存一次就能用',
        });
    }
    return list;
}

/**
 * 发给模型,拿回纯文本。
 * 主 API 走 generateRaw:不传回复长度,因为它会临时改全局回复长度、下次生成才还原(public/script.js:4094),
 * 并且等正在进行的生成结束再发,免得插队。副 API 见 listConnections()。
 */
async function callModel(messages, backend) {
    const c = ctx();
    if (backend === 'main') {
        while (state.generating) await sleep(1000);
        const systemPrompt = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
        const prompt = messages.filter(m => m.role !== 'system').map(m => m.content).join('\n\n');
        return String(await c.generateRaw({ systemPrompt, prompt }) ?? '');
    }
    const conn = listConnections().find(x => x.id === backend);
    if (!conn) throw new Error('选的副 API 找不到了(可能在别处被删了),去面板重新选一个');
    const maxTokens = Math.max(500, Number(state.config.jobs.maxTokens) || 8000);
    if (conn.blocked) throw new Error(conn.blocked);
    let res;
    if (backend.startsWith('st:')) {
        // 预设和指令格式都不带:记账、压时间线不该扛整套预设(状态栏、思维链那些),白烧 token
        res = await c.ConnectionManagerRequestService.sendRequest(backend.slice(3), messages, maxTokens, { stream: false, extractData: true, includePreset: false, includeInstruct: false });
    } else {
        res = await c.ChatCompletionService.processRequest({
            stream: false,
            messages,
            max_tokens: maxTokens,
            model: conn.model,
            chat_completion_source: 'custom',
            custom_url: conn.url,
            secret_id: conn.secretId,
        }, {}, true, null);
    }
    return String(typeof res === 'string' ? res : res?.content ?? '').trim();
}

/** 通用的排队跑:一个一个来,按每分钟次数上限隔开;失败的记下来,跑完弹提示,不静默吞掉 */
async function runJob(kind, units, doOne) {
    if (state.jobs.running) {
        toastr.info('已经有活在跑,等它跑完或点停止', TITLE);
        return;
    }
    const memId = state.memId;
    Object.assign(state.jobs, { running: true, kind, done: 0, total: units.length, failed: 0, stop: false, error: '' });
    render();
    const gap = Math.ceil(60000 / Math.max(1, state.config.jobs.rpm));
    try {
        for (let k = 0; k < units.length; k++) {
            if (state.jobs.stop || state.memId !== memId) break;
            try {
                await doOne(units[k]);
                state.jobs.done++;
            } catch (e) {
                state.jobs.failed++;
                state.jobs.error = String(e?.cause?.message ?? e?.message ?? e);
                console.warn(LOG, kind, '失败', e);
            }
            render();
            if (k < units.length - 1 && !state.jobs.stop) await sleep(gap);
        }
    } finally {
        state.jobs.running = false;
        refresh();
        render();
        if (state.jobs.failed) toastr.warning(`${kind}:${state.jobs.failed} 个没成功(${state.jobs.error}),可以再点一次重试`, TITLE);
        else if (state.jobs.done) toastr.success(`${kind}:完成 ${state.jobs.done} 个`, TITLE);
        if (!state.jobs.failed && !state.jobs.stop) autoJobs();
    }
}

/** 补记账:没记过账的 AI 楼,拿"上一句用户发言 + 这层正文"让模型只写记账块 */
async function startBackfill(indices = null, which = null) {
    if (!state.view) return;
    const backend = backendOf(which ?? state.config.jobs.backfillBackend);
    if (!backend) return toastr.warning('补记账选了副 API,但还没选是哪个连接配置', TITLE);
    const todo = indices ?? state.view.pending;
    if (!todo.length) return toastr.info('没有待补记账的楼', TITLE);
    await runJob('补记账', todo, async idx => {
        const raw = ctx().chat;
        const m = raw[idx];
        if (!m || m.is_user || m.is_system) return;
        const fp = fingerprint(m.mes, false);
        if (state.memory.floors[fp]) return; // 期间已经有记录了
        let prevUser = '';
        for (let i = idx - 1; i >= 0; i--) {
            if (raw[i].is_system) continue;
            if (raw[i].is_user) prevUser = String(raw[i].mes ?? '');
            break;
        }
        const out = await callModel(buildBackfillMessages({ prevUser, text: extractNarrative(m.mes), modules: state.config.people?.modules }), backend);
        const rec = recordFromLedgerText(out, 'backfill');
        if (!rec) throw new Error('模型没按格式写记账块');
        state.memory.floors[fp] = rec;
        scheduleSave();
    });
}

/** 当前聊天"更早"区切出来的段(按当前档位分区) */
function currentChunks() {
    if (!state.view || !state.config) return [];
    const tier = state.config.tiers[state.lastTier] ?? state.config.tiers[state.config.defaultTier];
    const present = state.view.rows.filter(r => !r.hidden).map(r => r.index);
    const zones = planZones(present, state.view.rows, tier);
    return planTimelineChunks(state.view.rows, zones.older, state.config.timeline.chunk);
}

function pendingChunks() {
    return currentChunks().filter(ch => !state.memory?.timeline?.[ch.key]);
}

/** 压时间线:喂原文,不许拿摘要去压 */
async function startTimeline(which = null) {
    if (!state.view) return;
    const backend = backendOf(which ?? state.config.jobs.timelineBackend);
    if (!backend) return toastr.warning('压时间线选了副 API,但还没选是哪个连接配置', TITLE);
    const chunks = pendingChunks();
    if (!chunks.length) return toastr.info('没有需要压的时间线(聊天还没长到"更早"区,或者都压过了)', TITLE);
    await runJob('压时间线', chunks, async ch => {
        const raw = ctx().chat;
        const floors = ch.rows.map(r => ({
            label: r.date ? `${formatDate(r.date)} Day${r.day}` : `Day${r.day}`,
            text: extractNarrative(raw[r.index]?.mes).slice(0, state.config.timeline.floorChars),
        }));
        const out = await callModel(buildTimelineMessages(floors), backend);
        const lines = parseTimelineLines(out);
        if (!lines.length) throw new Error('模型没按格式写时间线');
        state.memory.timeline[ch.key] = { key: ch.key, from: ch.rows[0].index, to: ch.rows.at(-1).index, lines, at: Date.now() };
        scheduleSave();
    });
}

/** 当前卡的角色描述。群聊就把成员的拼起来,让模型自己在里面找要摘的那个人 */
function cardDescription() {
    const c = ctx();
    const one = id => {
        const ch = c.characters?.[id];
        return ch ? [ch.name, ch.description, ch.personality].filter(Boolean).join('\n') : '';
    };
    const group = c.groups?.find(g => String(g.id) === String(c.groupId));
    if (group) {
        return (group.members ?? [])
            .map(av => one(c.characters?.findIndex(ch => ch.avatar === av)))
            .filter(Boolean).join('\n\n');
    }
    return one(c.characterId);
}

/** 开局好感:扫一遍人设和开场白,让模型给每个人拟一个起点。
 *  一场聊天只估一次(道长:"我估计有人会忘记自己加",所以拖个底);
 *  她手改过的不会被这个覆盖,重估也只补没有的。 */
async function startAffinityInit(which = null) {
    if (!state.memory || !state.view) return;
    const backend = backendOf(which ?? state.config.jobs.backfillBackend);
    if (!backend) return toastr.warning('估开局好感选了副 API,但还没选是哪个连接配置', TITLE);
    const description = cardDescription();
    if (!description.trim()) return toastr.warning('这张卡没有角色描述,估不了开局好感', TITLE);
    const c = ctx();
    const opening = c.chat?.find(m => !m.is_user && !m.is_system)?.mes ?? '';
    await runJob('估开局好感', [1], async () => {
        const out = await callModel(buildAffinityInitMessages({
            userName: c.name1, description, opening: extractNarrative(opening),
        }), backend);
        const rows = parseAffinityInit(out);
        if (!rows.length) throw new Error('模型没按"角色 分数 理由"的格式写');
        for (const r of rows) {
            // 她手填过的不动
            if (state.memory.affinityStart[r.name]?.source === 'manual') continue;
            state.memory.affinityStart[r.name] = { value: r.value, why: r.why, source: 'llm' };
        }
        state.memory.affinityInitAt = Date.now();
        scheduleSave();
    });
}

/** 文本框里那一坨 → 词表。换行、逗号、顿号、空格都算分隔 */
function parseWordList(text) {
    const seen = new Set();
    const out = [];
    for (const raw of String(text ?? '').split(/[,，、;；\s]+/)) {
        const w = raw.trim();
        if (w && !seen.has(w)) { seen.add(w); out.push(w); }
    }
    return out;
}

/** 存物品禁词表。存完重读设置再对一遍账,表格立刻跟着变(数本来就是现算的) */
async function saveItemLists(patch) {
    try {
        await saveConfigPatch({ people: patch }, ctx().getRequestHeaders());
        state.config = await loadConfig();
        fillSettings();
        refresh();
        toastr.success('禁词表已保存', TITLE);
    } catch (e) {
        toastr.error('禁词表没存上:' + (e?.message ?? e), TITLE);
    }
}

/** 面板上点一下就把某样东西加进某张表。which: 'never' | 'common' */
function addItemWord(which, word) {
    const key = which === 'never' ? 'itemNever' : 'itemCommon';
    const cur = state.config.people[key] ?? [];
    if (cur.includes(word)) return toastr.info(`「${word}」已经在表里了`, TITLE);
    saveItemLists({ [key]: [...cur, word] });
}

/** 面板里手改开局好感。手改过的打上 manual,自动重估不会覆盖 */
function setAffinityStart(name, value) {
    if (!state.memory) return;
    const v = Math.max(-100, Math.min(100, Math.trunc(Number(value) || 0)));
    const old = state.memory.affinityStart[name] ?? {};
    state.memory.affinityStart[name] = { value: v, why: old.why ?? '', source: 'manual' };
    scheduleSave();
    refresh();
}

/** 摘性格原句:性格弧第一条的"从"必须是角色描述里的原话(道长),不许模型自己概括 */
async function startOrigins(which = null) {
    if (!state.view) return;
    const backend = backendOf(which ?? state.config.jobs.backfillBackend);
    if (!backend) return toastr.warning('摘性格原句选了副 API,但还没选是哪个连接配置', TITLE);
    const todo = pendingOrigins(state.view.people, state.memory.origins);
    if (!todo.length) return toastr.info('没有要摘原句的角色', TITLE);
    const desc = cardDescription();
    if (!desc.trim()) return toastr.warning('这张卡没有角色描述,性格弧的起点只能在面板里手填', TITLE);
    await runJob('摘性格原句', todo, async name => {
        const out = String(await callModel(buildOriginMessages({ name, description: desc }), backend) ?? '').trim();
        // 摘不到也要留个空字符串,否则每次对账都会再问一遍
        state.memory.origins[name] = /^无[。.]?$/.test(out) || out.length > 600 ? '' : out;
        scheduleSave();
    });
}

/** 性格定型时问一次"什么事会让他退回去",写死存进记忆文件,之后只让模型比对有没有发生 */
async function startBreakIf(which = null) {
    if (!state.view) return;
    const backend = backendOf(which ?? state.config.jobs.backfillBackend);
    if (!backend) return toastr.warning('问破锚条件选了副 API,但还没选是哪个连接配置', TITLE);
    const todo = pendingAnchors(state.view.people);
    if (!todo.length) return toastr.info('没有缺破锚条件的性格弧', TITLE);
    await runJob('问破锚条件', todo, async ({ name, seq, arc }) => {
        // 只拿这条弧走过的那几层的摘要当材料,让它写出来的条件贴着这个故事
        const byIndex = new Map(state.view.rows.map(r => [r.index, r]));
        const context = arc.log
            .map(l => byIndex.get(l.index)?.record?.summary)
            .filter(Boolean).slice(-8).join('\n');
        const out = await callModel(buildBreakIfMessages({ name, from: arc.from, to: arc.to, context }), backend);
        const lines = parseBreakIf(out);
        if (!lines.length) throw new Error('模型写的破锚条件太空泛,一条都没留下');
        state.memory.anchors[anchorKey(name, seq)] = { name, seq, breakIf: lines, at: Date.now() };
        scheduleSave();
    });
}

/* ---------------- 第三期:命运 ---------------- */

/** 该给谁开栏。复用开局好感估出来的名单和已经在册的人,不另花一次调用问模型 */
function fateRoster() {
    const cfg = state.config.fate;
    const me = ctx().name1;
    const names = new Set([
        ...Object.keys(state.memory.affinityStart ?? {}),
        ...Object.keys(state.view?.people ?? {}),
    ]);
    names.delete(me);
    names.delete('');
    return [...names].slice(0, cfg.maxNpc ?? 4);
}

/** 这一场的幕后各栏,按需补齐(NPC + 共同 + 世界) */
function ensureThreads() {
    const cfg = state.config.fate;
    const fate = state.memory.fate;
    let added = 0;
    for (const name of fateRoster()) {
        if (!fate.threads[name]) { fate.threads[name] = emptyThread(name, 'npc'); added++; }
    }
    const npcCount = Object.values(fate.threads).filter(t => t.kind === 'npc').length;
    if (npcCount >= 2 && !fate.threads[COMMON]) { fate.threads[COMMON] = emptyThread(COMMON, 'common'); added++; }
    if (cfg.world && !fate.threads[WORLD]) { fate.threads[WORLD] = emptyThread(WORLD, 'world'); added++; }
    if (added) scheduleSave();
    return added;
}

/** 最近几层的正文摘要,喂给推演当"主角这边发生了什么" */
function recentStory(n = 6) {
    return (state.view?.rows ?? [])
        .filter(r => !r.isUser && r.record?.summary)
        .slice(-n)
        .map(r => `Day${r.day} ${r.record.summary}`)
        .join('\n');
}

/** 立念头:给某一栏问一次"他长期惦记着什么",念头原文存进记忆文件,永不出门 */
async function startFateIdeas(which = null) {
    if (!state.memory || !state.view) return;
    const backend = backendOf(which ?? state.config.jobs.backfillBackend);
    if (!backend) return toastr.warning('立念头选了副 API,但还没选是哪个连接配置', TITLE);
    ensureThreads();
    const todo = Object.values(state.memory.fate.threads).filter(t => t.kind !== 'common' && !t.ideas.length && !t.ideasAsked);
    if (!todo.length) return toastr.info('没有要立念头的栏', TITLE);
    const card = cardDescription();
    await runJob('立念头', todo, async t => {
        const out = await callModel(buildFateIdeaMessages({
            name: t.name, card, story: recentStory(10),
            traits: state.memory.origins?.[t.name] ?? '',
            tierNames: (state.config.people.affinityTiers ?? []).map(x => x.name),
        }), backend);
        t.ideas = parseFateIdeas(out, state.config.fate.maxIdeas ?? 3);
        t.ideasAsked = true; // 问过就别反复问,哪怕一条都没立出来
        scheduleSave();
    });
}

/** 幕后推演:一人一人地问,不合并成一次调用(道长:不然模型会把所有事糊在一起) */
async function startFateSurvey(which = null) {
    if (!state.memory || !state.view) return;
    const backend = backendOf(which ?? state.config.jobs.backfillBackend);
    if (!backend) return toastr.warning('幕后推演选了副 API,但还没选是哪个连接配置', TITLE);
    const cfg = state.config.fate;
    const fate = state.memory.fate;
    ensureThreads();
    const list = Object.values(fate.threads);
    if (!list.length) return toastr.info('还没有幕后各栏(等开局好感估出人名再来)', TITLE);
    const floor = state.view.rows.length;
    const day = state.view.lastDay;
    const days = Math.max(1, day - (fate.lastRunDay < 0 ? day - 1 : fate.lastRunDay));
    const card = cardDescription();
    const story = recentStory();
    await runJob('幕后推演', list, async t => {
        const out = await callModel(buildFateSurveyMessages({
            name: t.name, kind: t.kind, card, ideas: t.ideas,
            recentLog: t.log.slice(-6).map(l => `Day${l.day} ${l.text}`).join('\n'),
            story, days,
        }), backend);
        const got = parseFateSurvey(out);
        if (t.kind !== 'common' && got.now) t.now = got.now;
        pushLog(t, day, got.log, cfg.logMax ?? 30);
        t.at = Date.now();
        // 踩中触发情形才排队浮出,而且一次只准一条、离上次要够远
        const idea = got.act ? t.ideas[got.act - 1] : null;
        if (idea && canSurface(idea) && canSurfaceNow(fate, cfg, floor)) {
            fate.pending = makePending(t, got.act - 1, floor);
            console.info(LOG, '幕后浮出排队:', fate.pending.what);
        }
        scheduleSave();
    });
    fate.lastRunFloor = floor;
    fate.lastRunDay = day;
    scheduleSave();
}

/** 每层收尾:模型写了幕后✓ 就结案,连挂几层没写就撤回水下 */
function settleFate() {
    const fate = state.memory?.fate;
    if (!fate?.pending || !state.view) return;
    const floor = state.view.rows.length;
    const done = (state.view.rows ?? []).slice(-3).flatMap(r => r.record?.fateDone ?? []);
    const what = fate.pending.what;
    const res = settlePending(fate, state.config.fate, floor, done);
    if (res.cleared) {
        console.info(LOG, '幕后已浮出到正文:', what);
        scheduleSave();
    } else if (res.dropped) {
        toastr.info('那件幕后的事模型一直没写进正文,已经撤回水下,过阵子再来', TITLE);
        scheduleSave();
    }
}

/** 自动的活只走副 API:每层回复后补记账(sub-after 模式),有整段滑出摘要区就压时间线,
 *  再顺手把缺的性格原句和破锚条件补上。一次只起一件,跑完 refresh 会再进来一次。 */
function autoJobs() {
    const cfg = state.config;
    if (!cfg || !state.view || state.jobs.running || state.generating || !cfg.jobs.subProfile) return;
    if (cfg.ledger.mode === 'sub-after') {
        const lastAi = [...state.view.rows].reverse().find(r => !r.isUser && !r.hidden);
        if (lastAi && !lastAi.record) {
            startBackfill([lastAi.index], 'sub');
            return;
        }
    }
    if (cfg.jobs.timelineAuto && cfg.jobs.timelineBackend === 'sub' && pendingChunks().length) return startTimeline('sub');
    if (cfg.people?.enabled === false) return;
    // 卡里没写角色描述就估不了,别每轮都弹一次提示;老失败也别无限重试
    if (needsAffinityInit(state.memory, cfg.people) && state.affinityInitTried < 2 && cardDescription().trim()) {
        state.affinityInitTried++;
        return startAffinityInit('sub');
    }
    if (cfg.people?.modules?.arc !== false) {
        if (pendingOrigins(state.view.people, state.memory.origins).length) return startOrigins('sub');
        if (pendingAnchors(state.view.people).length) return startBreakIf('sub');
    }
    // 命运:先给新开的栏立念头,再按层数或剧情天数推演
    if (cfg.fate?.enabled === false) return;
    ensureThreads();
    if (Object.values(state.memory.fate.threads).some(t => t.kind !== 'common' && !t.ideas.length && !t.ideasAsked)) {
        return startFateIdeas('sub');
    }
    if (needsSurvey(state.memory.fate, cfg.fate, state.view.rows.length, state.view.lastDay)) startFateSurvey('sub');
}

/* ---------------- 召回 ---------------- */

/**
 * 召回。任何一步失败都往下降级:重排失败只按向量,向量失败只按专名,都失败就这轮不召回。
 * @returns {Promise<{items:object[], ms:number, notes:string[]}>}
 */
async function runRecall(raw, view, zones, tier) {
    const cfg = state.config;
    const rc = cfg.recall;
    const t0 = performance.now();
    const notes = [];
    const body = new Set(zones.body);
    const summaryZone = new Set(zones.summary);
    const cands = view.rows.filter(r => !r.isUser && !r.hidden && r.record?.summary && !body.has(r.index));
    const qs = buildQueries(raw, rc);
    if (!rc.enabled || !cands.length || !qs) return { items: [], ms: 0, notes };
    if (qs.short) notes.push('这句太短,带上了 AI 回复一起查');

    const sf = cfg.siliconflow;
    let maps = [];
    if (sf.key) {
        try {
            const qvecs = (await embed(qs.pool, sf, 8000)).map(normalize);
            maps = cosineMaps(qvecs, cands, sf.embed_model);
            const n = maps[0]?.size ?? 0;
            if (n < cands.length) notes.push(`向量还没补完 ${n}/${cands.length}`);
        } catch (e) {
            notes.push('向量失败,只按专名找');
            console.warn(LOG, e);
        }
    } else {
        notes.push('没填 key,只按专名找');
    }

    const cos = bestCosine(maps);
    const pool = pickPool(cands, maps, qs.rank, rc);
    const rr = new Map();
    if (sf.key && pool.length) {
        try {
            const res = await rerank(qs.rank, pool.map(r => docText(r.record)), sf, 8000);
            for (const x of res) if (pool[x.index]) rr.set(pool[x.index].index, x.relevance_score);
        } catch (e) {
            notes.push('重排失败,按向量排');
            console.warn(LOG, e);
        }
    }

    const idf = nameIdf(cands.map(r => r.record));
    const scored = scoreCandidates({ pool, cos, rr, query: qs.rank, idf, cfg: rc, lastDay: view.lastDay });
    const textFor = row => {
        const full = extractNarrative(raw[row.index].mes);
        if (tier.recallGives === 'full') return full;
        return summaryZone.has(row.index) ? full : row.record.summary;
    };
    const items = selectRecall(scored, { minScore: rc.minScore, relMin: rc.relMin, maxItems: tier.recallMax, budget: tier.recallChars, textFor });
    return { items, ms: performance.now() - t0, notes, top: scored.slice(0, 5).map(s => ({ floor: s.row.index, score: +s.score.toFixed(3), from: s.from, hits: s.hits })) };
}

/* ---------------- 档位、放行、旧记忆检测 ---------------- */

/** 当前模型名。对照 public/scripts/openai.js:1698 getChatCompletionModel:
 *  除了 makersuite 存在 google_model,其余来源都存在 <来源>_model。文本补全先取连接状态里的名字。 */
function currentModel() {
    const c = ctx();
    if (c.mainApi !== 'openai') return String(c.onlineStatus ?? '');
    const s = c.chatCompletionSettings ?? {};
    const src = s.chat_completion_source;
    return String((src === 'makersuite' ? s.google_model : s[`${src}_model`]) ?? '');
}

/** 档位跟着模型走(任务书第四节):锁档 > 对照规则 > 上一次的档位 > 默认档 */
function resolveTier(model) {
    const cfg = state.config;
    if (cfg.tierLock && cfg.tiers[cfg.tierLock]) return { tier: cfg.tierLock, how: 'lock' };
    const m = model.toLowerCase();
    for (const r of cfg.tierRules ?? []) {
        if (r?.match && cfg.tiers[r.tier] && m.includes(String(r.match).toLowerCase())) return { tier: r.tier, how: 'rule' };
    }
    if (state.lastTier && cfg.tiers[state.lastTier]) return { tier: state.lastTier, how: 'fallback' };
    return { tier: cfg.defaultTier, how: 'fallback' };
}

function updateTier(announce) {
    if (!state.config) return null;
    const model = currentModel();
    const { tier, how } = resolveTier(model);
    const changed = state.lastTier !== null && tier !== state.lastTier;
    state.model = model;
    state.lastTier = tier;
    state.tierHow = how;
    if (announce && changed) {
        toastr.info(`已切到${state.config.tiers[tier].label}(${model || '未知模型'})`, TITLE);
    }
    render();
    return tier;
}

/** 梦游助手的大总结走普通生成(梦游助手 v1.5 第 2743 行 /send … | /trigger),要发全文,插件整轮放行。
 *  两道保险:梦游助手发之前设 globalThis.ihf_bypassOnce = true(待梦游助手 v1.6 接上);
 *  或者最后一句用户发言就是大总结的请求格式。 */
function isArchiveRun(raw) {
    if (globalThis.ihf_bypassOnce) {
        globalThis.ihf_bypassOnce = false;
        return true;
    }
    for (let i = raw.length - 1; i >= 0; i--) {
        if (raw[i].is_user) {
            const m = String(raw[i].mes ?? '');
            return m.includes('<Story_Archive') && m.includes('输出模板');
        }
    }
    return false;
}

/** 美梦巡游那套旧记忆还开着就提醒:两套一起跑会互相打架 */
function detectLegacy() {
    const c = ctx();
    const out = [];
    if (c.chat?.some(m => typeof m.mes === 'string' && m.mes.startsWith('<span data-rag='))) {
        out.push('美梦巡游的「🧠记忆系统」脚本还在跑');
    }
    const s = c.chatCompletionSettings;
    const order = s?.prompt_order?.find?.(x => x.character_id === 100001)?.order ?? [];
    const on = new Set(order.filter(x => x.enabled).map(x => x.identifier));
    for (const p of s?.prompts ?? []) {
        if (on.has(p.identifier) && /🧬\s*摘要|🧠\s*认知/.test(p.name ?? '')) out.push(`预设条目「${p.name}」还开着`);
    }
    return out;
}

/* ---------------- 生成拦截 ---------------- */

/** 算好这一轮要怎么组装,但不动副本。聊天还短、不需要压缩时返回的 block 为 null */
async function planRun(core) {
    const c = ctx();
    if (!state.memory || c.getCurrentChatId() !== state.chatId) return null;
    const raw = c.chat;
    const view = reconcile(state.memory, raw, state.config.people);
    state.view = view;
    if (view.added) scheduleSave();

    const tierName = updateTier(false);
    const tier = state.config.tiers[tierName];
    const map = alignCoreToRaw(core, raw);
    const zones = planZones(map.filter(i => i >= 0), view.rows, tier);
    const pcfg = state.config.people;
    const userName = c.name1 || '用户';
    const status = pcfg?.enabled === false ? '' : buildStatusSection({ people: view.people, promises: view.promises, items: view.items, rows: view.rows, cfg: pcfg, userName });
    let anchor = pcfg?.enabled === false ? '' : buildAnchorPrompt({ people: view.people, rows: view.rows, cfg: pcfg });
    const fcfg = state.config.fate;
    const fate = state.memory.fate;
    if (fcfg?.enabled !== false && fate) {
        const here = presentNames(view.rows, pcfg.presentFloors ?? 12);
        // 顺序有讲究:先说别人在哪、再说在场的怎么演,最后那条命令挨着生成点
        const actsCtx = {
            people: view.people, tiers: pcfg.affinityTiers, rows: view.rows,
            // 好感度关着的时候 affinity 恒为 0,梯子得换条绳子爬(道长)
            useAffinity: pcfg.modules?.affinity !== false,
        };
        anchor = [anchor, buildNowPrompt(fate, fcfg), buildActsPrompt(fate, here, fcfg, actsCtx), buildSurfacePrompt(fate.pending)]
            .filter(Boolean).join('\n\n');
    }
    if (!zones.summary.length && !zones.older.length) return { tierName, block: null, status, anchor };

    let recall = { items: [], ms: 0, notes: [] };
    try {
        recall = await runRecall(raw, view, zones, tier);
    } catch (e) {
        recall.notes = ['召回出错,这轮不召回'];
        console.warn(LOG, e);
    }

    const timeline = planTimelineChunks(view.rows, zones.older, state.config.timeline.chunk)
        .map(ch => ({ rows: ch.rows, lines: state.memory.timeline?.[ch.key]?.lines ?? null }));
    const al = state.config.archiveLine;
    const archive = al === 'always' || (al === 'auto' && raw.some(m => m.is_system));
    const block = buildMemoryBlock({ rows: view.rows, chat: raw, zones, lastDay: view.lastDay, start: view.start, tier, archive, recall: recall.items, timeline, status });
    return { tierName, block, map, keep: new Set(zones.body), recall, status, anchor };
}

/** 生成拦截器(manifest.json 的 generate_interceptor)。
 *  chat 是酒馆现造的浅拷贝(public/script.js:4465),改 mes、删层都不伤聊天文件;只有 extra 和原件共用,不许碰。
 *  整轮先算好再动手,算的途中出错就原样发送,绝不发一个删了一半的聊天。 */
globalThis.ihf_interceptor = async function (chat, _contextSize, _abort, type) {
    const c = ctx();
    const clearAll = () => {
        c.setExtensionPrompt(KEY_LEDGER, '', IN_CHAT, 0);
        c.setExtensionPrompt(KEY_MEMORY, '', IN_CHAT, 0);
        c.setExtensionPrompt(KEY_ANCHOR, '', IN_CHAT, 0);
        c.setExtensionPrompt(KEY_STATUS, '', IN_CHAT, 0);
    };
    try {
        if (!state.config?.enabled || type === 'quiet') return clearAll();
        if (isArchiveRun(c.chat)) {
            clearAll();
            state.lastRun = { bypass: true };
            console.info(LOG, '这一轮是梦游助手的大总结,整轮放行,全文照发');
            render();
            return;
        }

        const plan = await planRun(chat);
        // 不许挂 0:深度 0 插在整段对话最后面,会把用户那句顶掉(见 store.js injectDepth)
        const depth = Math.max(1, Number(state.config.injectDepth) || 1);

        for (const m of chat) {
            if (typeof m.mes === 'string' && m.mes.includes('ihf-ledger')) m.mes = stripLedger(m.mes);
        }
        if (plan?.block) {
            for (let k = chat.length - 1; k >= 0; k--) {
                if (plan.map[k] >= 0 && !plan.keep.has(plan.map[k])) chat.splice(k, 1);
            }
            // 深度 = 剩下的正文条数,记忆块就落在正文区最前面(这条是算出来的,与 injectDepth 无关)
            c.setExtensionPrompt(KEY_MEMORY, plan.block.text, IN_CHAT, chat.length, false, ROLE_SYSTEM);
            c.setExtensionPrompt(KEY_STATUS, '', IN_CHAT, 0);
        } else {
            c.setExtensionPrompt(KEY_MEMORY, '', IN_CHAT, 0);
            // 聊天还短、没有记忆块的时候,人物现状也得发,不然开局那几十层好感白记
            c.setExtensionPrompt(KEY_STATUS, plan?.status ? ['<记忆>', plan.status, '</记忆>'].join('\n') : '', IN_CHAT, depth, false, ROLE_SYSTEM);
        }
        // 已定型的性格和当前情绪挂紧挨用户最后那句之前:注意力一样高,但末条还是用户(道长)
        c.setExtensionPrompt(KEY_ANCHOR, plan?.anchor ?? '', IN_CHAT, depth, false, ROLE_SYSTEM);

        const inline = state.config.ledger.mode === 'main-inline';
        const mods = { ...state.config.people?.modules, fate: state.config.fate?.enabled !== false };
        const text = state.config.ledger.instruction || buildLedgerInstruction(mods);
        c.setExtensionPrompt(KEY_LEDGER, inline ? text : '', IN_CHAT, depth, false, ROLE_SYSTEM);

        state.lastRun = plan?.block
            ? { ...plan.block.stats, recallMs: plan.recall.ms, recallNotes: plan.recall.notes, recallTop: plan.recall.top }
            : { short: true };
        render();
    } catch (e) {
        console.error(LOG, '拦截器出错,本轮不压缩,原样发送', e);
        try { c.setExtensionPrompt(KEY_MEMORY, '', IN_CHAT, 0); } catch { /* 已经在出错路径上了 */ }
    }
};

/**
 * 抽屉标题上那个 New! 角标:有新版就亮出来。
 *
 * 走酒馆自己的 `POST /api/extensions/version`。**服务端会真的 git fetch 一次**
 * (src/endpoints/extensions.js),是一趟到 GitHub 的往返,所以绝不能放在开屏关键路径上,
 * 等页面歇下来再问,一个页面只问一次。
 *
 * 坑(织梦者那边踩过):这个端点对"不是 git 仓库"的目录返回 200 + 空字符串 + isUpToDate:true。
 * 所以判断能不能更新**必须先看 currentCommitHash 有没有值**,不能只看 isUpToDate,
 * 否则手动拷进去的文件夹会被当成"已是最新"。
 */
async function checkUpdate() {
    if (state.config?.checkUpdate === false) return;
    try {
        const res = await fetch('/api/extensions/version', {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            // 端点自己会 sanitize,给光文件夹名就行,不要带 third-party/ 前缀
            body: JSON.stringify({ extensionName: 'infinite-human-fate', global: false }),
        });
        if (!res.ok) return;
        const d = await res.json();
        if (!d.currentCommitHash || d.isUpToDate) return;
        $('#ihf-new')
            .attr('title', `有新版可以更新(本地 ${String(d.currentCommitHash).slice(0, 7)})。去「织梦者 → 我的插件」,或者酒馆自己的扩展管理里点更新。`)
            .prop('hidden', false);
        console.info(LOG, '有新版可以更新');
    } catch (e) {
        console.debug(LOG, '查更新没问成,不影响使用', e);
    }
}

/* ---------------- 面板 ---------------- */

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function describeRun(r) {
    if (!r) return '还没生成过';
    if (r.bypass) return '梦游助手大总结,整轮放行(全文照发)';
    if (r.short) return '聊天还短,没有压缩';
    const pend = r.summaryPending ? `(其中未记账 ${r.summaryPending})` : '';
    const older = r.older ? ` · 更早:时间线 ${r.timelineLines ?? 0} 行${r.fallbackSummaries ? ` + ${r.fallbackSummaries} 条摘要顶替(那几段还没压)` : ''}${r.olderDropped ? `,超字数没发 ${r.olderDropped} 段` : ''}` : '';
    const recall = ` · 回忆 ${r.recall} 条 ${r.recallChars} 字,用时 ${((r.recallMs ?? 0) / 1000).toFixed(1)} 秒${r.recallNotes?.length ? '(' + r.recallNotes.join(';') + ')' : ''}`;
    return `正文 ${r.body} 层 · 摘要 ${r.summary} 条${pend}${older}${recall} · 记忆块 ${r.chars} 字`;
}

function describeJobs() {
    const j = state.jobs;
    if (j.running) return `${j.kind}中:${j.done}/${j.total}${j.failed ? `,失败 ${j.failed}` : ''}${j.stop ? '(停止中…)' : ''}`;
    if (j.kind) return `上次${j.kind}:完成 ${j.done}/${j.total}${j.failed ? `,失败 ${j.failed}(${j.error})` : ''}`;
    return '';
}

function render() {
    const el = document.getElementById('ihf-status');
    if (!el) return;
    const lines = [];
    if (!state.config) {
        lines.push('读设置中…');
    } else {
        const tier = state.config.tiers[state.lastTier];
        if (tier) {
            const how = state.tierHow === 'lock' ? '(手动锁定)' : state.tierHow === 'fallback' ? ' <span class="ihf-error">(认不出这个模型,沿用上一次的档位;可在设置文件 tierRules 里加一条)</span>' : '';
            lines.push(`档位:${escapeHtml(tier.label)} · 模型 ${escapeHtml(state.model || '未知')}${how}`);
        }
        if (state.config.enabled === false) lines.push('<span class="ihf-error">插件总开关关着,这一轮什么都不做</span>');
        if (!state.chatId) {
            lines.push('没有打开聊天');
        } else if (!state.view) {
            lines.push(state.loading ? '读记忆中…' : '本场聊天还没对账');
        } else {
            const v = state.view;
            const ai = v.rows.filter(r => !r.isUser);
            const done = ai.filter(r => r.record).length;
            const last = v.rows.at(-1);
            const when = last?.date ? `Day${v.lastDay}(${formatDate(last.date)})` : `Day${v.lastDay}`;
            const vc = vectorCounts();
            const chunks = currentChunks();
            const pc = chunks.filter(ch => !state.memory?.timeline?.[ch.key]).length;
            lines.push(`本场 ${v.rows.length} 层,AI 楼 ${ai.length} 层:已记账 ${done},待补 ${v.pending.length}`);
            lines.push(`向量:${vc.done}/${vc.total}${state.emb.running ? '(后台补算中…)' : ''} · 时间线:${chunks.length - pc}/${chunks.length} 段已压`);
            const nItems = Object.keys(v.items ?? {}).length;
            if (nItems) lines.push(`要紧的东西:${nItems} 件在账上`);
            lines.push(`当前剧情日期:${when}${v.start ? '' : ' <span class="ihf-muted">(还没找到起点日期)</span>'}`);
            lines.push(`上一轮:${escapeHtml(describeRun(state.lastRun))}`);
            lines.push(`<span class="ihf-muted">记忆文件 ${escapeHtml(FILES.mem(state.memId))}</span>`);
        }
        const jd = describeJobs();
        if (jd) lines.push(escapeHtml(jd));
        if (state.emb.error) lines.push(`<span class="ihf-error">补向量失败:${escapeHtml(state.emb.error)}</span>`);
        for (const w of detectLegacy()) lines.push(`<span class="ihf-error">${escapeHtml(w)},建议关掉,免得两套记忆一起发</span>`);
        if (!state.config.siliconflow.key) lines.push('<span class="ihf-error">硅基流动 key 没填,召回只能按专名找</span>');
    }
    if (state.error) lines.push(`<span class="ihf-error">${escapeHtml(state.error)}</span>`);
    el.innerHTML = lines.join('<br>');
    $('#ihf-stop').toggle(!!state.jobs.running);
    renderTimeline();
    renderPeople();
    renderFate();
}

function renderTimeline() {
    const el = document.getElementById('ihf-tl-view');
    if (!el || !$('#ihf-tl-box').prop('open')) return;
    const done = currentChunks().map(ch => state.memory?.timeline?.[ch.key]).filter(Boolean);
    if (!done.length) {
        el.innerHTML = '<span class="ihf-muted">还没有压好的时间线</span>';
        return;
    }
    el.innerHTML = done.map(t => `<div class="ihf-muted">楼 ${t.from} ~ ${t.to}</div>` + t.lines.map(l => `<div>Day${l.day}|${escapeHtml(l.text)}</div>`).join('')).join('');
}

async function saveFateSettings() {
    const num = (id, lo, hi, dft) => Math.max(lo, Math.min(hi, Number($(id).val()) || dft));
    try {
        await saveConfigPatch({
            fate: {
                enabled: $('#ihf-fate-on').prop('checked'),
                world: $('#ihf-fate-world').prop('checked'),
                showActs: $('#ihf-fate-acts').prop('checked'),
                banInnerVoice: $('#ihf-fate-inner').prop('checked'),
                everyFloors: num('#ihf-fate-every', 1, 99, 9),
                surfaceGap: num('#ihf-fate-gap', 1, 99, 12),
                maxNpc: num('#ihf-fate-npc', 1, 8, 4),
            },
        }, ctx().getRequestHeaders());
        state.config = await loadConfig();
        fillSettings();
        render();
        toastr.success('命运设置已保存', TITLE);
    } catch (e) {
        toastr.error('命运设置没存上:' + (e?.message ?? e), TITLE);
    }
}

/** 幕后明细:一人一栏,念头原文只在这儿看得见 */
function renderFate() {
    const el = document.getElementById('ihf-fate-view');
    if (!el || !$('#ihf-fate-box').prop('open')) return;
    const fate = state.memory?.fate;
    const cfg = state.config?.fate;
    if (cfg?.enabled === false) { el.innerHTML = '<span class="ihf-muted">命运模块关着</span>'; return; }
    const list = Object.values(fate?.threads ?? {});
    if (!list.length) {
        el.innerHTML = '<span class="ihf-muted">还没有幕后各栏。等开局好感估出人名,或者直接点「立念头」</span>';
        return;
    }
    const out = [];
    if (fate.pending) {
        out.push(`<div class="ihf-error">正等着浮出:${escapeHtml(fate.pending.what)}(已挂 ${fate.pending.tries} 层)</div>`);
    }
    out.push(`<div class="ihf-muted">上次推演:第 ${fate.lastRunFloor < 0 ? '还没跑过' : fate.lastRunFloor + ' 层'} · 上次浮出:第 ${fate.lastSurfaceFloor < 0 ? '还没有' : fate.lastSurfaceFloor + ' 层'}</div>`);
    for (const t of list) {
        out.push(`<div><b>【${escapeHtml(t.name)}】</b>${t.kind === 'world' ? ' <span class="ihf-muted">世界</span>' : t.kind === 'common' ? ' <span class="ihf-muted">多方交汇</span>' : ''}</div>`);
        if (t.now) out.push(`<div>　当前行动:${escapeHtml(t.now)}</div>`);
        t.ideas?.forEach((it, i) => {
            const tag = it.state !== '进行中' ? `(${it.state})` : '';
            out.push(`<div>　念头${i + 1}${tag}:${escapeHtml(it.text)}</div>`);
            out.push(`<div class="ihf-muted">　　何时会付诸行动:${escapeHtml(it.actWhen || '没写,这条永远不会浮出')}</div>`);
            if (it.acts?.length) out.push(`<div class="ihf-muted">　　在场时会:${escapeHtml(it.acts.join(' / '))}</div>`);
            const tiers = state.config.people.affinityTiers ?? [];
            const steps = limitSteps(it, tiers);
            if (!steps.length) {
                out.push('<div class="ihf-muted">　　界:没写,所以这条的行为清单不发</div>');
            } else {
                const useAff = state.config.people.modules?.affinity !== false;
                const now = currentLimit(it, {
                    affinity: state.view?.people?.[t.name]?.affinity ?? 0,
                    floors: useAff ? 0 : coPresence(state.view?.rows, t.name),
                    tiers, useAffinity: useAff, stepEvery: state.config.fate.stepEveryFloors ?? 15,
                });
                for (const st of steps) {
                    const on = st === now ? ' ← 现在在这一档' : '';
                    out.push(`<div class="ihf-muted">　　界·${escapeHtml(st.tier || '无门槛')}:${escapeHtml(st.text)}${on}</div>`);
                }
                if (!useAff) out.push(`<div class="ihf-muted">　　(好感度关着,这条梯子改按同场层数爬,现在 ${coPresence(state.view?.rows, t.name)} 层,每 ${state.config.fate.stepEveryFloors ?? 15} 层升一档)</div>`);
            }
            if (it.inPublic) out.push(`<div class="ihf-muted">　　有别人在时:${escapeHtml(it.inPublic)}</div>`);
        });
        for (const l of (t.log ?? []).slice(-6)) out.push(`<div class="ihf-muted">　　Day${l.day} ${escapeHtml(l.text)}</div>`);
    }
    const leaks = leakCheck(fate, (ctx().chat ?? []).slice(-2).map(m => m.mes).join('\n'));
    for (const k of leaks) {
        out.push(`<div class="ihf-error">「${escapeHtml(k.name)}」那件还没到时候的事(${escapeHtml(k.actWhen)})好像已经被写进正文了。要不要回退重 roll 你自己看。</div>`);
    }
    el.innerHTML = out.join('');
}

/** 人物明细:好感、性格弧、情绪、约定账。这是道长的那道闸,模型写歪了要在这儿看得见 */
function renderPeople() {
    const el = document.getElementById('ihf-people-view');
    if (!el || !$('#ihf-people-box').prop('open')) return;
    const v = state.view;
    const pcfg = state.config?.people;
    if (!v?.people || !Object.keys(v.people).length) {
        el.innerHTML = '<span class="ihf-muted">还没记到人。模型要在记账块里写"好感/性格/情绪"这几行才会有</span>';
        return;
    }
    const mod = pcfg.modules ?? {};
    const modOn = k => mod[k] !== false;
    const out = [];
    const offList = [['affinity', '好感度'], ['emotion', '情绪'], ['arc', '性格弧'], ['promise', '约定账'], ['item', '物品账']]
        .filter(([k]) => !modOn(k)).map(([, n]) => n);
    if (offList.length) out.push(`<div class="ihf-muted">已关掉:${offList.join('、')}(关着的这几块不记也不发,打开就又都算出来了)</div>`);
    for (const p of Object.values(v.people)) {
        const tier = affinityTierOf(pcfg.affinityTiers, p.affinity);
        out.push(`<div><b>${escapeHtml(p.name)}</b>`
            + (modOn('affinity')
                ? ` <span class="ihf-muted">好感 ${p.affinity}(${escapeHtml(tier?.name ?? '')})</span>`
                  + ` 开局 <input type="number" class="ihf-start text_pole" data-name="${escapeHtml(p.name)}" value="${p.start}" min="-100" max="100" style="width:4.5em">`
                  + (p.startWhy ? ` <span class="ihf-muted">${p.startSource === 'manual' ? '(你改的)' : ''}${escapeHtml(p.startWhy)}</span>` : '')
                : '')
            + '</div>');
        if (p.emotion) {
            out.push(`<div>　情绪:${escapeHtml(p.emotion.kind)},还剩 ${p.emotion.left} 层 <span class="ihf-muted">起因:${escapeHtml(p.emotion.cause)}</span></div>`);
        }
        for (const a of p.arcs) {
            const head = `弧${a.seq} ${escapeHtml(a.from ?? '(缺原句)')} → ${escapeHtml(a.to ?? '?')}`;
            const tail = a.state === '封存'
                ? `已封存,因为${escapeHtml(a.brokenBy)}`
                : a.state === '锚定'
                    ? `已定型${a.breakIf.length ? '' : ' <span class="ihf-error">(还没问破锚条件)</span>'}`
                    : `${a.value}/${pcfg.anchorAt} ${arcStageOf(a.value, pcfg.anchorAt)}`;
            out.push(`<div>　${head} · ${tail}</div>`);
            for (const c of a.breakIf) out.push(`<div class="ihf-muted">　　破锚条件:${escapeHtml(c)}</div>`);
            for (const l of a.log.slice(-4)) out.push(`<div class="ihf-muted">　　Day${l.day} ${l.d > 0 ? '+' : ''}${l.d} ${escapeHtml(l.why)}</div>`);
        }
        for (const l of modOn('affinity') ? p.affinityLog.slice(-4) : []) {
            out.push(`<div class="ihf-muted">　好感 Day${l.day} ${l.d > 0 ? '+' : ''}${l.d}${l.raw !== l.d ? `(模型写了 ${l.raw},卡在上限)` : ''} ${escapeHtml(l.why)}</div>`);
        }
    }
    const open = modOn('promise') ? v.promises.filter(x => x.state === 'open') : [];
    if (open.length) {
        out.push('<div><b>未结的约定</b></div>');
        for (const x of open) out.push(`<div class="ihf-muted">　Day${x.day} ${escapeHtml(x.text)}</div>`);
    }
    const things = modOn('item') ? Object.values(v.items ?? {}) : [];
    if (things.length) {
        out.push('<div><b>要紧的东西</b></div>');
        for (const it of things) {
            const where = it.lost || !it.holder ? '没了' : `在 ${it.holder} 手里`;
            const n = escapeHtml(it.name);
            out.push(`<div>　${n} · ${escapeHtml(where)}`
                + ` <a class="ihf-block" data-which="never" data-word="${n}" title="以后这样东西一律不记">[不记]</a>`
                + ` <a class="ihf-block" data-which="common" data-word="${n}" title="以后只有换了人拿或者丢了毁了才记">[只在出事时记]</a></div>`);
            for (const l of it.log) {
                out.push(`<div class="ihf-muted">　　Day${l.day} ${escapeHtml(l.from || '?')}→${escapeHtml(l.to || '没了')} ${escapeHtml(l.why)}</div>`);
            }
        }
    }
    const st = v.stats ?? {};
    if (st.dropped || st.clamped || st.emotionSkipped) {
        out.push(`<div class="ihf-muted">丢掉 ${st.dropped ?? 0} 条写得不合格的,卡上限 ${st.clamped ?? 0} 条,按冷却跳过情绪 ${st.emotionSkipped ?? 0} 条</div>`);
    }
    // 把拦掉的东西亮出来,好让她照着调 itemNever / itemCommon 两张表
    if (modOn('item') && st.itemsBlocked?.length) {
        const uniq = [...new Set(st.itemsBlocked)];
        out.push(`<div class="ihf-muted">按禁词表拦掉 ${st.itemsBlocked.length} 条物品记录:${escapeHtml(uniq.slice(0, 20).join('、'))}${uniq.length > 20 ? '…' : ''}</div>`);
        out.push('<div class="ihf-muted">拦错了就在下面的「物品禁词表」里把那个词删掉。</div>');
    }
    el.innerHTML = out.join('');
}

/** 设置表单:从 state.config 填进去 */
function fillSettings() {
    const cfg = state.config;
    if (!cfg) return;
    const conns = listConnections();
    const cur = backendOf('sub');
    const $sub = $('#ihf-sub').empty().append('<option value="">(不用副 API)</option>');
    for (const group of [...new Set(conns.map(x => x.group))]) {
        const $g = $('<optgroup>').attr('label', group);
        for (const x of conns.filter(y => y.group === group)) {
            const text = x.blocked ? `${x.name}(不能用:${x.blocked})` : `${x.name}${x.model ? ' · ' + x.model : ''}`;
            $g.append($('<option>').val(x.id).text(text).prop('disabled', !!x.blocked));
        }
        $sub.append($g);
    }
    if (cur && !conns.some(x => x.id === cur)) $sub.append($('<option>').val(cur).text('(之前选的已经找不到了)'));
    $sub.val(cur);
    $('#ihf-enabled').prop('checked', cfg.enabled !== false);
    $('#ihf-tier').val(cfg.tierLock || '');
    $('#ihf-recall-on').prop('checked', !!cfg.recall.enabled);
    $('#ihf-qmode').val(cfg.recall.queryMode);
    $('#ihf-ledger').val(cfg.ledger.mode);
    $('#ihf-bf-backend').val(cfg.jobs.backfillBackend);
    $('#ihf-tl-backend').val(cfg.jobs.timelineBackend);
    $('#ihf-tl-auto').prop('checked', !!cfg.jobs.timelineAuto);
    $('#ihf-rpm').val(cfg.jobs.rpm);
    $('#ihf-emotion').val(cfg.people.emotionMode === 'off' ? 'major' : cfg.people.emotionMode);
    const mod = cfg.people.modules ?? {};
    for (const k of ['affinity', 'emotion', 'arc', 'promise', 'item']) $(`#ihf-mod-${k}`).prop('checked', mod[k] !== false);
    $('#ihf-fate-on').prop('checked', cfg.fate.enabled !== false);
    $('#ihf-fate-world').prop('checked', !!cfg.fate.world);
    $('#ihf-fate-acts').prop('checked', cfg.fate.showActs !== false);
    $('#ihf-fate-inner').prop('checked', !!cfg.fate.banInnerVoice);
    $('#ihf-fate-every').val(cfg.fate.everyFloors);
    $('#ihf-fate-gap').val(cfg.fate.surfaceGap);
    $('#ihf-fate-npc').val(cfg.fate.maxNpc);
    $('#ihf-never').val((cfg.people.itemNever ?? []).join('、'));
    $('#ihf-common').val((cfg.people.itemCommon ?? []).join('、'));
}

async function saveSettings() {
    const patch = {
        enabled: $('#ihf-enabled').prop('checked'),
        tierLock: String($('#ihf-tier').val() || ''),
        recall: { enabled: $('#ihf-recall-on').prop('checked'), queryMode: String($('#ihf-qmode').val()) },
        ledger: { mode: String($('#ihf-ledger').val()) },
        jobs: {
            subProfile: String($('#ihf-sub').val() || ''),
            backfillBackend: String($('#ihf-bf-backend').val()),
            timelineBackend: String($('#ihf-tl-backend').val()),
            timelineAuto: $('#ihf-tl-auto').prop('checked'),
            rpm: Math.max(1, Math.min(60, Number($('#ihf-rpm').val()) || 5)),
        },
        people: {
            emotionMode: String($('#ihf-emotion').val()),
            modules: {
                affinity: $('#ihf-mod-affinity').prop('checked'),
                emotion: $('#ihf-mod-emotion').prop('checked'),
                arc: $('#ihf-mod-arc').prop('checked'),
                promise: $('#ihf-mod-promise').prop('checked'),
                item: $('#ihf-mod-item').prop('checked'),
            },
        },
    };
    if (patch.ledger.mode === 'sub-after' && !patch.jobs.subProfile) {
        toastr.warning('每层记账选了副 API,但还没选是哪个连接配置', TITLE);
        return;
    }
    try {
        await saveConfigPatch(patch, ctx().getRequestHeaders());
        state.config = await loadConfig();
        state.lastTier = null;
        updateTier(false);
        fillSettings();
        toastr.success('设置已保存(存在插件自己的文件里,不进 settings.json)', TITLE);
    } catch (e) {
        toastr.error('设置没存上:' + (e?.message ?? e), TITLE);
    }
}

function mountPanel() {
    const html = `
<div class="ihf-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>无限人类命运 <span class="ihf-muted">v${VERSION}</span><span id="ihf-new" class="ihf-new" hidden>New!</span></b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div id="ihf-status" class="ihf-status"></div>
      <div class="ihf-actions">
        <div id="ihf-reload" class="menu_button">重新对账</div>
        <div id="ihf-backfill" class="menu_button">补记账</div>
        <div id="ihf-timeline" class="menu_button">压时间线</div>
        <div id="ihf-stop" class="menu_button" style="display:none">停止</div>
      </div>
      <details class="ihf-box">
        <summary>设置</summary>
        <div class="ihf-form">
          <label><input type="checkbox" id="ihf-enabled"> <b>开启插件</b>(关掉就完全不插手,发给模型的东西一个字都不改)</label>
          <label>档位 <select id="ihf-tier" class="text_pole"><option value="">跟着模型自动</option><option value="big">锁定大模型档</option><option value="small">锁定小模型档</option></select></label>
          <label><input type="checkbox" id="ihf-recall-on"> 开启召回</label>
          <label>召回查询 <select id="ihf-qmode" class="text_pole"><option value="split">分开用(推荐)</option><option value="concat">拼在一起</option></select></label>
          <label>每层记账 <select id="ihf-ledger" class="text_pole"><option value="main-inline">主 API 随正文写</option><option value="sub-after">副 API 回复后补写</option><option value="off">不记</option></select></label>
          <label>副 API <select id="ihf-sub" class="text_pole"></select></label>
          <div class="ihf-muted">副 API 从 API 管理器或酒馆的连接配置里选,请求经酒馆服务器发出,用酒馆密钥库里的 key,插件不存 key。</div>
          <label>补记账用 <select id="ihf-bf-backend" class="text_pole"><option value="main">主 API</option><option value="sub">副 API</option></select></label>
          <label>压时间线用 <select id="ihf-tl-backend" class="text_pole"><option value="main">主 API</option><option value="sub">副 API</option></select></label>
          <label><input type="checkbox" id="ihf-tl-auto"> 压时间线用副 API 时,自动压</label>
          <label>每分钟最多 <input type="number" id="ihf-rpm" class="text_pole" min="1" max="60"> 次</label>
          <div class="ihf-muted">人类模块,四块各管各的。角色卡自带好感度的话就把好感度那块关掉,免得两套打架。</div>
          <label><input type="checkbox" id="ihf-mod-affinity"> 好感度</label>
          <label><input type="checkbox" id="ihf-mod-emotion"> 情绪</label>
          <label>情绪档 <select id="ihf-emotion" class="text_pole"><option value="major">只在重大事件后(推荐)</option><option value="all">全开(模拟真实世界)</option></select></label>
          <label><input type="checkbox" id="ihf-mod-arc"> 性格弧</label>
          <label><input type="checkbox" id="ihf-mod-promise"> 约定账</label>
          <label><input type="checkbox" id="ihf-mod-item"> 物品账</label>
          <div id="ihf-save" class="menu_button">保存设置</div>
          <div class="ihf-muted">设置存在 user/files/infinite-human-fate.config.json,不进 settings.json;你手填的 key 不会被改动。</div>
        </div>
      </details>
      <details class="ihf-box" id="ihf-tl-box">
        <summary>时间线</summary>
        <div id="ihf-tl-view" class="ihf-status"></div>
      </details>
      <details class="ihf-box" id="ihf-fate-box">
        <summary>幕后(命运)</summary>
        <div id="ihf-fate-view" class="ihf-status"></div>
        <div class="ihf-actions">
          <div id="ihf-fate-ideas" class="menu_button">立念头</div>
          <div id="ihf-fate-survey" class="menu_button">跑一次推演</div>
        </div>
        <div class="ihf-form">
          <label><input type="checkbox" id="ihf-fate-on"> 开启命运模块</label>
          <label><input type="checkbox" id="ihf-fate-world"> 单开一栏「世界」记背景板大事</label>
          <label><input type="checkbox" id="ihf-fate-acts"> 在场的人发行为清单(演过头就关掉)</label>
          <label><input type="checkbox" id="ihf-fate-inner"> 行为清单里加一条「不写心理活动」</label>
          <label>每隔 <input type="number" id="ihf-fate-every" class="text_pole" min="1" max="99"> 层推演一次</label>
          <label>两次浮出至少隔 <input type="number" id="ihf-fate-gap" class="text_pole" min="1" max="99"> 层</label>
          <label>最多给 <input type="number" id="ihf-fate-npc" class="text_pole" min="1" max="8"> 个人开栏</label>
          <div id="ihf-fate-save" class="menu_button">保存命运设置</div>
          <div class="ihf-muted">念头原文只存在这里,永远不发给模型。发出去的只有「在场时会」和「界」。</div>
        </div>
      </details>
      <details class="ihf-box" id="ihf-people-box">
        <summary>人物(好感 / 性格弧 / 情绪 / 约定)</summary>
        <div id="ihf-people-view" class="ihf-status"></div>
        <div class="ihf-actions">
          <div id="ihf-affinit" class="menu_button">估开局好感</div>
          <div id="ihf-origins" class="menu_button">摘性格原句</div>
          <div id="ihf-breakif" class="menu_button">问破锚条件</div>
        </div>
        <div class="ihf-muted">数都是插件按各层的加减现算的,不存死值。改了楼、滑了 swipe,重新对账就跟着变。</div>
        <details class="ihf-box">
          <summary>物品禁词表</summary>
          <div class="ihf-form">
            <label>一律不记(吃的喝的抽的)
              <textarea id="ihf-never" class="text_pole" rows="4" placeholder="一行一个,或者用逗号隔开"></textarea>
            </label>
            <div class="ihf-muted">两个字以上的词,名字里带上就算;一个字的词,要去掉量词后正好是它才算(不然"水"会把"墨水""水晶吊坠"也拦掉)。</div>
            <label>只在换了人拿、或者丢了毁了时才记(手机钱包这类随身物)
              <textarea id="ihf-common" class="text_pole" rows="4" placeholder="一行一个,或者用逗号隔开"></textarea>
            </label>
            <div id="ihf-save-items" class="menu_button">保存禁词表</div>
            <div class="ihf-muted">上面表格里每样东西后面也有 [不记] [只在出事时记],点一下就加进来。改完立刻重算,不用重开聊天。</div>
          </div>
        </details>
      </details>
    </div>
  </div>
</div>`;
    $('#extensions_settings2').append(html);
    $('#ihf-reload').on('click', () => openChat());
    $('#ihf-backfill').on('click', () => startBackfill());
    $('#ihf-timeline').on('click', () => startTimeline());
    $('#ihf-stop').on('click', () => { state.jobs.stop = true; render(); });
    $('#ihf-save').on('click', () => saveSettings());
    $('#ihf-tl-box').on('toggle', () => renderTimeline());
    $('#ihf-people-box').on('toggle', () => renderPeople());
    $('#ihf-fate-box').on('toggle', () => renderFate());
    $('#ihf-fate-ideas').on('click', () => startFateIdeas());
    $('#ihf-fate-survey').on('click', () => startFateSurvey());
    $('#ihf-fate-save').on('click', () => saveFateSettings());
    $('#ihf-affinit').on('click', () => startAffinityInit());
    $('#ihf-save-items').on('click', () => saveItemLists({
        itemNever: parseWordList($('#ihf-never').val()),
        itemCommon: parseWordList($('#ihf-common').val()),
    }));
    $(document).on('click', '.ihf-block', function () { addItemWord($(this).data('which'), String($(this).data('word'))); });
    $('#ihf-origins').on('click', () => startOrigins());
    $(document).on('change', '.ihf-start', function () { setAffinityStart($(this).data('name'), $(this).val()); });
    $('#ihf-breakif').on('click', () => startBreakIf());
}

jQuery(async () => {
    console.info(LOG, `v${VERSION} 已加载`);
    mountPanel();
    try {
        state.config = await loadConfig();
    } catch (e) {
        setError('读设置文件失败,插件暂不工作', e);
        return;
    }
    updateTier(false);
    fillSettings();
    const { eventSource, eventTypes: et } = ctx();
    eventSource.on(et.CHAT_CHANGED, () => openChat());
    for (const ev of [et.MESSAGE_RECEIVED, et.MESSAGE_EDITED, et.MESSAGE_SWIPED, et.MESSAGE_DELETED, et.MESSAGE_UPDATED]) {
        eventSource.on(ev, () => refresh());
    }
    eventSource.on(et.GENERATION_STARTED, (_type, _opts, dryRun) => { if (!dryRun) state.generating = true; });
    eventSource.on(et.GENERATION_STOPPED, () => { state.generating = false; });
    // 流式输出结束后正文才定稿,v5.6 踩过"只绑聊天加载就冻结"的坑,这里多绑一道;定稿后再跑自动的活
    eventSource.on(et.GENERATION_ENDED, () => {
        state.generating = false;
        setTimeout(() => { refresh(); autoJobs(); }, 300);
    });
    // 查更新要等服务端 git fetch 一趟,别跟开屏抢路,歇一会儿再问
    setTimeout(checkUpdate, 8000);
    eventSource.on(et.CHATCOMPLETION_MODEL_CHANGED, () => updateTier(true));
    eventSource.on(et.MAIN_API_CHANGED, () => updateTier(true));
    await openChat();
});
