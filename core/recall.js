/**
 * 召回(任务书第八节)的计算部分:查询怎么拼、向量怎么存、分数怎么算、按字数上限取哪些。
 * 网络请求在 siliconflow.js,流程串联在 index.js。
 *
 * 打分:  (重排分 + nameWeight × 专名稀有度) × 时间衰减
 *   重排分:bge-reranker 给的相关度(0~1);重排失败时退回向量相似度折算。
 *   专名加分:查询里出现了这层记下的名字就加分,名字越稀有加得越多(主角名这种层层都有的几乎不加,治 v5.6 的病 1)。
 *   时间衰减:按剧情天数算,旧事分数往下打,但最多打到 decayFloor,旧事不许压过现在。
 * 取舍:  分数要过 max(minScore, 第一名 × relMin),且不超过条数上限和字数上限。
 *   9/11 实测:问得准时目标楼 0.4 左右、第二名 0.01;查询被带偏时十几条全挤在 0.1~0.2,
 *   只用绝对门槛会一次召回十几条,所以要跟第一名比。
 *
 * 本文件不依赖酒馆和网络,可在 node 里直接测。
 */

import { stripLedger } from './ledger.js';
import { hashText } from './fingerprint.js';

/** 一层 AI 回复里真正的正文。美梦巡游这类预设把正文包在 <content> 里,其余是状态栏和折叠块 */
export function extractNarrative(mes) {
    const s = String(mes ?? '');
    const m = s.match(/<content>([\s\S]*?)<\/content>/i);
    const body = m
        ? m[1]
        : stripLedger(s).replace(/<details[\s\S]*?<\/details>/gi, '').replace(/```[\s\S]*?```/g, '');
    return body
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** 最后一句用户发言,和它前面那层 AI 回复的正文。以用户发言为准往前找,重 roll、续写时也对 */
export function lastTurn(raw) {
    let u = -1;
    for (let i = raw.length - 1; i >= 0; i--) {
        if (raw[i].is_user && !raw[i].is_system) { u = i; break; }
    }
    if (u < 0) return { user: '', ai: '' };
    let ai = '';
    for (let i = u - 1; i >= 0; i--) {
        if (!raw[i].is_user && !raw[i].is_system) { ai = extractNarrative(raw[i].mes); break; }
    }
    return { user: String(raw[u].mes ?? '').trim(), ai };
}

/** 去掉标点、符号、空白后剩几个字,用来判断用户这句是不是太短("嗯""继续") */
export function meaningfulLength(s) {
    return String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '').length;
}

/**
 * 查询怎么拼。记账块、折叠块都不进查询(治 v5.6 的病 2)。
 *   concat:AI 正文末尾 queryAiChars 字 + 用户这句,向量和重排都用它(道长原定)。
 *   split :排序只看用户这句;AI 末尾 splitAiChars 字只用来多捞候选,不参与打分;
 *           用户这句太短(不足 minUserChars 字)时才把 AI 末尾拼进排序查询。
 *           9/11 诊断(test_recall_diag.mjs):只用问题时三题目标楼都排第一,带上 AI 末尾 800 字就掉到 4~13。
 * @returns {{rank:string, pool:string[], short:boolean}|null} rank 拿去重排和点名,pool 拿去算向量捞候选
 */
export function buildQueries(raw, rc) {
    const { user, ai } = lastTurn(raw);
    if (!user && !ai) return null;
    const join = (a, b) => [a, b].filter(Boolean).join('\n');
    if (rc.queryMode === 'split') {
        const tail = ai.slice(-rc.splitAiChars);
        const short = meaningfulLength(user) < rc.minUserChars;
        const rank = short ? join(tail, user) : user;
        return { rank, pool: short ? [rank] : [user, join(tail, user)], short };
    }
    const q = join(ai.slice(-rc.queryAiChars), user);
    return { rank: q, pool: [q], short: false };
}

/** 拿去算向量、做重排的那段文字:摘要 + 专名。不用整层原文,9/11 实测摘要比正文前 1500 字排得准 */
export function docText(rec) {
    const names = rec?.names?.length ? `(${rec.names.join('、')})` : '';
    return `${rec?.summary ?? ''}${names}`;
}

/** 向量压成 int8 存 base64:1024 维一层约 1.4K 字,比 float 小四倍。先归一化,点积 / 127 就近似余弦 */
export function quantize(vec) {
    let norm = 0;
    for (const x of vec) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    let bin = '';
    for (let i = 0; i < vec.length; i++) {
        const q = Math.max(-127, Math.min(127, Math.round((vec[i] / norm) * 127)));
        bin += String.fromCharCode(q & 0xff);
    }
    return btoa(bin);
}

export function dequantize(b64) {
    const bin = atob(b64);
    const out = new Int8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        const b = bin.charCodeAt(i);
        out[i] = b > 127 ? b - 256 : b;
    }
    return out;
}

export function normalize(vec) {
    let norm = 0;
    for (const x of vec) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    return Float32Array.from(vec, x => x / norm);
}

/** 归一化的查询向量 × int8 存档向量 */
export function cosineQ(qn, q8) {
    let s = 0;
    const n = Math.min(qn.length, q8.length);
    for (let i = 0; i < n; i++) s += qn[i] * q8[i];
    return s / 127;
}

/** 这层的向量是不是用当前模型、按当前摘要算的。摘要改了、换了模型都要重算 */
export function vecFresh(rec, model) {
    return !!rec?.vec && rec.vec.m === model && rec.vec.h === hashText(docText(rec));
}

export function makeVec(rec, model, vec) {
    return { m: model, h: hashText(docText(rec)), d: quantize(vec) };
}

/**
 * 每条查询各算一遍余弦。
 * @param {Float32Array[]} queryVecs 已归一化
 * @returns {Map<number, number>[]} 每条查询一个 Map(行号 → 余弦)
 */
export function cosineMaps(queryVecs, cands, model) {
    return queryVecs.map(qn => {
        const map = new Map();
        for (const r of cands) {
            if (vecFresh(r.record, model)) map.set(r.index, cosineQ(qn, dequantize(r.record.vec.d)));
        }
        return map;
    });
}

/** 几条查询的余弦取最大,重排挂了时拿它兜底 */
export function bestCosine(maps) {
    const out = new Map();
    for (const m of maps) for (const [k, v] of m) if (!out.has(k) || v > out.get(k)) out.set(k, v);
    return out;
}

/** 专名的稀有程度(0~1):出现的楼层越多越接近 0 */
export function nameIdf(records) {
    const df = new Map();
    const N = records.length;
    for (const r of records) {
        for (const n of new Set(r.names ?? [])) df.set(n, (df.get(n) ?? 0) + 1);
    }
    const denom = Math.log(N + 1) || 1;
    const idf = new Map();
    for (const [n, d] of df) idf.set(n, Math.log((N + 1) / (d + 1)) / denom);
    return idf;
}

export function matchNames(names, query) {
    return (names ?? []).filter(n => n.length >= 2 && query.includes(n));
}

/** 重排挂了时,把向量相似度折算成大致同一量纲。bge-m3 相关的一般在 0.55 以上,不相关的在 0.4 以下 */
export function cosToScore(c) {
    return Math.max(0, Math.min(1, (c - 0.35) / 0.45));
}

export function decay(daysAgo, cfg) {
    const d = Math.max(0, daysAgo);
    return cfg.decayFloor + (1 - cfg.decayFloor) * Math.pow(0.5, d / cfg.halfLifeDays);
}

/**
 * 候选池:每条查询各取向量最像的前 vectorTopK 条,再加上排序查询里点了名的楼,去重后最多 rerankMax 条。
 * @param {Map<number, number>[]} maps cosineMaps() 的结果
 */
export function pickPool(cands, maps, rankQuery, cfg) {
    const seen = new Set();
    const out = [];
    for (const map of maps) {
        const top = cands.filter(r => map.has(r.index)).sort((a, b) => map.get(b.index) - map.get(a.index)).slice(0, cfg.vectorTopK);
        for (const r of top) if (!seen.has(r.index)) { seen.add(r.index); out.push(r); }
    }
    for (const r of cands) {
        if (!seen.has(r.index) && matchNames(r.record.names, rankQuery).length) { seen.add(r.index); out.push(r); }
    }
    return out.slice(0, cfg.rerankMax);
}

/** 给候选池打分,从高到低排 */
export function scoreCandidates({ pool, cos, rr, query, idf, cfg, lastDay }) {
    return pool
        .map(r => {
            const hits = matchNames(r.record.names, query);
            const nameScore = Math.min(1, hits.reduce((s, n) => s + (idf.get(n) ?? 0), 0));
            const from = rr.has(r.index) ? 'rerank' : cos.has(r.index) ? 'vector' : 'name';
            const base = from === 'rerank' ? rr.get(r.index) : from === 'vector' ? cosToScore(cos.get(r.index)) : 0;
            const dec = decay(lastDay - r.day, cfg);
            return { row: r, hits, from, base, nameScore, decay: dec, score: (base + cfg.nameWeight * nameScore) * dec };
        })
        .sort((a, b) => b.score - a.score);
}

/**
 * 从高分往下取:分数要过 max(minScore, 第一名 × relMin),条数不超过 maxItems;
 * 放不进字数上限的跳过,看后面短的能不能塞进去。结果按楼序排,读起来是按时间先后的闪回。
 * @param {(row:object) => string} textFor
 */
export function selectRecall(scored, { minScore, relMin, maxItems, budget, textFor }) {
    const floor = Math.max(minScore, (scored[0]?.score ?? 0) * relMin);
    const out = [];
    let used = 0;
    for (const s of scored) {
        if (s.score < floor || out.length >= maxItems) break;
        const text = textFor(s.row);
        if (!text || used + text.length > budget) continue;
        used += text.length;
        out.push({ ...s, text });
    }
    return out.sort((a, b) => a.row.index - b.row.index);
}
