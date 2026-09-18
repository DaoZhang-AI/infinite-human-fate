/**
 * 记忆文件的数据结构 + 逐层对账。
 *
 * 对账是幂等的:每次都按当前聊天从头走一遍,认得的楼用旧记录,新楼解析记账块或导入旧格式,
 * 两样都没有的 AI 楼进待补名单。删楼、滑 swipe、开分支都不需要专门处理,重对一遍账就对了。
 *
 * 剧情日期不存死在记录上,每次按楼序现算:有绝对 Day 的楼(旧格式导入、面板手动校正)重置计数,
 * 其余楼按记账块里的"时间"往上累加。这样删掉中间一层,后面的日期自动跟着变。
 *
 * 本文件不依赖酒馆,可在 node 里直接测。
 */

import { fingerprint } from './fingerprint.js';
import { extractLedger, parseLedger, parseLegacyMatrix } from './ledger.js';
import { dayToDate, detectStartDate, parseDelta } from './calendar.js';
import { DEFAULT_PEOPLE, foldPeople } from './people.js';
import { emptyFate } from './fate.js';

export const MEMORY_FORMAT = 1;

export function emptyMemory(chatId) {
    return {
        format: MEMORY_FORMAT,
        chatId,
        created: Date.now(),
        updated: 0,
        rev: 0,
        calendar: { start: null },
        floors: {},
        /** 段键 → 段,见 core/timeline.js */
        timeline: {},
        /** 角色 → 角色描述里那句性格原句(第一条性格弧的"从",不许模型自己概括) */
        origins: {},
        /** 锚定记录,键 = core/people.js anchorKey();存性格定型时问出来的破锚条件 */
        anchors: {},
        /** 角色 → 开局好感 {value, why, source}。source: 'llm' 是开局估的,'manual' 是道长手改的 */
        affinityStart: {},
        /** 第三期命运:幕后各栏。这一块不是折算出来的,是后台推演写进来存死的,见 core/fate.js */
        fate: emptyFate(),
    };
}

/** 补记账:模型回的记账块 → 记录。模型漏写外层标签也认;没有摘要算失败 */
export function recordFromLedgerText(text, source = 'backfill') {
    const ledger = parseLedger(extractLedger(text) ?? text);
    if (!ledger?.summary) return null;
    return {
        source,
        summary: ledger.summary,
        names: ledger.names,
        timeRaw: ledger.timeRaw,
        abs: null,
        promisesMade: ledger.promisesMade,
        promisesSettled: ledger.promisesSettled,
        traits: ledger.traits,
        affinity: ledger.affinity,
        emotions: ledger.emotions,
        breaks: ledger.breaks,
        items: ledger.items,
        fateDone: ledger.fateDone,
        at: Date.now(),
    };
}

/** 从一层 AI 消息里抽记录:优先新记账块,其次旧 Narrative_Matrix */
export function recordFromMessage(mes) {
    const ledger = parseLedger(extractLedger(mes));
    if (ledger) {
        return {
            source: 'ledger',
            summary: ledger.summary,
            names: ledger.names,
            timeRaw: ledger.timeRaw,
            abs: null,
            promisesMade: ledger.promisesMade,
            promisesSettled: ledger.promisesSettled,
            traits: ledger.traits,
            affinity: ledger.affinity,
            emotions: ledger.emotions,
            breaks: ledger.breaks,
            items: ledger.items,
            fateDone: ledger.fateDone,
            at: Date.now(),
        };
    }
    const legacy = parseLegacyMatrix(mes);
    if (legacy) {
        return {
            source: 'import',
            summary: legacy.summary,
            names: [],
            timeRaw: '',
            abs: legacy.dayNo,
            place: legacy.place,
            timeOfDay: legacy.timeOfDay,
            at: Date.now(),
        };
    }
    return null;
}

/**
 * 按当前聊天对账。会往 memory.floors 里补新记录(原地修改),返回逐层视图。
 * @param {object} memory
 * @param {{mes:string, is_user:boolean, is_system?:boolean}[]} chat 酒馆的 chat 数组或 jsonl 里的消息
 * @param {object} [peopleCfg] config.people
 * @returns {{rows: object[], added: number, pending: number[], lastDay: number, start: object|null, people: object, promises: object[]}}
 */
export function reconcile(memory, chat, peopleCfg = DEFAULT_PEOPLE) {
    const rows = [];
    let added = 0;
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        const isUser = !!m.is_user;
        const fp = fingerprint(m.mes, isUser);
        let rec = memory.floors[fp] ?? null;
        if (!rec && !isUser) {
            rec = recordFromMessage(m.mes);
            if (rec) {
                memory.floors[fp] = rec;
                added++;
            }
        }
        rows.push({ index: i, fp, isUser, hidden: !!m.is_system, record: rec, day: null, date: null });
    }

    // 增量是"相对上一层 AI 楼",所以只要前面有过 AI 楼(哪怕它没记账,比如开场白),这层的增量就算数。
    // 只有全场第一层 AI 楼的增量没有参照,不算。
    const countDays = start => {
        let day = 1;
        let seenAi = false;
        for (const r of rows) {
            const rec = r.record;
            if (!r.isUser) {
                if (rec && Number.isFinite(rec.abs) && rec.abs > 0) {
                    day = rec.abs;
                } else if (rec && seenAi) {
                    const cur = start ? dayToDate(start, day) : null;
                    day += parseDelta(rec.timeRaw, cur).days;
                }
                seenAi = true;
            }
            r.day = day;
            r.date = start ? dayToDate(start, day) : null;
        }
        return day;
    };

    // 历法:起点日期没定(或者是编的)就从正文里找。先数一遍天数,找到的日期按那一层是第几天倒推起点
    let day = countDays(memory.calendar.start);
    if (!memory.calendar.start || memory.calendar.start.made) {
        // 先只信写明了「Day N」的楼(老规矩,最准);一层都没有才退而用数出来的天数
        const found = detectStartDate(rows.map(r => ({ dayNo: r.record?.abs ?? null, text: chat[r.index].mes })))
            ?? detectStartDate(rows.map(r => ({ dayNo: r.isUser ? null : r.day, text: chat[r.index].mes })));
        if (found) {
            memory.calendar.start = { year: null, month: found.month, day: found.day };
        } else if (!memory.calendar.start) {
            // 正文里一个日期都没有:编一个(道长 9/18:如果没有就编造一个),按开局那天的现实月日,标上是编的
            const first = new Date(chat[0]?.send_date ?? NaN);
            const ok = !Number.isNaN(first.getTime());
            memory.calendar.start = { year: null, month: ok ? first.getMonth() + 1 : 1, day: ok ? first.getDate() : 1, made: true };
        }
        day = countDays(memory.calendar.start);
    }
    const start = memory.calendar.start;

    const pending = rows.filter(r => !r.isUser && !r.hidden && !r.record).map(r => r.index);
    // 好感、性格弧、情绪、约定账和日期一样,都是按楼序现折算出来的,不存死值
    const folded = peopleCfg?.enabled === false
        ? { people: {}, promises: [], stats: {} }
        : foldPeople(rows, peopleCfg, memory.origins ?? {}, memory.anchors ?? {}, memory.affinityStart ?? {});
    return { rows, added, pending, lastDay: day, start, ...folded };
}
