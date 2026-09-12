/**
 * 三级结构(任务书第四节、第九节):发给模型之前,把聊天重新组装成
 *   正文区(最近 N 层原文) + 摘要区(再往前 M 层,每层一段摘要) + 更早(时间线)
 * 摘要区和更早的楼从副本里删掉,换成一个记忆块插在正文区之前,块头是记忆层级提示词。
 * 块内从上到下:时间线 → 回忆 → 近期摘要,越往下越新,紧接着就是正文区。
 *
 * 更早区里压好时间线的整段用时间线行,还没压的楼先拿摘要顶,按字数上限从新往旧取。
 *
 * 本文件不依赖酒馆,可在 node 里直接测。
 */

import { dayToDate, formatDate, fuzzyAgo } from './calendar.js';
import { stripLedger } from './ledger.js';

/**
 * 拦截器拿到的副本已经跑过正则(public/script.js:4447),没法按正文指纹认楼。
 * 副本是 {...原消息, mes} 展开出来的(public/script.js:4465),发送时间、名字、是否用户都原样保留,
 * 按顺序对齐回原文下标。对不上的记 -1,组装时原样保留、不动它。
 * @returns {number[]} 与 core 等长
 */
export function alignCoreToRaw(core, raw) {
    const out = [];
    let j = 0;
    for (const item of core) {
        let found = -1;
        for (let t = j; t < raw.length; t++) {
            const r = raw[t];
            if (r.send_date === item.send_date && !!r.is_user === !!item.is_user && r.name === item.name) {
                found = t;
                j = t + 1;
                break;
            }
        }
        out.push(found);
    }
    return out;
}

/**
 * 分区。presentIdx 是本次要发给模型的楼(原文下标,按楼序,隐藏楼已被酒馆滤掉)。
 * 层数按消息条数算,用户和 AI 各算一层。
 */
export function planZones(presentIdx, rows, tier) {
    const n = presentIdx.length;
    let bodyStart = Math.max(0, n - tier.bodyFloors);
    // 正文区第一条若是 AI 回复,把它前面那句用户发言也带上,免得回复没头没尾
    if (bodyStart > 0 && !rows[presentIdx[bodyStart]].isUser && rows[presentIdx[bodyStart - 1]].isUser) bodyStart--;
    const summaryStart = Math.max(0, bodyStart - tier.summaryFloors);
    return {
        body: presentIdx.slice(bodyStart),
        summary: presentIdx.slice(summaryStart, bodyStart),
        older: presentIdx.slice(0, summaryStart),
    };
}

/** 没记账的楼的兜底摘录:去掉记账块、折叠块、代码块、标签,只留开头一小段 */
export function plainExcerpt(mes, max = 150) {
    const s = stripLedger(mes)
        .replace(/<details[\s\S]*?<\/details>/gi, '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 连续同一个时间标签的行归到一组,标签只写一次,省字也好读 */
function groupByLabel(items) {
    const out = [];
    let cur = null;
    for (const it of items) {
        if (it.label !== cur) {
            out.push(`〔${it.label}〕`);
            cur = it.label;
        }
        out.push(`- ${it.text}`);
    }
    return out.join('\n');
}

const LEVELS = [
    ['body', v => `[近期正文]:最新 ${v.N} 层对话 = 当前现实。与任何旧信息冲突时以正文为准。只回应最新输入。文风、语气以这里为准。`],
    ['status', () => '[人物现状]:当前关系、性格当前状态、未结约定 = 硬事实。与回忆冲突时以此为准。'],
    ['summary', v => `[近期摘要]:再往前 ${v.M} 层的摘要 = 短期记忆。用于维持物品、伤势、未竟因果的连贯。`],
    ['recall', () => '[回忆]:被召回的旧楼层 = 闪回。仅作知识引用(旧账、伏笔、承诺),禁止对过去的动作做物理反应,不模仿其中的文风;其中的关系状态是当时的,不是现在的。'],
    ['timeline', () => '[时间线]:更早的事件脉络 = 长期记忆。把握事件先后。'],
    ['archive', () => '[剧情档案馆]:梦游助手大总结 <Story_Archive> = 长期记忆。把握人物基调与关系流变曲线。'],
];

/** 记忆层级提示词:只列这一轮真有的层,编号从 1 连续排 */
export function buildLevels(present, vars) {
    const lines = LEVELS.filter(([key]) => present[key]).map(([, fn], i) => `${i + 1}. ${fn(vars)}`);
    return ['[记忆层级]', '信息优先级(由高到低):', ...lines].join('\n');
}

/**
 * 拼记忆块。
 * @param {object} p
 * @param {object[]} p.rows reconcile() 的逐层视图
 * @param {{mes:string}[]} p.chat 原文
 * @param {{body:number[], summary:number[], older:number[]}} p.zones
 * @param {number} p.lastDay
 * @param {{bodyFloors:number, summaryFloors:number, memoryChars:number}} p.tier
 * @param {boolean} p.archive 这一轮要不要带"剧情档案馆"那一行
 * @param {string} [p.status] [人物现状] 那一节,见 core/people.js buildStatusSection
 * @param {{row:object, text:string}[]} [p.recall] 召回结果(已按楼序);被召回的楼不再在摘要区里重复
 * @param {{rows:object[], lines:{day:number, text:string}[]|null}[]} [p.timeline] 更早区的段,压好的带 lines
 * @param {{month:number, day:number}|null} [p.start] 起点日期,给时间线行推季节用
 * @returns {{text:string, stats:object}}
 */
export function buildMemoryBlock({ rows, chat, zones, lastDay, tier, archive, recall = [], timeline = [], start = null, status = '' }) {
    const label = r => fuzzyAgo(lastDay - r.day, r.date?.month ?? null);
    const lineLabel = l => fuzzyAgo(lastDay - l.day, start ? dayToDate(start, l.day).month : null);
    const textOf = r => (r.record?.summary ? r.record.summary : `(未记账)${plainExcerpt(chat[r.index].mes)}`);
    const recalled = new Set(recall.map(x => x.row.index));

    const summaryRows = zones.summary.map(i => rows[i]).filter(r => !r.isUser);
    const summaryItems = summaryRows.filter(r => !recalled.has(r.index)).map(r => ({ label: label(r), text: textOf(r) }));
    const summaryText = summaryItems.length ? groupByLabel(summaryItems) : '';

    const recallText = recall.map(x => `〔回忆·${label(x.row)}〕\n${x.text}`).join('\n\n');

    // 更早:压好的整段用时间线行,没压的楼拿摘要顶,没记账的老楼跳过。按楼序排成单元,从新往旧按字数上限取
    const covered = new Map();
    for (const ch of timeline) if (ch.lines?.length) for (const r of ch.rows) covered.set(r.index, ch);
    const units = [];
    const emitted = new Set();
    for (const i of zones.older) {
        const r = rows[i];
        if (r.isUser) continue;
        const ch = covered.get(r.index);
        if (ch) {
            if (!emitted.has(ch)) {
                emitted.add(ch);
                units.push({ kind: 'line', items: ch.lines.map(l => ({ label: lineLabel(l), text: l.text })) });
            }
        } else if (r.record?.summary && !recalled.has(r.index)) {
            units.push({ kind: 'summary', items: [{ label: label(r), text: r.record.summary }] });
        }
    }
    let budget = Math.max(0, tier.memoryChars - summaryText.length);
    const picked = [];
    for (let k = units.length - 1; k >= 0; k--) {
        const cost = units[k].items.reduce((s, it) => s + it.text.length + 4, 0);
        if (cost > budget) break;
        budget -= cost;
        picked.unshift(units[k]);
    }
    const olderItems = picked.flatMap(u => u.items);
    const olderText = olderItems.length ? groupByLabel(olderItems) : '';
    const timelineLines = picked.filter(u => u.kind === 'line').reduce((s, u) => s + u.items.length, 0);
    const fallbackSummaries = picked.filter(u => u.kind === 'summary').length;

    const present = {
        body: true,
        status: !!status,
        summary: !!summaryText,
        recall: !!recallText,
        timeline: !!olderText,
        archive: !!archive,
    };
    const last = rows.at(-1);
    const parts = [
        '<记忆>',
        buildLevels(present, { N: zones.body.length, M: zones.summary.length }),
        last?.date ? `当前剧情日期:${formatDate(last.date)}(Day${lastDay})。下面方括号里的时间都是相对今天说的。` : `当前剧情日期:Day${lastDay}。下面方括号里的时间都是相对今天说的。`,
    ];
    if (olderText) parts.push('', '[时间线]', olderText);
    if (recallText) parts.push('', '[回忆]', '以下是过去的片段,不是现在正在发生的事。', recallText);
    if (summaryText) parts.push('', '[近期摘要]', summaryText);
    // 人物现状放最后,紧挨着正文区,是这一块里优先级最高的硬事实
    if (status) parts.push('', status);
    parts.push('</记忆>');
    const text = parts.join('\n');

    return {
        text,
        stats: {
            body: zones.body.length,
            summary: summaryRows.length,
            summaryPending: summaryRows.filter(r => !r.record?.summary).length,
            older: units.length,
            olderSent: picked.length,
            olderDropped: units.length - picked.length,
            timelineLines,
            fallbackSummaries,
            timelineFallback: fallbackSummaries > 0,
            recall: recall.length,
            recallChars: recallText.length,
            statusChars: status.length,
            chars: text.length,
        },
    };
}
