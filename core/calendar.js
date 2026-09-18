/**
 * 剧情历法(任务书第七节)。
 *
 * 日期归插件管,不归模型管:模型只报"过了多久",插件往上累加成 Day 数。
 * 记忆文件里存精确的 Day 数;发给 AI 的一律换算成相对当前剧情日期的模糊说法,越远越粗。
 * 故事没交代年份时按平年算月日,只用来推季节,不编年份。
 *
 * 本文件不依赖酒馆,可在 node 里直接测。
 */

const CN = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function cn(n) {
    return n >= 0 && n < CN.length ? CN[n] : String(n);
}

/** "3" / "三" / "十五" / "二十" → 数字,认不出返回 NaN */
export function parseNumber(s) {
    s = String(s ?? '').trim();
    if (/^\d+$/.test(s)) return Number(s);
    if (!s) return NaN;
    if (s === '十') return 10;
    const m = s.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
    if (m) return (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[2] ? CN_DIGIT[m[2]] : 0);
    if (s.length === 1 && s in CN_DIGIT) return CN_DIGIT[s];
    return NaN;
}

function isLeap(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(year, month) {
    return month === 2 && year && isLeap(year) ? 29 : MONTH_DAYS[month - 1];
}

/**
 * 起点日期 + (dayNo - 1) 天 → 月日。year 为 null 时按平年走,另报跨过了几个年头。
 * @param {{year:number|null, month:number, day:number}} start
 * @param {number} dayNo 从 1 起
 */
export function dayToDate(start, dayNo) {
    let year = start.year ?? null;
    let month = start.month;
    let day = start.day + (dayNo - 1);
    let yearsPassed = 0;
    while (day > daysInMonth(year, month)) {
        day -= daysInMonth(year, month);
        month++;
        if (month > 12) { month = 1; yearsPassed++; if (year) year++; }
    }
    while (day < 1) {
        month--;
        if (month < 1) { month = 12; yearsPassed--; if (year) year--; }
        day += daysInMonth(year, month);
    }
    return { year, month, day, yearsPassed };
}

/** 从某个月日往后走到下一个"X月X日"要几天(同一天算 0) */
function daysUntil(from, month, day) {
    let n = 0;
    let cur = { year: from.year ?? null, month: from.month, day: from.day };
    while (!(cur.month === month && cur.day === day)) {
        cur = dayToDate(cur, 2);
        if (++n > 366) return NaN;
    }
    return n;
}

/**
 * 解析记账块里的"时间"一栏。
 * @returns {{days:number, ok:boolean}} ok=false 表示没认出来,按同日处理并留给面板提示
 */
export function parseDelta(raw, currentDate = null) {
    const s = String(raw ?? '').trim();
    if (!s) return { days: 0, ok: false };
    if (/^(同日|同一天|当天|当日|同天|\+?0)$/.test(s)) return { days: 0, ok: true };
    if (/次日|第二天|翌日|隔天|隔日|过了?一夜|\+1夜|一夜之后/.test(s)) return { days: 1, ok: true };

    const jump = s.match(/(?:跳至|跳到|到了|至)\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
    if (jump && currentDate) {
        const n = daysUntil(currentDate, Number(jump[1]), Number(jump[2]));
        if (Number.isFinite(n)) return { days: n, ok: true };
    }

    const NUM = '(\\d+|[一二两三四五六七八九十]+)';
    const units = [
        [new RegExp(NUM + '\\s*年'), 365],
        [new RegExp(NUM + '\\s*个?月'), 30],
        [new RegExp(NUM + '\\s*(?:周|星期|礼拜)'), 7],
        [new RegExp(NUM + '\\s*(?:天|日|夜|晚)'), 1],
    ];
    for (const [re, mul] of units) {
        const m = s.match(re);
        if (m) {
            const n = parseNumber(m[1]);
            if (Number.isFinite(n)) return { days: n * mul, ok: true };
        }
    }
    if (/半个?月/.test(s)) return { days: 15, ok: true };
    return { days: 0, ok: false };
}

const SEASON_DETAIL = ['', '隆冬', '冬末', '初春', '春', '春末', '初夏', '盛夏', '夏末', '初秋', '秋', '深秋', '初冬'];
const SEASON_PLAIN = ['', '冬天', '冬天', '春天', '春天', '春天', '夏天', '夏天', '夏天', '秋天', '秋天', '秋天', '冬天'];

/**
 * 距离 → 模糊说法。越远越粗:三天内说前天,周级说上周,月级说约两个月前,年级说去年冬天。
 * @param {number} diff 当前 Day 减去旧事 Day
 * @param {number|null} oldMonth 旧事所在月份,知道就带季节
 */
export function fuzzyAgo(diff, oldMonth = null) {
    if (!(diff > 0)) return '今天';
    if (diff === 1) return '昨天';
    if (diff === 2) return '前天';
    if (diff === 3) return '三天前';
    if (diff <= 6) return '几天前';
    if (diff <= 13) return '上周';
    if (diff <= 27) return `约${cn(Math.round(diff / 7))}周前`;
    if (diff < 365) {
        const m = Math.max(1, Math.round((diff / 30.4) * 2) / 2);
        const txt = Number.isInteger(m) ? `约${cn(m)}个月前` : `约${cn(Math.floor(m))}个半月前`;
        return oldMonth ? `${txt}·${SEASON_DETAIL[oldMonth]}` : txt;
    }
    const y = Math.round(diff / 365);
    if (!oldMonth) return `约${cn(y)}年前`;
    const head = y === 1 ? '去年' : y === 2 ? '前年' : `${cn(y)}年前的`;
    return head + SEASON_PLAIN[oldMonth];
}

/**
 * 从旧楼里找起点日期:某层同时写着 Day N 和 "X月X日",倒推 Day 1 是哪天。
 * 美梦巡游的状态栏形如 "📅 2月18日·星期日 … DAY 1"。
 * @param {{dayNo:number|null, text:string}[]} floors 按楼序
 * @returns {{year:null, month:number, day:number}|null}
 */
/** 正文里的日期写法:「9月28日」,或者状态栏常见的「📅 09.28」「日期:09/28」(道长 9/18:她的卡都是后一种) */
const DATE_PATTERNS = [
    /(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
    /(?:📅|日期[::]?)\s*(?:\d{4}\s*[./-]\s*)?(\d{1,2})\s*[./-]\s*(\d{1,2})(?!\d)/,
];

export function detectStartDate(floors) {
    for (const f of floors) {
        if (!f.dayNo) continue;
        for (const re of DATE_PATTERNS) {
            const m = String(f.text).match(re);
            if (!m) continue;
            const month = Number(m[1]);
            const day = Number(m[2]);
            if (month < 1 || month > 12 || day < 1 || day > 31) continue;
            return dayToDate({ year: null, month, day }, 2 - f.dayNo);
        }
    }
    return null;
}

const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
function cnNumber(n) {
    if (n <= 10) return CN_NUM[n];
    if (n < 20) return '十' + CN_NUM[n - 10];
    if (n < 100) return CN_NUM[Math.floor(n / 10)] + '十' + (n % 10 ? CN_NUM[n % 10] : '');
    return String(n);
}

/** 有年份写「2026年9月28日」;没年份写「第一年9月28日」,跨了年就是第二年(道长 9/18:年可以留空) */
export function formatDate(d) {
    const year = d.year ? `${d.year}年` : `第${cnNumber(Math.max(1, (d.yearsPassed ?? 0) + 1))}年`;
    return `${year}${d.month}月${d.day}日`;
}
