/**
 * 存储(任务书第十三节):settings.json 里一个字都不放,开机会变慢。
 *
 * 全部走酒馆自带的文件接口,存在 user/files/ 下:
 *   写 POST /api/files/upload(src/endpoints/files.js:28,base64)
 *   读 GET  /user/files/<名>(src/users.js:1218,和 settings.json 受同一道登录门)
 * 文件名只许英文数字和 _-.(src/endpoints/assets.js:22),所以记忆文件按编号命名,
 * 另存一个索引记"聊天名 → 编号"。
 */

import { DEFAULT_PEOPLE } from './core/people.js';
import { DEFAULT_FATE } from './core/fate.js';

export const PREFIX = 'infinite-human-fate';
export const FILES = {
    config: `${PREFIX}.config.json`,
    index: `${PREFIX}.index.json`,
    mem: id => `${PREFIX}.mem.${id}.json`,
};

export const DEFAULT_CONFIG = {
    version: 1,
    enabled: true,
    /** 向量召回用的站。嵌入和重排各自一套地址 / key / 模型,不绑死一家(大家用的公益站不一样)。
     *  重排整组可以空着,空着就只按向量排。models 是面板「拉取模型」拉回来的列表,存着下次还能选。
     *  via:auto = 装了服务端转发插件就经酒馆服务器发,没装就浏览器直连;server / direct 锁死。
     *  旧版的 siliconflow 那一块还认,第一次读会自动搬到这里。 */
    vector: {
        embed: { url: 'https://api.siliconflow.cn/v1', key: '', model: 'BAAI/bge-m3', models: [] },
        rerank: { url: '', key: '', model: '', models: [] },
        via: 'auto',
    },
    ledger: {
        /** main-inline = 主 API 随正文写;sub-after = 每层回复后让副 API 补写;off = 不记 */
        mode: 'main-inline',
        /** 空 = 用内置默认模板 */
        instruction: '',
    },
    /** 补记账、压时间线用哪个 API。副 API 存成 st:<酒馆连接配置 id> 或 acm:<API 管理器里的配置名>,
     *  请求经酒馆服务器发出、用酒馆密钥库里的 key,插件不存 key;
     *  主 API = 当前连接,只能手动触发、等正在进行的生成结束再跑。 */
    jobs: {
        subProfile: '',
        backfillBackend: 'main',
        timelineBackend: 'main',
        /** 压时间线选了副 API 时,有整段滑出摘要区就自动压 */
        timelineAuto: true,
        /** 补记账选了副 API 时,每次生成结束后自动补几层旧账(从第 0 层往现在补,倒着补时间线会乱)。
         *  几百层的老聊天一次补不完,分批慢慢补;0 = 不自动,只靠手点「补记账」 */
        backfillAuto: 8,
        /** 每分钟最多发几次(苍穹这类免费站限高并发,自律 5 次) */
        rpm: 5,
        /** 副 API 活的回复上限。会思考的模型(Gemini 3.1 Pro 这类)思考也算在里面,
         *  9/11 实测给 2000 时时间线写到一半就被截断,只剩开头几层 */
        maxTokens: 8000,
    },
    /** 时间线:更早区每 chunk 层 AI 楼压一段,每层原文最多喂 floorChars 字 */
    timeline: { chunk: 10, floorChars: 1500 },
    /** 人类模块(第二期):好感度、情绪、性格弧、约定账、物品账。见 core/people.js */
    people: DEFAULT_PEOPLE,
    /** 命运模块(第三期):NPC 和世界的幕后活动。见 core/fate.js */
    fate: DEFAULT_FATE,
    /** 档位(任务书第四节):按模型承受力换打法,不是选模型。
     *  第一期只调大模型档;小模型档是占位,等道长实验本地模型后再定。
     *  层数按消息条数算(用户、AI 各算一层);memoryChars 是记忆块里时间线 + 摘要的字数上限,
     *  recallChars / recallMax 是回忆那一节的字数上限和条数上限;recallGives:full = 召回一律给正文原文,
     *  upgrade = 升一级(摘要区的楼给原文,更早的楼给摘要)。 */
    tiers: {
        big: { label: '大模型档', bodyFloors: 20, summaryFloors: 60, memoryChars: 40000, recallChars: 30000, recallMax: 6, recallGives: 'full' },
        small: { label: '小模型档(占位,待实验)', bodyFloors: 8, summaryFloors: 30, memoryChars: 4000, recallChars: 3000, recallMax: 2, recallGives: 'upgrade' },
    },
    /** 模型名里含这些字(不分大小写)就走对应档,从上往下第一条命中为准。
     *  都没命中:沿用上一次的档位,再没有就用 defaultTier。 */
    tierRules: [
        { match: 'koboldcpp', tier: 'small' },
        { match: 'gguf', tier: 'small' },
        { match: 'tifa', tier: 'small' },
        { match: 'gemini', tier: 'big' },
        { match: 'claude', tier: 'big' },
        { match: 'gpt', tier: 'big' },
        { match: 'deepseek', tier: 'big' },
        { match: 'glm', tier: 'big' },
        { match: 'grok', tier: 'big' },
        { match: 'kimi', tier: 'big' },
    ],
    /** 记账要求、人物现状、当前状态挂在倒数第几条。
     *  **不许填 0**:注入是在倒序数组上 splice 的(public/scripts/openai.js:801-861),
     *  深度 0 会插在整段对话最后面,把用户那句顶掉,而不少模型要求末条必须是 user
     *  (道长)。1 = 紧挨在用户最后那句之前,注意力一样高,但末条还是用户。 */
    injectDepth: 1,
    /** 界面偏好:悬浮球在哪、显不显示、日夜。存这儿不进 settings.json */
    ui: { ball: true, ballPos: null, theme: 'night' },
    /** 开页面几秒后问一次酒馆"这个扩展有没有新版",有就在抽屉标题上挂个 New!。
     *  服务端会真的 git fetch 一趟,所以是延后问的,不占开屏。不想要就填 false。 */
    checkUpdate: true,
    /** 手动锁档:'' = 自动,'big' / 'small' = 锁死 */
    tierLock: '',
    defaultTier: 'big',
    /** 记忆层级里"剧情档案馆"那一行:auto = 聊天里有被隐藏的楼(梦游助手大总结后会隐藏旧楼)才带;always / never */
    archiveLine: 'auto',
    /** 召回(任务书第八节)。分数 = (重排分 + nameWeight × 专名稀有度) × 时间衰减 */
    recall: {
        enabled: true,
        /** 向量粗筛取前几条送去重排 */
        vectorTopK: 30,
        /** 连同点名命中的,最多送多少条去重排 */
        rerankMax: 40,
        nameWeight: 0.15,
        /** 取舍门槛 = max(minScore, 第一名 × relMin)。9/11 实测问得准时目标楼约 0.4、第二名约 0.01 */
        minScore: 0.03,
        relMin: 0.3,
        /** 剧情时间过了这么多天,旧事的分数打到四分之三 */
        halfLifeDays: 90,
        /** 再老的事也保留这个比例的分数 */
        decayFloor: 0.5,
        /** 查询怎么拼(见 core/recall.js buildQueries):
         *  concat = AI 正文末尾 queryAiChars 字 + 用户这句(道长原定);
         *  split = 排序只看用户这句,AI 末尾 splitAiChars 字只捞候选,用户这句不足 minUserChars 字才拼进来。
         *  9/11 诊断 split 三题全排第一,concat 掉到 4~13;真实一句 concat 一条没召回。道长默认 split。 */
        queryMode: 'split',
        queryAiChars: 800,
        splitAiChars: 200,
        minUserChars: 6,
        /** 后台补向量一次发多少条 */
        embedBatch: 16,
    },
};

/** UTF-8 字符串 → base64。分块拼,记忆文件带向量后会有几 MB,一次性 apply 会爆栈 */
function toBase64Utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

/** 读不到返回 null。网址带随机参数,防云端 Cloudflare 喂旧副本 */
export async function readJson(name) {
    const res = await fetch(`/user/files/${name}?t=${Date.now()}`, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`读 ${name} 失败:HTTP ${res.status}`);
    return await res.json();
}

/** indent 只给设置文件用(她会拿记事本手改);记忆文件带向量,压成一行省地方 */
export async function writeJson(name, obj, headers, indent = 0) {
    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name, data: toBase64Utf8(JSON.stringify(obj, null, indent || undefined)) }),
    });
    if (!res.ok) throw new Error(`写 ${name} 失败:HTTP ${res.status} ${await res.text()}`);
}

function isPlainObject(v) {
    return v && typeof v === 'object' && !Array.isArray(v);
}

/** 缺的字段用默认值补上,已有的一律保留(包括 _说明 这种说明字段) */
export function mergeDefaults(def, got) {
    if (!isPlainObject(got)) return structuredClone(def);
    const out = { ...got };
    for (const [k, v] of Object.entries(def)) {
        if (isPlainObject(v)) out[k] = mergeDefaults(v, got[k]);
        else if (!(k in got)) out[k] = v;
    }
    return out;
}

/** 把 patch 里的字段逐层写进 target,其余原样保留 */
function deepAssign(target, patch) {
    const out = isPlainObject(target) ? { ...target } : {};
    for (const [k, v] of Object.entries(patch)) {
        out[k] = isPlainObject(v) ? deepAssign(out[k], v) : v;
    }
    return out;
}

/** 面板点保存:先读文件原样,只改面板上那几项再写回。key、_说明 这些她手填的字段一个不动 */
export async function saveConfigPatch(patch, headers) {
    const cur = (await readJson(FILES.config)) ?? {};
    await writeJson(FILES.config, deepAssign(cur, patch), headers, 2);
}

/** 读设置。只读不写:缺字段在内存里补,不回写她手填的文件 */
export async function loadConfig() {
    const got = await readJson(FILES.config);
    const cfg = mergeDefaults(DEFAULT_CONFIG, got);
    // 旧版只有 siliconflow 一块:她填过 key 的话搬到新结构,嵌入和重排都指向同一家
    const old = got?.siliconflow;
    if (isPlainObject(old) && !got?.vector) {
        const url = String(old.base_url ?? '').trim() || cfg.vector.embed.url;
        const key = String(old.key ?? '').trim();
        cfg.vector.embed = { ...cfg.vector.embed, url, key, model: String(old.embed_model ?? '').trim() || cfg.vector.embed.model };
        if (key) cfg.vector.rerank = { ...cfg.vector.rerank, url, key, model: String(old.rerank_model ?? '').trim() || 'BAAI/bge-reranker-v2-m3' };
    }
    for (const k of ['embed', 'rerank']) {
        const ep = cfg.vector[k];
        ep.url = String(ep.url ?? '').trim();
        ep.key = String(ep.key ?? '').trim();
        ep.model = String(ep.model ?? '').trim();
        if (!Array.isArray(ep.models)) ep.models = [];
    }
    return cfg;
}

export async function loadIndex() {
    const idx = await readJson(FILES.index);
    return isPlainObject(idx) && isPlainObject(idx.chats) ? idx : { format: 1, chats: {} };
}

export function newMemId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * 两台设备各写各的时候合并:按指纹取并集,同一楼两边都有就留较新的那条;
 * 一样新的时候留带向量的那条,免得后台刚算好的向量被对面的旧副本冲掉。
 * 时间线按段键取并集,同一段两边都有以本地为准;历法以本地为准。
 * 性格原句和锚定记录(破锚条件)也按键取并集,本地优先。
 */
export function mergeMemory(local, remote) {
    if (!remote) return local;
    const floors = { ...remote.floors };
    for (const [fp, rec] of Object.entries(local.floors)) {
        const other = floors[fp];
        const a = rec.at ?? 0;
        const b = other?.at ?? 0;
        if (!other || a > b || (a === b && (rec.vec || !other.vec))) floors[fp] = rec;
    }
    return {
        ...local,
        floors,
        calendar: local.calendar?.start ? local.calendar : remote.calendar,
        timeline: { ...(isPlainObject(remote.timeline) ? remote.timeline : {}), ...(isPlainObject(local.timeline) ? local.timeline : {}) },
        origins: { ...(isPlainObject(remote.origins) ? remote.origins : {}), ...(isPlainObject(local.origins) ? local.origins : {}) },
        anchors: { ...(isPlainObject(remote.anchors) ? remote.anchors : {}), ...(isPlainObject(local.anchors) ? local.anchors : {}) },
        affinityStart: { ...(isPlainObject(remote.affinityStart) ? remote.affinityStart : {}), ...(isPlainObject(local.affinityStart) ? local.affinityStart : {}) },
        // 幕后是存死的状态不是折算出来的,两边都写过就留较新的那份整份,别逐栏拼(拼出来会前后矛盾)
        fate: (local.fate?.lastRunFloor ?? -1) >= (remote.fate?.lastRunFloor ?? -1) ? local.fate : remote.fate,
        affinityInitAt: local.affinityInitAt ?? remote.affinityInitAt ?? 0,
        rev: Math.max(local.rev ?? 0, remote.rev ?? 0),
    };
}
