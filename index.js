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
import { mountShell } from './ui.js';
import { COMMON, WORLD, buildActsPrompt, buildNowPrompt, buildSurfacePrompt, canSurface, canSurfaceNow, coPresence, currentLimit, emptyFate, emptyThread, leakCheck, limitSteps, makePending, needsSurvey, pushLog, settlePending } from './core/fate.js';
import { embed, rerank, listModels, probeRelay, relayAvailable, endpointReady, effectiveRerank, setHeaders } from './vector.js';
import { hideInstruction, captureProfile, buildLockExtractMessages, parseLockExtract, buildLockPrompt } from './core/locks.js';
import { FILES, loadConfig, loadIndex, mergeMemory, newMemId, readJson, saveConfigPatch, writeJson } from './store.js';

/** 跟 manifest.json 的 version 和 ?v= 手动保持一致。
 *  酒馆加载扩展脚本的网址本身不带版本号,Cloudflare 会喂旧副本,靠这行在控制台辨认在跑哪一版。 */
const VERSION = '0.9.1';
const LOG = '[无限人类命运]';
const TITLE = '无限人类命运';

/** setExtensionPrompt 的键 */
const KEY_LEDGER = 'ihf_ledger';
const KEY_MEMORY = 'ihf_memory';
/** 已定型的性格 + 当前情绪,挂 injectDepth(默认倒数第 1 条,紧挨用户末句之前) */
const KEY_ANCHOR = 'ihf_anchor';
/** 聊天还短、没有记忆块的时候,人物现状单独发 */
const KEY_STATUS = 'ihf_status';
/** 随机角色锁定:已固定的角色档案 */
const KEY_LOCKS = 'ihf_locks';
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
    /** 查到有新版 */
    hasUpdate: false,
};

/** 界面外壳(悬浮球 + 面板),mountPanel() 里建起来 */
let ui = null;

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
    // 总开关关着:不读不建记忆文件、不往上下文挂任何东西(道长 9/17:关掉之后任何功能都不再介入酒馆)
    if (state.config?.enabled === false) {
        clearPrompts();
        return render();
    }
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

/** 把插件挂过的注入全撤掉。总开关一关就调,不等下一轮生成 */
function clearPrompts() {
    const c = ctx();
    for (const key of [KEY_LEDGER, KEY_MEMORY, KEY_ANCHOR, KEY_STATUS, KEY_LOCKS]) c.setExtensionPrompt(key, '', IN_CHAT, 0);
}

/** 对账。有新记录就排队存盘,并把缺的向量补上 */
function refresh(forceSave = false) {
    const c = ctx();
    if (state.config?.enabled === false) return;
    if (!state.memory || c.getCurrentChatId() !== state.chatId) return;
    state.view = reconcile(state.memory, c.chat, state.config.people);
    if (state.view.added || (forceSave && !state.memory.updated)) scheduleSave();
    settleFate();
    scanLockTags();
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
    const model = state.config?.vector.embed.model;
    const recs = Object.values(state.memory?.floors ?? {}).filter(r => r.summary);
    return { total: recs.length, done: recs.filter(r => vecFresh(r, model)).length };
}

/** 后台补向量:一批一批算,算好就存进记忆文件。不拖生成,生成时只用已经算好的 */
async function ensureVectors() {
    const cfg = state.config;
    // 总开关关着就什么都不做(道长:关掉之后任何功能都不再介入酒馆)
    if (state.emb.running || !state.memory || cfg?.enabled === false || !cfg?.recall.enabled || !endpointReady(cfg.vector.embed)) return;
    const memId = state.memId;
    const model = cfg.vector.embed.model;
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
            const vecs = await embed(part.map(docText), cfg.vector);
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
            list.push({
                id: `st:${p.id}`, name: p.name, group: '酒馆的连接配置', model: p.model || '', blocked: '',
                url: p['api-url'] || '', secretId: p['secret-id'] || '', source: p.source || '', api: p.api || '',
            });
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
    // 面板上给这条连接单独选过模型就用选的,没选就用连接自己带的
    const model = String(state.config.jobs.subModels?.[backend] ?? '').trim() || conn.model;
    let res;
    if (backend.startsWith('st:')) {
        // 预设和指令格式都不带:记账、压时间线不该扛整套预设(状态栏、思维链那些),白烧 token
        res = await c.ConnectionManagerRequestService.sendRequest(backend.slice(3), messages, maxTokens, { stream: false, extractData: true, includePreset: false, includeInstruct: false }, model ? { model } : {});
    } else {
        res = await c.ChatCompletionService.processRequest({
            stream: false,
            messages,
            max_tokens: maxTokens,
            model,
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
    // 总开关关着就一个后台活都不跑(道长:关掉之后任何功能都不再介入酒馆)
    if (!cfg || cfg.enabled === false || !state.view || state.jobs.running || state.generating || !cfg.jobs.subProfile) return;
    if (cfg.ledger.mode === 'sub-after') {
        const lastAi = [...state.view.rows].reverse().find(r => !r.isUser && !r.hidden);
        if (lastAi && !lastAi.record) {
            startBackfill([lastAi.index], 'sub');
            return;
        }
    }
    // 几百层的老聊天一次补不完:每轮生成后从最早的往后补几层旧账,分批慢慢补完
    // (道长:必须从第 0 层往现在补,倒着补时间线会乱)
    const nAuto = Math.max(0, Math.floor(Number(cfg.jobs.backfillAuto) || 0));
    if (nAuto && cfg.jobs.backfillBackend === 'sub' && state.view.pending.length) {
        return startBackfill(state.view.pending.slice(0, nAuto), 'sub');
    }
    // 随机角色还没录到档案的,让副 API 看看最新这层有没有出场(每层只问一次)
    if (lockPendingCount()) return startLockExtract('sub');
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

    const vec = cfg.vector;
    const embedOk = endpointReady(vec.embed);
    let maps = [];
    if (embedOk) {
        try {
            const qvecs = (await embed(qs.pool, vec, 8000)).map(normalize);
            maps = cosineMaps(qvecs, cands, vec.embed.model);
            const n = maps[0]?.size ?? 0;
            if (n < cands.length) notes.push(`向量还没补完 ${n}/${cands.length}`);
        } catch (e) {
            notes.push('向量失败,只按专名找');
            console.warn(LOG, e);
        }
    } else {
        notes.push('嵌入站没填,只按专名找');
    }

    const cos = bestCosine(maps);
    const pool = pickPool(cands, maps, qs.rank, rc);
    const rr = new Map();
    if (embedOk && endpointReady(effectiveRerank(vec)) && pool.length) {
        try {
            const res = await rerank(qs.rank, pool.map(r => docText(r.record)), vec, 8000);
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
        c.setExtensionPrompt(KEY_LOCKS, '', IN_CHAT, 0);
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
        // 已固定的随机角色档案(那条随机生成指令在 CHAT_COMPLETION_PROMPT_READY 里被藏掉,由这块顶上)
        c.setExtensionPrompt(KEY_LOCKS, buildLockPrompt(lockArchives()), IN_CHAT, depth, false, ROLE_SYSTEM);

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
        $('#ihf-new').prop('hidden', false);
        state.hasUpdate = true;
        render();
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
        if (state.hasUpdate) lines.push('<span class="ihf-error">有新版可以更新:去「织梦者 → 我的插件」,或者酒馆自己的扩展管理里点更新</span>');
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
        if (!endpointReady(state.config.vector.embed)) lines.push('<span class="ihf-error">嵌入站还没填(⚙️ 设置里的「向量召回」),召回只能按专名找</span>');
        else if (state.config.recall.enabled) lines.push(`<span class="ihf-muted">向量请求${relayAvailable() && state.config.vector.via !== 'direct' ? '经酒馆服务器转发' : '由浏览器直连'}</span>`);
    }
    if (state.error) lines.push(`<span class="ihf-error">${escapeHtml(state.error)}</span>`);
    el.innerHTML = lines.join('<br>');
    $('#ihf-stop').toggle(!!state.jobs.running);
    renderTable();
    renderTimeline();
    renderPeople();
    renderLocks();
    renderFateChart();
    renderFate();
    // 球上转圈 = 后台在跑活;小黄点 = 有事要她看一眼
    ui?.setBusy(state.jobs.running || state.emb.running);
    ui?.setWarn(Boolean(state.error || state.emb.error || state.memory?.fate?.pending || detectLegacy().length));
}

function renderTimeline() {
    const el = document.getElementById('ihf-tl-view');
    if (!el || ui?.current !== 'wuxian') return;
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
    if (!el || ui?.current !== 'mingyun') return;
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
    if (!el || ui?.current !== 'renlei') return;
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
    // 一人一张卡,左右切换(道长:可以左右滑动切换看各个 NPC)
    const people = Object.values(v.people);
    state.peopleIdx = ((state.peopleIdx ?? 0) % people.length + people.length) % people.length;
    const p = people[state.peopleIdx];
    const tier = affinityTierOf(pcfg.affinityTiers, p.affinity);
    const pct = Math.round((Math.max(-100, Math.min(100, p.affinity)) + 100) / 2);
    out.push(`<div class="ihf-carousel">
        <button class="ihf-icon-btn ihf-prev" title="上一个">◀</button>
        <div class="ihf-person">
          <div class="ihf-person-head"><b>${escapeHtml(p.name)}</b> <span class="ihf-muted">${state.peopleIdx + 1} / ${people.length}</span></div>
          ${modOn('affinity') ? `
          <div class="ihf-aff"><span class="ihf-affnum">${p.affinity}</span><span class="ihf-afftier">${escapeHtml(tier?.name ?? '')}</span></div>
          <div class="ihf-bar ihf-affbar" title="-100 到 100"><div class="ihf-barfill" style="width:${pct}%"></div><div class="ihf-barmid"></div></div>
          <div class="ihf-muted">${escapeHtml(tier?.text ?? '')}</div>
          <div class="ihf-muted">开局 <input type="number" class="ihf-start" data-name="${escapeHtml(p.name)}" value="${p.start}" min="-100" max="100" style="width:4.5em">${p.startWhy ? ` ${p.startSource === 'manual' ? '(你改的)' : ''}${escapeHtml(p.startWhy)}` : ''}</div>` : ''}
          ${p.emotion ? `<div>情绪:<b>${escapeHtml(p.emotion.kind)}</b>,还剩 ${p.emotion.left} 层 <span class="ihf-muted">起因:${escapeHtml(p.emotion.cause)}</span></div>` : (modOn('emotion') ? '<div class="ihf-muted">情绪:平静</div>' : '')}
        </div>
        <button class="ihf-icon-btn ihf-next" title="下一个">▶</button>
      </div>`);
    out.push(`<div class="ihf-dots">${people.map((x, i) => `<span class="ihf-dot${i === state.peopleIdx ? ' ihf-on' : ''}" data-idx="${i}" title="${escapeHtml(x.name)}"></span>`).join('')}</div>`);
    for (const a of p.arcs) {
        const head = `弧${a.seq} ${escapeHtml(a.from ?? '(缺原句)')} → ${escapeHtml(a.to ?? '?')}`;
        const tail = a.state === '封存'
            ? `已封存,因为${escapeHtml(a.brokenBy)}`
            : a.state === '锚定'
                ? `已定型${a.breakIf.length ? '' : ' <span class="ihf-error">(还没问什么事会改性格)</span>'}`
                : `${a.value}/${pcfg.anchorAt} ${arcStageOf(a.value, pcfg.anchorAt)}`;
        out.push(`<div>　${head} · ${tail}</div>`);
        if (a.state !== '封存' && a.state !== '锚定') out.push(`<div class="ihf-bar ihf-arcbar"><div class="ihf-barfill" style="width:${Math.round(Math.max(0, Math.min(1, a.value / pcfg.anchorAt)) * 100)}%"></div></div>`);
        for (const c of a.breakIf) out.push(`<div class="ihf-muted">　　会让它再变的事:${escapeHtml(c)}</div>`);
        for (const l of a.log.slice(-4)) out.push(`<div class="ihf-muted">　　Day${l.day} ${l.d > 0 ? '+' : ''}${l.d} ${escapeHtml(l.why)}</div>`);
    }
    const affLog = modOn('affinity') ? p.affinityLog.slice(-6) : [];
    if (affLog.length) out.push('<div><b>好感怎么变的</b></div>');
    for (const l of affLog) {
        out.push(`<div class="ihf-muted">　Day${l.day} ${l.d > 0 ? '+' : ''}${l.d}${l.raw !== l.d ? `(模型写了 ${l.raw},卡在上限)` : ''} ${escapeHtml(l.why)}</div>`);
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
/** 面板上嵌入 / 重排那一组现在填的是什么。models 不从表单读,拉取时单独存 */
function readEndpointForm(k) {
    return {
        url: String($(`#ihf-${k}-url`).val() ?? '').trim().replace(/\/+$/, ''),
        key: String($(`#ihf-${k}-key`).val() ?? '').trim(),
        model: String($(`#ihf-${k}-model`).val() ?? '').trim(),
    };
}

/** 模型下拉:datalist 既能从拉回来的列表里挑,也能手填(有的站不给列表) */
function fillModelList(k, models, current) {
    const list = [...new Set([...(models ?? []), current].filter(Boolean))];
    $(`#ihf-${k}-models`).html(list.map(m => `<option value="${escapeHtml(m)}">`).join(''));
    $(`#ihf-${k}-count`).text(models?.length ? `列表里有 ${models.length} 个,也可以直接手填` : '还没拉过列表,可以直接手填模型名');
}

function renderRelayState() {
    const via = String($('#ihf-via').val() || state.config?.vector.via || 'auto');
    const ok = relayAvailable();
    let text;
    if (via === 'direct') text = '浏览器直连。公益站别走这条,会被封;硅基流动这类官方站可以。';
    else if (ok) text = '服务端转发插件在,向量请求经酒馆服务器发出,公益站看到的是酒馆。';
    else if (via === 'server') text = '<span class="ihf-error">锁定了转发,但探不到服务端插件,向量请求会全部失败。装法见 ❓ 帮助。</span>';
    else text = '<span class="ihf-error">没探到服务端转发插件,现在是浏览器直连。用公益站的嵌入接口请先装转发插件(装法见 ❓ 帮助)。</span>';
    $('#ihf-relay-state').html(text);
}

/** 「拉取模型」:用表单里现填的地址和 key 去问 /models,拉到就存进设置文件,下次打开还在 */
async function onFetchModels(k) {
    const ep = readEndpointForm(k);
    if (!ep.url) return toastr.warning('先填地址', TITLE);
    const $btn = $(`#ihf-${k}-fetch`).prop('disabled', true).text('拉取中…');
    try {
        const models = await listModels(ep, String($('#ihf-via').val() || 'auto'));
        if (!models.length) {
            toastr.info('对面没返回任何模型。有的站不给列表,自己在模型框里手填一个就行', TITLE);
            return;
        }
        fillModelList(k, models, ep.model);
        if (!ep.model || !models.includes(ep.model)) {
            // 嵌入站优先挑 bge-m3 这类明显是嵌入的;挑不出就第一个
            const guess = models.find(m => /bge|embed|e5|minilm|rerank/i.test(m) && (k === 'rerank') === /rerank/i.test(m)) ?? models[0];
            $(`#ihf-${k}-model`).val(guess);
        }
        await saveConfigPatch({ vector: { [k]: { models } } }, ctx().getRequestHeaders());
        state.config.vector[k].models = models;
        toastr.success(`拉到 ${models.length} 个模型,列表已存`, TITLE);
    } catch (e) {
        toastr.error('拉不到模型列表:' + (e?.message ?? e) + '。有的站本来就不给列表,那就手填模型名', TITLE);
    } finally {
        $btn.prop('disabled', false).text('拉取模型');
    }
}

/** 副 API 那一行的模型框:按当前选的连接填 */
function fillSubModel(connId) {
    const cfg = state.config;
    const id = String(connId || '');
    const cur = id ? String(cfg?.jobs.subModels?.[id] ?? '') : '';
    $('#ihf-sub-model').val(cur).prop('disabled', !id);
    fillModelList('sub', id ? (cfg?.jobs.subModelLists?.[id] ?? []) : [], cur);
    if (!id) $('#ihf-sub-count').text('先在上面选一条副 API');
}

/** 副 API 的「拉取模型」:走酒馆自己的 /status 接口,key 用酒馆密钥库里的,插件不碰 */
async function onFetchSubModels() {
    const id = String($('#ihf-sub').val() || '');
    const conn = listConnections().find(x => x.id === id);
    if (!conn) return toastr.warning('先选一条副 API', TITLE);
    if (conn.blocked) return toastr.warning(conn.blocked, TITLE);
    if (conn.api && conn.api !== 'openai') return toastr.info('这条不是聊天补全类的连接,拉不了模型列表,手填就行', TITLE);
    const $btn = $('#ihf-sub-fetch').prop('disabled', true).text('拉取中…');
    try {
        const res = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            cache: 'no-cache',
            body: JSON.stringify({ chat_completion_source: conn.source || 'custom', custom_url: conn.url, secret_id: conn.secretId }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data?.error) throw new Error(typeof data.error === 'string' ? data.error : '对面返回了一个错误');
        const models = [...new Set((Array.isArray(data?.data) ? data.data : []).map(m => String(m?.id ?? m ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
        if (!models.length) return toastr.info('对面没返回任何模型。有的站不给列表,自己手填模型名就行', TITLE);
        fillModelList('sub', models, String($('#ihf-sub-model').val() ?? ''));
        await saveConfigPatch({ jobs: { subModelLists: { [id]: models } } }, ctx().getRequestHeaders());
        state.config.jobs.subModelLists = { ...(state.config.jobs.subModelLists ?? {}), [id]: models };
        toastr.success(`拉到 ${models.length} 个模型,列表已存。选一个再点保存`, TITLE);
    } catch (e) {
        toastr.error('拉不到模型列表:' + (e?.message ?? e) + '。有的站本来就不给列表,手填模型名即可', TITLE);
    } finally {
        $btn.prop('disabled', false).text('拉取模型');
    }
}

/* ---------------- 记忆导出 / 导入 ---------------- */

function exportMemory() {
    if (!state.memory || !state.chatId) return toastr.info('先打开一场聊天', TITLE);
    const payload = { format: 'ihf-export', version: 1, chatId: state.chatId, exportedAt: Date.now(), memory: state.memory };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${String(state.chatId).replace(/[\\/:*?"<>|]+/g, '_')}.ihf-memory.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** 导入:和现有记忆按楼指纹合并(同一楼留较新的),不是覆盖。指纹对不上的楼进来也没用,不会被发 */
async function importMemory(file) {
    if (!file) return;
    if (!state.memory || !state.chatId) return toastr.info('先打开一场聊天再导入', TITLE);
    try {
        const data = JSON.parse(await file.text());
        const mem = data?.format === 'ihf-export' ? data.memory : data;
        if (!mem || typeof mem !== 'object' || !mem.floors || typeof mem.floors !== 'object') throw new Error('这不是无限人类命运导出的记忆文件');
        const before = Object.keys(state.memory.floors).length;
        state.memory = mergeMemory(normalizeTimeline(mem), state.memory);
        if (!state.memory.calendar?.start && mem.calendar?.start) state.memory.calendar = mem.calendar;
        const after = Object.keys(state.memory.floors).length;
        scheduleSave();
        refresh(true);
        toastr.success(`已合并:楼层记录 ${before} → ${after}${data?.chatId && data.chatId !== state.chatId ? '(来自另一场聊天:' + data.chatId + ')' : ''}`, TITLE);
    } catch (e) {
        toastr.error('导入失败:' + (e?.message ?? e), TITLE);
    }
}

/* ---------------- 随机角色锁定 ---------------- */

/** 规则跟着卡走,按卡的头像文件名分;群聊按群 id */
function lockKey() {
    const c = ctx();
    if (c.groupId) return `group:${c.groupId}`;
    const av = c.characters?.[c.characterId]?.avatar;
    return av ? `char:${av}` : '';
}

function lockRules() {
    const k = lockKey();
    const all = state.config?.locks?.rules ?? {};
    return k && Array.isArray(all[k]) ? all[k] : [];
}

function lockArchives() {
    return state.memory?.locks ?? {};
}

async function saveLockRules(rules) {
    const k = lockKey();
    if (!k) return toastr.warning('先打开一张卡', TITLE);
    await saveConfigPatch({ locks: { rules: { [k]: rules } } }, ctx().getRequestHeaders());
    state.config.locks = state.config.locks ?? { rules: {} };
    state.config.locks.rules = { ...(state.config.locks.rules ?? {}), [k]: rules };
}

/** 不花钱的那条路:卡要求模型输出 <标签>…</标签> 的,直接从各层正文里抓,抓到第一次出场的那份 */
function scanLockTags() {
    if (!state.memory || state.config?.enabled === false) return;
    const rules = lockRules().filter(r => r.tag && !lockArchives()[r.label]?.profile);
    if (!rules.length) return;
    const chat = ctx().chat ?? [];
    for (const r of rules) {
        // 点过「重新摇」的,只看那之后的楼
        const after = Number(lockArchives()[r.label]?.after ?? -1);
        for (let i = after + 1; i < chat.length; i++) {
            const m = chat[i];
            if (m.is_user || m.is_system) continue;
            const profile = captureProfile(m.mes, r.tag);
            if (profile) {
                setLockArchive(r.label, profile, i, 'tag');
                break;
            }
        }
    }
}

function setLockArchive(label, profile, floor, source) {
    state.memory.locks = state.memory.locks ?? {};
    state.memory.locks[label] = { profile, floor, source, at: Date.now() };
    scheduleSave();
    console.info(LOG, `随机角色「${label}」已固定:${profile}`);
    toastr.success(`「${label}」已固定:${profile}`, TITLE);
}

/** 花钱的那条路:没标签可抓的,让副 API 从最新那层正文里提取。每层只问一次 */
async function startLockExtract(which = null) {
    if (!state.memory || !state.view) return;
    const backend = backendOf(which ?? 'sub');
    if (!backend) return;
    const lastAi = [...state.view.rows].reverse().find(r => !r.isUser && !r.hidden);
    if (!lastAi) return;
    const todo = lockRules().filter(r => !lockArchives()[r.label]?.profile && lastAi.index > Number(lockArchives()[r.label]?.after ?? -1) && (state.memory.lockChecked?.[r.label] !== lastAi.fp));
    if (!todo.length) return;
    const raw = ctx().chat;
    await runJob('锁定随机角色', todo, async r => {
        state.memory.lockChecked = state.memory.lockChecked ?? {};
        state.memory.lockChecked[r.label] = lastAi.fp;
        const out = await callModel(buildLockExtractMessages({ label: r.label, hint: r.hint ?? '', text: extractNarrative(raw[lastAi.index]?.mes) }), backend);
        const profile = parseLockExtract(out);
        if (profile) setLockArchive(r.label, profile, lastAi.index, 'extract');
        scheduleSave();
    });
}

function lockPendingCount() {
    if (!state.view) return 0;
    const lastAi = [...state.view.rows].reverse().find(r => !r.isUser && !r.hidden);
    if (!lastAi) return 0;
    return lockRules().filter(r => !lockArchives()[r.label]?.profile && lastAi.index > Number(lockArchives()[r.label]?.after ?? -1) && state.memory?.lockChecked?.[r.label] !== lastAi.fp).length;
}

function renderLocks() {
    const el = document.getElementById('ihf-lock-view');
    if (!el || ui?.current !== 'renlei') return;
    const rules = lockRules();
    if (!lockKey()) { el.innerHTML = '<span class="ihf-muted">先打开一张卡</span>'; return; }
    if (!rules.length) { el.innerHTML = '<span class="ihf-muted">这张卡还没加锁定规则</span>'; return; }
    const arch = lockArchives();
    const hits = state.lockHits;
    const out = rules.map((r, i) => {
        const a = arch[r.label];
        const status = a?.profile
            ? `<div>已固定(第 ${a.floor} 层,${a.source === 'tag' ? '按标签抓的' : a.source === 'manual' ? '你手改的' : '副 API 提取的'}):</div>
               <label style="flex-direction:column;align-items:stretch"><input type="text" class="ihf-lock-profile text_pole" data-idx="${i}" value="${escapeHtml(a.profile)}" title="可以直接改,改完回车"></label>
               <div class="ihf-acts"><button class="ihf-btn ihf-lock-reroll" data-idx="${i}" title="清掉档案,让那条随机指令重新放行,下一次出场重新摇">重新摇</button><button class="ihf-btn ihf-lock-del" data-idx="${i}">删掉规则</button></div>`
            : `<div class="ihf-muted">还没出场。${r.tag ? `等模型写出 &lt;${escapeHtml(r.tag)}&gt; 就自动录` : (state.config.jobs.subProfile ? '每层回复后让副 API 看一眼有没有出场' : '<span class="ihf-error">没标签也没选副 API,录不了;去设置里选一条副 API</span>')}</div>
               <div class="ihf-acts"><button class="ihf-btn ihf-lock-del" data-idx="${i}">删掉规则</button></div>`;
        return `<div class="ihf-person" style="margin-bottom:6px"><div><b>${escapeHtml(r.label)}</b> <span class="ihf-muted">指令里的一句:「${escapeHtml(r.match)}」${r.tag ? ' · 档案标签 ' + escapeHtml(r.tag) : ''}</span></div>${status}</div>`;
    });
    // 生成过一轮才有数;刚录完档案还没生成时不报"0 处",免得误报
    if (Object.values(arch).some(a => a?.profile) && Number.isFinite(hits)) out.push(`<div class="ihf-muted">上一轮从上下文里藏掉了 ${hits} 处随机指令${hits ? '' : ' <span class="ihf-error">(0 处:填的那句在发出去的上下文里找不到,检查是不是照抄的)</span>'}</div>`);
    el.innerHTML = out.join('');
}

async function addLockRule() {
    const label = String($('#ihf-lock-label').val() ?? '').trim();
    const match = String($('#ihf-lock-match').val() ?? '').trim();
    const tag = String($('#ihf-lock-tag').val() ?? '').trim().replace(/^<|>$/g, '');
    if (!label || !match) return toastr.warning('「叫什么」和「指令里的一句」都要填', TITLE);
    if (match.length < 6) return toastr.warning('那一句太短了,容易误伤别的段落,照抄长一点', TITLE);
    const rules = lockRules().filter(r => r.label !== label);
    rules.push({ label, match, tag });
    try {
        await saveLockRules(rules);
        $('#ihf-lock-label, #ihf-lock-match, #ihf-lock-tag').val('');
        scanLockTags();
        renderLocks();
        toastr.success(`已加「${label}」的锁定规则`, TITLE);
    } catch (e) {
        toastr.error('没存上:' + (e?.message ?? e), TITLE);
    }
}

/* ---------------- 三个给玩家看的面板 ---------------- */

/** ♾️ 全景表:从开局到现在每一层记了什么 */
function renderTable() {
    const el = document.getElementById('ihf-table-view');
    if (!el || ui?.current !== 'wuxian') return;
    const rows = (state.view?.rows ?? []).filter(r => !r.isUser && r.record?.summary);
    if (!rows.length) { el.innerHTML = '<span class="ihf-muted">还没有记账的楼。模型每回复一层就会多一行</span>'; return; }
    const cells = rows.map(r => {
        const rec = r.record;
        const when = `Day${r.day}${r.date ? '<br><span class="ihf-muted">' + escapeHtml(formatDate(r.date)) + '</span>' : ''}`;
        return `<tr${r.hidden ? ' class="ihf-dim"' : ''}><td>${r.index}</td><td>${when}</td><td>${escapeHtml(rec.place || '')}${rec.timeOfDay ? '<br><span class="ihf-muted">' + escapeHtml(rec.timeOfDay) + '</span>' : ''}</td><td>${escapeHtml(rec.summary)}</td><td>${escapeHtml((rec.names ?? []).join('、'))}</td></tr>`;
    });
    el.innerHTML = `<div class="ihf-scroll"><table class="ihf-table"><thead><tr><th>层</th><th>剧情日</th><th>地点</th><th>发生了什么</th><th>在场</th></tr></thead><tbody>${cells.join('')}</tbody></table></div><div class="ihf-muted">共 ${rows.length} 层有记录${rows.some(r => r.hidden) ? ';灰的是已被隐藏的楼' : ''}</div>`;
}

/** 🎲 事件影响力:浮出过的事离现在多远、还剩多少影响;下面一排是幕后这几天的活动量 */
function renderFateChart() {
    const el = document.getElementById('ihf-fate-chart');
    if (!el || ui?.current !== 'mingyun') return;
    const fate = state.memory?.fate;
    const cfg = state.config?.fate;
    if (!fate || cfg?.enabled === false) { el.innerHTML = '<span class="ihf-muted">命运模块关着</span>'; return; }
    const now = state.view?.rows?.length ?? 0;
    const span = Math.max(1, Number(cfg.influenceFloors) || 30);
    const out = [];
    if (fate.pending) {
        out.push(`<div class="ihf-barrow"><div class="ihf-barlab">${escapeHtml(fate.pending.name)}:${escapeHtml(fate.pending.what)}</div><div class="ihf-bar"><div class="ihf-barfill ihf-barwait" style="width:100%"></div></div><div class="ihf-barval">等着浮出</div></div>`);
    }
    const events = [];
    for (const t of Object.values(fate.threads ?? {})) {
        for (const it of t.ideas ?? []) {
            if (Number.isFinite(it.surfacedAt)) events.push({ name: t.name, text: it.text, at: it.surfacedAt, state: it.state });
        }
    }
    events.sort((a, b) => b.at - a.at);
    for (const ev of events) {
        const left = Math.max(0, Math.min(1, 1 - (now - ev.at) / span));
        const pct = Math.round(left * 100);
        out.push(`<div class="ihf-barrow"><div class="ihf-barlab">${escapeHtml(ev.name)}:${escapeHtml(ev.text)} <span class="ihf-muted">第 ${ev.at} 层浮出</span></div><div class="ihf-bar"><div class="ihf-barfill" style="width:${pct}%"></div></div><div class="ihf-barval">${pct ? pct + '%' : '已过去'}</div></div>`);
    }
    if (!fate.pending && !events.length) out.push('<div class="ihf-muted">还没有浮出过的事。念头攒够了、时机到了才会浮到正文里</div>');
    // 幕后活动量:各栏「这几天」按剧情日数行数
    const perDay = new Map();
    for (const t of Object.values(fate.threads ?? {})) for (const l of t.log ?? []) if (Number.isFinite(l.day)) perDay.set(l.day, (perDay.get(l.day) ?? 0) + 1);
    if (perDay.size) {
        const days = [...perDay.keys()].sort((a, b) => a - b).slice(-14);
        const max = Math.max(...days.map(d => perDay.get(d)));
        out.push('<div class="ihf-muted" style="margin-top:6px">幕后活动量(每个剧情日各栏写了几行)</div>');
        out.push(`<div class="ihf-hist">${days.map(d => `<div class="ihf-histcol" title="Day${d}:${perDay.get(d)} 行"><div class="ihf-histbar" style="height:${Math.round(perDay.get(d) / max * 100)}%"></div><div class="ihf-histlab">D${d}</div></div>`).join('')}</div>`);
    }
    el.innerHTML = out.join('');
}

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
    fillSubModel(cur);
    $('#ihf-enabled').prop('checked', cfg.enabled !== false);
    $('#ihf-tier').val(cfg.tierLock || '');
    $('#ihf-recall-on').prop('checked', !!cfg.recall.enabled);
    $('#ihf-qmode').val(cfg.recall.queryMode);
    $('#ihf-ledger').val(cfg.ledger.mode);
    $('#ihf-bf-backend').val(cfg.jobs.backfillBackend);
    $('#ihf-tl-backend').val(cfg.jobs.timelineBackend);
    $('#ihf-tl-auto').prop('checked', !!cfg.jobs.timelineAuto);
    $('#ihf-bf-auto').val(Math.max(0, Number(cfg.jobs.backfillAuto) || 0));
    $('#ihf-rpm').val(cfg.jobs.rpm);
    // 副 API 和主线同一个站:插件每轮多打几次,会把本来就抖的公益站打死(9/17 苍穹那晚就是这样)
    const subConn = conns.find(x => x.id === cur);
    const mainUrl = String(ctx().chatCompletionSettings?.custom_url ?? '');
    const host = u => { try { return new URL(u).host; } catch { return ''; } };
    $('#ihf-sub-warn').toggle(!!(subConn?.url && mainUrl && host(subConn.url) && host(subConn.url) === host(mainUrl)));
    for (const k of ['embed', 'rerank']) {
        const ep = cfg.vector[k];
        $(`#ihf-${k}-url`).val(ep.url);
        $(`#ihf-${k}-key`).val(ep.key);
        $(`#ihf-${k}-model`).val(ep.model);
        fillModelList(k, ep.models, ep.model);
    }
    $('#ihf-via').val(cfg.vector.via || 'auto');
    renderRelayState();
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
            ...($('#ihf-sub').val() ? { subModels: { [String($('#ihf-sub').val())]: String($('#ihf-sub-model').val() ?? '').trim() } } : {}),
            backfillBackend: String($('#ihf-bf-backend').val()),
            timelineBackend: String($('#ihf-tl-backend').val()),
            timelineAuto: $('#ihf-tl-auto').prop('checked'),
            backfillAuto: Math.max(0, Math.min(50, Math.floor(Number($('#ihf-bf-auto').val()) || 0))),
            rpm: Math.max(1, Math.min(60, Number($('#ihf-rpm').val()) || 5)),
        },
        vector: {
            embed: readEndpointForm('embed'),
            rerank: readEndpointForm('rerank'),
            via: String($('#ihf-via').val() || 'auto'),
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
        const wasOn = state.config?.enabled !== false;
        await saveConfigPatch(patch, ctx().getRequestHeaders());
        state.config = await loadConfig();
        state.lastTier = null;
        updateTier(false);
        fillSettings();
        // 开关变了当场生效:关 = 撤掉注入、放下记忆;开 = 重新读这场聊天
        const isOn = state.config.enabled !== false;
        if (wasOn !== isOn) await openChat();
        toastr.success('设置已保存(存在插件自己的文件里,不进 settings.json)', TITLE);
    } catch (e) {
        toastr.error('设置没存上:' + (e?.message ?? e), TITLE);
    }
}

/* ---------------- 面板:悬浮球 + 三分页 ---------------- */

/** 每一页里放什么。壳(球、遮罩、分页、拖动、日夜)在 ui.js 里 */
const PAGE_HTML = {
    wuxian: `
      <div id="ihf-status" class="ihf-rows"></div>
      <div class="ihf-acts">
        <button id="ihf-reload" class="ihf-btn" title="重新把聊天和记忆文件核对一遍">重新核对</button>
        <button id="ihf-backfill" class="ihf-btn" title="没写摘要的旧楼层,让模型补一句摘要">给旧楼补摘要</button>
        <button id="ihf-timeline" class="ihf-btn" title="把更早的楼层压成一行一事的时间线">压成时间线</button>
        <button id="ihf-export" class="ihf-btn" title="把这场聊天的记忆文件下载下来">导出记忆</button>
        <button id="ihf-import" class="ihf-btn" title="把以前导出的记忆文件合并进这场聊天">导入记忆</button>
        <input type="file" id="ihf-import-file" accept=".json,application/json" hidden>
        <button id="ihf-stop" class="ihf-btn" style="display:none">停止</button>
      </div>
      <hr class="ihf-sep">
      <div class="ihf-card"><h4>全景表(从开局到现在)</h4><div id="ihf-table-view"></div></div>
      <div class="ihf-card"><h4>时间线(更早的楼压成的)</h4><div id="ihf-tl-view" class="ihf-rows"></div></div>`,

    renlei: `
      <div id="ihf-people-view" class="ihf-rows"></div>
      <div class="ihf-acts">
        <button id="ihf-affinit" class="ihf-btn" title="按人设和开场白,给每个人估一个开局好感">估一下开局好感</button>
        <button id="ihf-origins" class="ihf-btn" title="从人设里摘出每个人的性格原句,性格弧从这儿起">从人设里摘性格</button>
        <button id="ihf-breakif" class="ihf-btn" title="性格定型之后,问模型什么事会让它再变">问什么事会改性格</button>
      </div>
      <div class="ihf-muted">数都是按各层的加减现算的,不存死值。改了楼、滑了 swipe,重新对账就跟着变。</div>
      <hr class="ihf-sep">
      <div class="ihf-card">
        <h4>这几块各管各的</h4>
        <div class="ihf-muted">角色卡自带好感度的话,就把好感度那块关掉,免得两套一起发打架。</div>
        <div class="ihf-form">
          <label><input type="checkbox" id="ihf-mod-affinity"> 好感度</label>
          <label><input type="checkbox" id="ihf-mod-emotion"> 情绪</label>
          <label><span class="ihf-lab">情绪档</span><select id="ihf-emotion"><option value="major">只在重大事件后(推荐)</option><option value="all">全开(模拟真实世界)</option></select></label>
          <label><input type="checkbox" id="ihf-mod-arc"> 性格弧</label>
          <label><input type="checkbox" id="ihf-mod-promise"> 约定账</label>
          <label><input type="checkbox" id="ihf-mod-item"> 物品账</label>
          <button id="ihf-save" class="ihf-btn ihf-primary">保存</button>
        </div>
      </div>
      <div class="ihf-card">
        <h4>随机角色锁定</h4>
        <div class="ihf-muted">卡里让模型"第一次出场时随机起名、定样貌"的角色(女二、路人、地点都算),第一次出场后录成档案,之后把那条随机指令从发给模型的上下文里藏掉,换成档案顶上,就不会每回合重摇了。想换一个就点「重新摇」。</div>
        <div id="ihf-lock-view" class="ihf-rows"></div>
        <div class="ihf-form">
          <label><span class="ihf-lab">叫什么</span><input type="text" id="ihf-lock-label" placeholder="女二" style="flex:1"></label>
          <label><span class="ihf-lab">指令里的一句</span><input type="text" id="ihf-lock-match" placeholder="照抄那条随机指令里独一无二的一句,比如:她第一次在剧情里出场时" style="flex:1"></label>
          <label><span class="ihf-lab">档案标签</span><input type="text" id="ihf-lock-tag" placeholder="卡要求模型输出的标签名,如 女二档案;没有就空着,由副 API 提取" style="flex:1"></label>
          <button id="ihf-lock-add" class="ihf-btn ihf-primary">加一条</button>
          <div class="ihf-muted">规则跟着这张卡走,档案跟着这一局走。换一局重新摇,规则还在。</div>
        </div>
      </div>
      <div class="ihf-card">
        <h4>物品禁词表</h4>
        <div class="ihf-form">
          <label style="flex-direction:column;align-items:stretch">
            <span>一律不记(吃的喝的抽的)</span>
            <textarea id="ihf-never" rows="3" placeholder="一行一个,或者用逗号隔开"></textarea>
          </label>
          <div class="ihf-muted">两个字以上的词,名字里带上就算;一个字的词,要去掉量词后正好是它才算(不然"水"会把"墨水""水晶吊坠"也拦掉)。</div>
          <label style="flex-direction:column;align-items:stretch">
            <span>只在换了人拿、或者丢了毁了时才记(手机钱包这类随身物)</span>
            <textarea id="ihf-common" rows="3" placeholder="一行一个,或者用逗号隔开"></textarea>
          </label>
          <button id="ihf-save-items" class="ihf-btn ihf-primary">保存禁词表</button>
          <div class="ihf-muted">上面表格里每样东西后面也有 [不记] [只在出事时记],点一下就加进来,改完立刻重算。</div>
        </div>
      </div>`,

    mingyun: `
      <div class="ihf-card"><h4>事件影响力</h4><div id="ihf-fate-chart"></div></div>
      <div id="ihf-fate-view" class="ihf-rows"></div>
      <div class="ihf-acts">
        <button id="ihf-fate-ideas" class="ihf-btn" title="给每个 NPC 定几条长期念头,沉在水下慢慢酝酿">给 NPC 定幕后念头</button>
        <button id="ihf-fate-survey" class="ihf-btn" title="让 NPC 和世界在幕后过几天,更新各自的动向">推演一次幕后</button>
      </div>
      <hr class="ihf-sep">
      <div class="ihf-card">
        <h4>命运设置</h4>
        <div class="ihf-form">
          <label><input type="checkbox" id="ihf-fate-on"> 开启命运模块</label>
          <label><input type="checkbox" id="ihf-fate-world"> 单开一栏「世界」记背景板大事</label>
          <label><input type="checkbox" id="ihf-fate-acts"> 在场的人发行为清单(演过头就关掉)</label>
          <label><input type="checkbox" id="ihf-fate-inner"> 行为清单里加一条「不写心理活动」</label>
          <label><span class="ihf-lab">推演间隔</span>每隔 <input type="number" id="ihf-fate-every" min="1" max="99"> 层一次</label>
          <label><span class="ihf-lab">浮出间隔</span>至少隔 <input type="number" id="ihf-fate-gap" min="1" max="99"> 层</label>
          <label><span class="ihf-lab">开栏上限</span>最多 <input type="number" id="ihf-fate-npc" min="1" max="8"> 个人</label>
          <button id="ihf-fate-save" class="ihf-btn ihf-primary">保存</button>
          <div class="ihf-muted">念头原文只存在这儿,永远不发给模型。发出去的只有「在场时会」和当前那一档的「界」。</div>
        </div>
      </div>`,

    shezhi: `
      <div class="ihf-card">
        <div class="ihf-form">
          <label><input type="checkbox" id="ihf-enabled"> <b>开启插件</b></label>
          <div class="ihf-muted">关掉就完全不插手,发给模型的东西一个字都不改。</div>
          <label><span class="ihf-lab">档位</span><select id="ihf-tier"><option value="">跟着模型自动</option><option value="big">锁定大模型档</option><option value="small">锁定小模型档</option></select></label>
          <label><input type="checkbox" id="ihf-recall-on"> 开启召回</label>
          <label><span class="ihf-lab">召回查询</span><select id="ihf-qmode"><option value="split">分开用(推荐)</option><option value="concat">拼在一起</option></select></label>
          <label><span class="ihf-lab">每层记账</span><select id="ihf-ledger"><option value="main-inline">主 API 随正文写</option><option value="sub-after">副 API 回复后补写</option><option value="off">不记</option></select></label>
        </div>
      </div>
      <div class="ihf-card">
        <h4>副 API(后台干活用)</h4>
        <div class="ihf-form">
          <label><span class="ihf-lab">用哪个</span><select id="ihf-sub"></select></label>
          <div class="ihf-muted">从 API 管理器或酒馆的连接配置里选。请求经酒馆服务器发出、用酒馆密钥库里的 key,插件不碰也不存 key。</div>
          <label><span class="ihf-lab">模型</span><input type="text" id="ihf-sub-model" list="ihf-sub-models" placeholder="空着 = 用这条连接自己带的模型" style="flex:1"><datalist id="ihf-sub-models"></datalist><button id="ihf-sub-fetch" class="ihf-btn">拉取模型</button></label>
          <div id="ihf-sub-count" class="ihf-muted"></div>
          <label><span class="ihf-lab">补记账用</span><select id="ihf-bf-backend"><option value="main">主 API</option><option value="sub">副 API</option></select></label>
          <label><span class="ihf-lab">压时间线用</span><select id="ihf-tl-backend"><option value="main">主 API</option><option value="sub">副 API</option></select></label>
          <label><input type="checkbox" id="ihf-tl-auto"> 压时间线用副 API 时,自动压</label>
          <label><span class="ihf-lab">自动补旧账</span>补记账用副 API 时,每次生成后补 <input type="number" id="ihf-bf-auto" min="0" max="50"> 层(0 = 不自动)</label>
          <div class="ihf-muted">几百层的老聊天一次补不完,从第 0 层往现在一批一批补,几轮下来就补齐了。</div>
          <label><span class="ihf-lab">限速</span>每分钟最多 <input type="number" id="ihf-rpm" min="1" max="60"> 次</label>
          <div id="ihf-sub-warn" class="ihf-error" style="display:none">⚠️ 副 API 和主线是同一个站。插件每轮会多打几次,免费站限并发,容易把主线一起打死。换一个站当副 API 更稳。</div>
          <button id="ihf-save2" class="ihf-btn ihf-primary">保存设置</button>
          <div class="ihf-muted">设置存在 user/files/infinite-human-fate.config.json,不进 settings.json。</div>
        </div>
      </div>
      <div class="ihf-card">
        <h4>向量召回(嵌入 / 重排用哪个站)</h4>
        <div class="ihf-form">
          <div class="ihf-muted">嵌入站填好才有向量召回,不填也能用,只是退化成按专名找。重排那组可以空着。key 只存插件自己的文件。</div>
          <b>嵌入(embedding)</b>
          <label><span class="ihf-lab">地址</span><input type="text" id="ihf-embed-url" placeholder="https://api.siliconflow.cn/v1" style="flex:1"></label>
          <label><span class="ihf-lab">key</span><input type="password" id="ihf-embed-key" autocomplete="off" style="flex:1"></label>
          <label><span class="ihf-lab">模型</span><input type="text" id="ihf-embed-model" list="ihf-embed-models" placeholder="BAAI/bge-m3" style="flex:1"><datalist id="ihf-embed-models"></datalist><button id="ihf-embed-fetch" class="ihf-btn">拉取模型</button></label>
          <div id="ihf-embed-count" class="ihf-muted"></div>
          <b>重排(rerank,可不填)</b>
          <label><span class="ihf-lab">地址</span><input type="text" id="ihf-rerank-url" placeholder="空着就只按向量排" style="flex:1"></label>
          <label><span class="ihf-lab">key</span><input type="password" id="ihf-rerank-key" autocomplete="off" placeholder="和嵌入同一个站可以不填" style="flex:1"></label>
          <label><span class="ihf-lab">模型</span><input type="text" id="ihf-rerank-model" list="ihf-rerank-models" placeholder="BAAI/bge-reranker-v2-m3" style="flex:1"><datalist id="ihf-rerank-models"></datalist><button id="ihf-rerank-fetch" class="ihf-btn">拉取模型</button></label>
          <div id="ihf-rerank-count" class="ihf-muted"></div>
          <label><span class="ihf-lab">怎么发</span><select id="ihf-via"><option value="auto">有转发插件就转发,没有就直连</option><option value="server">只走酒馆服务器转发</option><option value="direct">只浏览器直连</option></select></label>
          <div id="ihf-relay-state" class="ihf-muted"></div>
          <button id="ihf-save3" class="ihf-btn ihf-primary">保存设置</button>
        </div>
      </div>`,

    bangzhu: `
      <div class="ihf-card">
        <h4>这插件在干嘛</h4>
        <div class="ihf-muted">
          聊天一长,模型就开始忘事、把人演回从前、让所有人随叫随到。
          它把"记住什么、发多少、什么时候发"接管过来。<br><br>
          <b>♾️ 无限</b>:最近的原文照发,再往前换成一层一句的摘要,更早的压成时间线一行一件事,
          另外按你这句话的意思去把相干的旧楼捞回来。<br>
          <b>👥 人类</b>:好感度、情绪、性格弧、约定账、物品账。
          模型只写"+2 因为什么事",所有加减和分档都是这边算的,它一个数都碰不到。<br>
          <b>🎲 命运</b>:NPC 和世界在背后自己过日子,踩中写死的条件才浮出到正文。
        </div>
      </div>
      <div class="ihf-card">
        <h4>第一次用</h4>
        <div class="ihf-muted">
          1. ⚙️ 里勾上<b>开启插件</b>。<br>
          2. 挑一个<b>副 API</b>(补记账、压时间线、幕后推演都走它,省主 API 的额度和你的钱)。<br>
          3. 想要向量召回的话,在 ⚙️ 的「向量召回」里填嵌入站的地址和 key,点「拉取模型」选一个嵌入模型。
          重排那组可以不填。不填也能用,只是召回退化成按专名找。<br>
          　 想让公益站看到的是酒馆在发请求,把插件文件夹里的 <code>server-plugin</code> 拷成酒馆根目录的
          <code>plugins/infinite-human-fate</code>,config.yaml 里 <code>enableServerPlugins: true</code>,重启酒馆服务。<br>
          4. 剩下的它自己会跑。哪儿不对就来这三页看,每个数旁边都写着是因为什么事加减的。
        </div>
      </div>
      <div class="ihf-card">
        <h4>它不动什么</h4>
        <div class="ihf-muted">
          聊天原文一个字不改,删减只发生在发出去之前的副本上。<br>
          settings.json 一个字不写,数据和设置都在 user/files 自己的 json 里。<br>
          正则、预设、酒馆本体,一概不碰。
        </div>
      </div>`,
};

function mountPanel() {
    const cfg = state.config?.ui ?? {};
    ui = mountShell({
        version: VERSION,
        pos: cfg.ballPos ?? null,
        theme: cfg.theme ?? 'night',
        onMove: pos => saveUiPatch({ ballPos: pos }),
        onTheme: theme => saveUiPatch({ theme }),
        onShow: () => render(),
    });
    for (const [key, html] of Object.entries(PAGE_HTML)) {
        const page = ui.page(key);
        if (page) page.innerHTML = html;
    }

    $('#ihf-reload').on('click', () => openChat());
    $('#ihf-backfill').on('click', () => startBackfill());
    $('#ihf-timeline').on('click', () => startTimeline());
    $('#ihf-stop').on('click', () => { state.jobs.stop = true; render(); });
    $('#ihf-save, #ihf-save2, #ihf-save3').on('click', () => saveSettings());
    $('#ihf-export').on('click', () => exportMemory());
    $('#ihf-import').on('click', () => $('#ihf-import-file').val('').trigger('click'));
    $('#ihf-import-file').on('change', function () { importMemory(this.files?.[0]); });
    $('#ihf-sub').on('change', () => fillSubModel($('#ihf-sub').val()));
    $('#ihf-sub-fetch').on('click', () => onFetchSubModels());
    $('#ihf-lock-add').on('click', () => addLockRule());
    $(document).on('click', '#ihf-lock-view .ihf-lock-del', async function () {
        const rules = lockRules().filter((_, i) => i !== Number($(this).data('idx')));
        await saveLockRules(rules);
        renderLocks();
    });
    $(document).on('click', '#ihf-lock-view .ihf-lock-reroll', function () {
        const r = lockRules()[Number($(this).data('idx'))];
        if (!r || !state.memory) return;
        // 不删键,留一条空档案记着"从第几层之后才算重新摇的":不然按标签扫旧楼又把原来那份抓回来,
        // 两台设备合并时远端的旧档案也会灌回来
        const lastAi = [...(state.view?.rows ?? [])].reverse().find(x => !x.isUser && !x.hidden);
        state.memory.locks = { ...(state.memory.locks ?? {}), [r.label]: { profile: '', after: lastAi?.index ?? -1, source: 'reroll', at: Date.now() } };
        if (lastAi) state.memory.lockChecked = { ...(state.memory.lockChecked ?? {}), [r.label]: lastAi.fp };
        scheduleSave();
        renderLocks();
        toastr.info(`「${r.label}」的档案已清掉,那条随机指令下一轮重新放行`, TITLE);
    });
    $(document).on('change', '#ihf-lock-view .ihf-lock-profile', function () {
        const r = lockRules()[Number($(this).data('idx'))];
        const v = String($(this).val() ?? '').trim();
        if (!r || !state.memory || !v) return;
        const old = state.memory.locks?.[r.label] ?? { floor: 0 };
        state.memory.locks = { ...(state.memory.locks ?? {}), [r.label]: { ...old, profile: v, source: 'manual', at: Date.now() } };
        scheduleSave();
        renderLocks();
    });
    $(document).on('click', '#ihf-people-view .ihf-prev', () => { state.peopleIdx = (state.peopleIdx ?? 0) - 1; renderPeople(); });
    $(document).on('click', '#ihf-people-view .ihf-next', () => { state.peopleIdx = (state.peopleIdx ?? 0) + 1; renderPeople(); });
    $(document).on('click', '#ihf-people-view .ihf-dot', function () { state.peopleIdx = Number($(this).data('idx')) || 0; renderPeople(); });
    $('#ihf-embed-fetch').on('click', () => onFetchModels('embed'));
    $('#ihf-rerank-fetch').on('click', () => onFetchModels('rerank'));
    $('#ihf-via').on('change', () => renderRelayState());
    $('#ihf-fate-ideas').on('click', () => startFateIdeas());
    $('#ihf-fate-survey').on('click', () => startFateSurvey());
    $('#ihf-fate-save').on('click', () => saveFateSettings());
    $('#ihf-affinit').on('click', () => startAffinityInit());
    $('#ihf-origins').on('click', () => startOrigins());
    $('#ihf-breakif').on('click', () => startBreakIf());
    $('#ihf-save-items').on('click', () => saveItemLists({
        itemNever: parseWordList($('#ihf-never').val()),
        itemCommon: parseWordList($('#ihf-common').val()),
    }));
    $(document).on('click', '.ihf-block', function () { addItemWord($(this).data('which'), String($(this).data('word'))); });
    $(document).on('change', '.ihf-start', function () { setAffinityStart($(this).data('name'), $(this).val()); });

    // 扩展抽屉里只留一句话和一个入口,别再往那儿堆东西(道长:堆在抽屉里太不方便了)
    $('#extensions_settings2').append(`
<div class="ihf-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>无限人类命运 <span class="ihf-muted">v${VERSION}</span><span id="ihf-new" class="ihf-new" hidden>New!</span></b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="ihf-status ihf-muted">平时用右边那颗 ♾️ 悬浮球,可以随便拖,靠边会自己缩进去一半。</div>
      <div class="ihf-actions">
        <div id="ihf-open" class="menu_button">打开面板</div>
      </div>
      <label class="checkbox_label"><input type="checkbox" id="ihf-ball-on"> 显示悬浮球</label>
    </div>
  </div>
</div>`);
    $('#ihf-open').on('click', () => ui.open());
    $('#ihf-ball-on').on('change', function () {
        const on = $(this).prop('checked');
        ui.setBallVisible(on);
        saveUiPatch({ ball: on });
    });
}

/** 界面上那点偏好(球在哪、日夜)也存进设置文件,不进 settings.json */
function saveUiPatch(patch) {
    if (!state.config) return;
    state.config.ui = { ...state.config.ui, ...patch };
    saveConfigPatch({ ui: patch }, ctx().getRequestHeaders()).catch(e => console.warn(LOG, '界面偏好没存上', e));
}

jQuery(async () => {
    console.info(LOG, `v${VERSION} 已加载`);
    mountPanel();
    setHeaders(() => ctx().getRequestHeaders());
    try {
        state.config = await loadConfig();
    } catch (e) {
        setError('读设置文件失败,插件暂不工作', e);
        return;
    }
    // 探一次服务端转发插件在不在,探完再填设置页(那一页要显示走的是哪条路)
    await probeRelay();
    updateTier(false);
    fillSettings();
    ui.setBallVisible(state.config.ui?.ball !== false);
    $('#ihf-ball-on').prop('checked', state.config.ui?.ball !== false);
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
    // 随机角色锁定:档案录好之后,把那条随机生成指令从真正发出去的上下文里藏掉。
    // 这个事件给的 chat 就是预设组装完、世界书塞完的最终消息数组,改它的 content 就改了发出去的东西。
    eventSource.on(et.CHAT_COMPLETION_PROMPT_READY, ({ chat, dryRun }) => {
        if (dryRun || state.config?.enabled === false || !state.memory || !Array.isArray(chat)) return;
        const arch = lockArchives();
        const active = lockRules().filter(r => r.match && arch[r.label]?.profile);
        if (!active.length) return;
        let hits = 0;
        for (const m of chat) {
            if (typeof m?.content !== 'string') continue;
            for (const r of active) {
                const h = hideInstruction(m.content, r.match);
                if (h.hit) { m.content = h.text; hits++; }
            }
        }
        state.lockHits = hits;
        if (hits) console.info(LOG, `随机指令已从上下文藏掉 ${hits} 处`);
    });
    // 查更新要等服务端 git fetch 一趟,别跟开屏抢路,歇一会儿再问
    setTimeout(checkUpdate, 8000);
    eventSource.on(et.CHATCOMPLETION_MODEL_CHANGED, () => updateTier(true));
    eventSource.on(et.MAIN_API_CHANGED, () => updateTier(true));
    await openChat();
});
