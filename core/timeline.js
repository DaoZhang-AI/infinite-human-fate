/**
 * 时间线(任务书第六节):"更早"区的 AI 楼从聊天开头起每 chunk 层切一段,整段压成几行时间线。
 *
 * 切段从开头数,聊天往后长时前面的段不会变;段键 = 这几层正文指纹连起来的哈希,
 * 哪层被编辑、滑了 swipe、删了,段键就变,那段自然重压。
 * 被梦游助手隐藏的楼不进段(视为大总结已接管,任务书第十节)。
 * 只压完整落在"更早"区里的整段,还在摘要区里的楼不动。
 *
 * 本文件不依赖酒馆,可在 node 里直接测。
 */

import { hashText } from './fingerprint.js';

/** 旧版记忆文件的 timeline 是数组,统一成 段键 → 段 的对象 */
export function normalizeTimeline(memory) {
    if (!memory.timeline || Array.isArray(memory.timeline)) memory.timeline = {};
    return memory;
}

/**
 * @param {object[]} rows reconcile() 的行
 * @param {number[]} olderIdx planZones() 的 older
 * @returns {{key:string, rows:object[]}[]}
 */
export function planTimelineChunks(rows, olderIdx, size) {
    const older = new Set(olderIdx);
    const ai = rows.filter(r => !r.isUser && !r.hidden);
    const chunks = [];
    for (let k = 0; k + size <= ai.length; k += size) {
        const part = ai.slice(k, k + size);
        if (!part.every(r => older.has(r.index))) break;
        chunks.push({ key: hashText(part.map(r => r.fp).join(',')), rows: part });
    }
    return chunks;
}

const LINE_RE = /^(?:[-*•·]\s*)?(?:(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*)?Day\s*(\d+)\s*[|｜]\s*(.+)$/i;

/** 模型写的时间线 → [{day, text}]。认不出格式的行丢掉;太长的截到 80 字防失控。
 *  9/11 实测模型会把格式说明里的占位词照抄进来("Day1｜正文某某……"),行首的占位词剥掉 */
export function parseTimelineLines(text) {
    const out = [];
    for (const raw of String(text ?? '').split('\n')) {
        const m = raw.trim().match(LINE_RE);
        if (!m) continue;
        const t = m[4].trim().replace(/^(正文|事件|内容)\s*[:：]?\s*/, '');
        if (t) out.push({ day: Number(m[3]), text: t.length > 80 ? t.slice(0, 80) : t });
    }
    return out;
}
