/**
 * 记账块(任务书第五节):模型每层在回复末尾写一个块,插件解析入库。
 *
 * 块包在 <details class="ihf-ledger"> 里:酒馆显示消息时一律把 class 改成 custom-ihf-ledger
 * (public/scripts/chats.js:1910-1935,没有设置能关),style.css 一条 display:none 就藏住,
 * 不用正则(正则存在 settings.json 里,插件铁律不许碰)。
 * 发给模型时,拦截器把旧楼的块剔掉,不占上下文。
 *
 * 另管旧聊天导入:美梦巡游的 <Narrative_Matrix> 里 [Synopsis] 直接当摘要、[Coordinates] 的 Day 数
 * 拿来起历法;旧 [Keywords] 丢掉不用(模型自由写的动作词氛围词,是 v5.6 召回乱的病根)。
 *
 * 本文件不依赖酒馆,可在 node 里直接测。
 */

export const LEDGER_CLASS = 'ihf-ledger';

const BLOCK_RE = /<details\b[^>]*\bclass\s*=\s*["'][^"']*\bihf-ledger\b[^"']*["'][^>]*>[\s\S]*?<\/details>/gi;
const INNER_RE = /<ihf-ledger>([\s\S]*?)<\/ihf-ledger>/i;
const BARE_RE = /<ihf-ledger>[\s\S]*?<\/ihf-ledger>/gi;

/** 每个模块自己那几行。关掉的模块整段不发,不然模型照写、白占字数,
 *  还会和角色卡自带的好感度那套打架(道长:有些卡自带好感度)。 */
const LEDGER_LINES = {
    always: [
        '摘要: 本层发生了什么,100 字左右,流水账体:谁对谁做了什么,状态怎么变了。只写原文里有的,不补不猜。',
        '专名: 本层出现的人名、地名、物品、组织、作品名、事件名,逗号分隔。不写动作词、氛围词、情绪词。没有正式名字的东西,用原文里最认得出它的叫法(比如歌用首句)。',
        '时间: 本层相对上一层过了多久,只选一种写法:同日 / +1夜 / +3天 / 跳至 4月5日',
    ],
    promise: [
        '约定+: (本层有人许下约定才写这行)谁 对 谁 答应了什么',
        '约定✓: (本层有约定兑现或作废才写这行)约定内容 已兑现 或 已作废',
    ],
    affinity: [
        '好感: (某角色对用户的好感这一层有明显变化才写)角色 +2 因为什么事。平常 1 到 3 分,真正的大事才给 5 以上,最多 10。',
    ],
    arc: [
        '性格: (某角色的性格这一层有明显转变才写)角色 +5 往[正在变成什么样] 因为什么事',
        '破锚: (这一层的事动摇了某角色已经定型的性格才写)角色 起因',
    ],
    emotion: [
        '情绪: (某角色这一层受了重大打击或刺激,整个人进入某种状态才写)角色 暴怒 起因。只能填 低落/暴怒/亢奋/恐惧 四种之一,缓过来了填 平稳。日常的小情绪不写。',
    ],
    fate: [
        '幕后✓: (只有当这一层把上面[这一层必须发生]里那件事写进正文了,才写这行)那一栏的名字 已发生',
        '幕后✓: (这一层正文里出现了[如果这些场面出现了]里的场面、并且照写了那个人的反应,才写这行)名字 编号',
    ],
    item: [
        '物品: (某件要紧东西这一层换了人拿,或者出现、丢了、毁了才写)东西 原主→现主 因为什么事。凭空出现写 →现主,丢了毁了写 原主→。',
        '　　吃的喝的抽的不写。手机、钱包、伞这类随身东西,只在换了人拿或者丢了毁了时才写,平时揣在身上不写。',
    ],
};

/** 同一层里可以写多行的那几个键,只列开着的 */
const MULTI = { affinity: ['好感'], arc: ['性格', '破锚'], emotion: ['情绪'], item: ['物品'] };

/** 按模块开关拼记账要求。modules 缺省全开 */
export function buildLedgerInstruction(modules = {}) {
    const on = k => modules[k] !== false;
    const body = [
        ...LEDGER_LINES.always,
        ...(on('promise') ? LEDGER_LINES.promise : []),
        ...(on('affinity') ? LEDGER_LINES.affinity : []),
        ...(on('arc') ? LEDGER_LINES.arc : []),
        ...(on('emotion') ? LEDGER_LINES.emotion : []),
        ...(on('item') ? LEDGER_LINES.item : []),
        ...(on('fate') ? LEDGER_LINES.fate : []),
    ];
    const multi = Object.entries(MULTI).filter(([k]) => on(k)).flatMap(([, v]) => v);
    if (multi.length) body.push(`下面这几行同一层里可以各写多行,一行一个人:${multi.join('、')}。没有变化的行整行不写。`);
    return [
        '[记账]',
        '正文写完后,在回复最末尾另起一行,照下面的格式输出记账块。它给记忆系统用,不会显示给用户,也不算正文。',
        '',
        `<details class="${LEDGER_CLASS}"><summary>记账</summary>`,
        '<ihf-ledger>',
        ...body,
        '</ihf-ledger>',
        '</details>',
    ].join('\n');
}

/** 全开的那一版,只给测试和"恢复默认"用;运行时一律走 buildLedgerInstruction */
export const DEFAULT_LEDGER_INSTRUCTION = buildLedgerInstruction();

/** 取出块里的正文;没有块返回 null */
export function extractLedger(mes) {
    const m = String(mes ?? '').match(INNER_RE);
    return m ? m[1] : null;
}

/** 把记账块整个剔掉(包括模型漏写 details 外壳、只剩裸标签的情况) */
export function stripLedger(mes) {
    return String(mes ?? '')
        .replace(BLOCK_RE, '')
        .replace(BARE_RE, '')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();
}

const KEYS = ['摘要', '专名', '时间', '约定+', '约定✓', '好感', '性格', '情绪', '破锚', '物品', '幕后✓'];
const KEY_RE = new RegExp('^\\s*(' + KEYS.map(k => k.replace(/[+✓]/g, '\\$&')).join('|') + ')\\s*[:：]\\s*(.*)$');

/** 行首那个人名:去掉标点和"角色"这类占位词。认不出返回空串 */
function cleanName(s) {
    return String(s ?? '').replace(/^[\s"'“”‘’]+|[\s"'“”‘’:：,，。.]+$/g, '').trim();
}

/** 把整数抠出来,认 +5 / -5 / 全角正负号 / 没写号当正数 */
function toDelta(s) {
    const t = String(s ?? '').replace(/[＋]/g, '+').replace(/[－−–—]/g, '-').replace(/\s+/g, '');
    const m = t.match(/^([+-]?)(\d+)$/);
    if (!m) return NaN;
    return (m[1] === '-' ? -1 : 1) * Number(m[2]);
}

/** 去掉"因为""是因为"这类开头的连接词 */
function cleanWhy(s) {
    return String(s ?? '').replace(/^[\s,，:：。、]*(?:是?因为|由于|起因[是为]?)?[\s,，:：]*/, '').trim();
}

/**
 * "角色 +2 因为什么事" → {name, d, why}。
 * 性格那行还可能带 往[变成什么样] / 到[…] / 变得[…],抠出来当 to。
 */
export function parsePersonDelta(line, withTo = false) {
    const s = String(line ?? '').replace(/[｜|]/g, ' ').trim();
    if (!s) return null;
    let m = s.match(/^(.+?)[\s,，:：]*([+\-＋－−–—]\s*\d+)(.*)$/);
    if (!m) m = s.match(/^(.+?)[\s,，:：]+(\d+)[\s,，:：]+(.*)$/);
    if (!m) return null;
    const name = cleanName(m[1]);
    const d = toDelta(m[2]);
    if (!name || !Number.isFinite(d)) return null;
    let rest = m[3] ?? '';
    let to = '';
    if (withTo) {
        const t = rest.match(/(?:往|到|变得|变成|朝着)?\s*[\[【]([^\]】]{1,60})[\]】]/);
        if (t) {
            to = t[1].trim();
            rest = rest.slice(0, t.index) + rest.slice(t.index + t[0].length);
        }
    }
    const why = cleanWhy(rest);
    return withTo ? { name, d, to, why } : { name, d, why };
}

/** "角色 暴怒 起因" → {name, kind, why}。情绪词认不认得交给 core/people.js 判 */
export function parseEmotionLine(line) {
    const s = String(line ?? '').replace(/[｜|]/g, ' ').trim();
    const m = s.match(/^(\S+?)[\s,，:：]+(\S+?)[\s,，:：]+([\s\S]*)$/);
    if (!m) return null;
    const name = cleanName(m[1]);
    if (!name) return null;
    return { name, kind: m[2].trim(), why: cleanWhy(m[3]) };
}

/**
 * "那把红吉他 Char1→Char2 Char1 把琴塞给她抵租金" → {name, from:'Char1', to:'Char2', why}。
 * 凭空出现 "→Char2" 的 from 为空;丢了毁了 "Char1→" 的 to 为空。
 * 没写箭头的当"现在谁拿着":"那把红吉他 Char1 他一直带在身上"。
 */
export function parseItemLine(line) {
    const s = String(line ?? '').replace(/[｜|]/g, ' ').trim();
    if (!s) return null;
    let m = s.match(/^(.+?)[\s,，:：]+(\S*?)(?:→|➔|➝|⇒|->|=>)(\S*?)(?:[\s,，:：]+([\s\S]*))?$/);
    if (m) {
        const name = cleanName(m[1]);
        const from = cleanName(m[2]);
        const to = cleanName(m[3]);
        if (!name || (!from && !to)) return null;
        return { name, from, to, why: cleanWhy(m[4] ?? ''), moved: true };
    }
    m = s.match(/^(.+?)[\s,，:：]+(\S+)[\s,，:：]+([\s\S]+)$/);
    if (!m) return null;
    const name = cleanName(m[1]);
    const to = cleanName(m[2]);
    if (!name || !to) return null;
    return { name, from: '', to, why: cleanWhy(m[3]), moved: false };
}

/** "角色 起因" → {name, why} */
export function parseBreakLine(line) {
    const s = String(line ?? '').replace(/[｜|]/g, ' ').trim();
    const m = s.match(/^(\S+?)[\s,，:：]+([\s\S]*)$/);
    if (!m) return null;
    const name = cleanName(m[1]);
    const why = cleanWhy(m[2]);
    return name && why ? { name, why } : null;
}

/** 专名清洗:按逗号顿号分号拆开,去空、去重、去掉明显不是名字的长句 */
export function splitNames(s) {
    const seen = new Set();
    const out = [];
    for (const raw of String(s ?? '').split(/[,，、;；]/)) {
        const n = raw.trim().replace(/^[\s"'“”‘’]+|[\s"'“”‘’。.]+$/g, '');
        if (!n || n.length > 24 || seen.has(n)) continue;
        seen.add(n);
        out.push(n);
    }
    return out;
}

/**
 * 解析块正文。认不出任何字段返回 null。
 * 摘要允许续行:直到下一个认得的键为止。
 */
export function parseLedger(inner) {
    if (inner == null) return null;
    const fields = { 摘要: [], 专名: [], 时间: [], '约定+': [], '约定✓': [], 好感: [], 性格: [], 情绪: [], 破锚: [], 物品: [], '幕后✓': [] };
    let cur = null;
    for (const line of String(inner).split('\n')) {
        const m = line.match(KEY_RE);
        if (m) {
            cur = m[1];
            fields[cur].push(m[2].trim());
        } else if (cur === '摘要' && line.trim()) {
            fields.摘要[fields.摘要.length - 1] += line.trim();
        }
    }
    const summary = fields.摘要.join(' ').trim();
    const result = {
        summary,
        names: splitNames(fields.专名.join(',')),
        timeRaw: (fields.时间[0] ?? '').trim(),
        promisesMade: fields['约定+'].filter(Boolean),
        promisesSettled: fields['约定✓'].filter(Boolean),
        affinity: fields.好感.map(l => parsePersonDelta(l)).filter(Boolean),
        traits: fields.性格.map(l => parsePersonDelta(l, true)).filter(Boolean),
        emotions: fields.情绪.map(parseEmotionLine).filter(Boolean),
        breaks: fields.破锚.map(parseBreakLine).filter(Boolean),
        items: fields.物品.map(parseItemLine).filter(Boolean),
        fateDone: fields['幕后✓'].map(l => String(l).replace(/[｜|]/g, ' ').replace(/已发生[。.]?$/, '').trim()).filter(Boolean),
    };
    const any = summary || result.names.length || result.timeRaw || result.promisesMade.length
        || result.promisesSettled.length || result.traits.length || result.affinity.length
        || result.emotions.length || result.breaks.length || result.items.length || result.fateDone.length;
    return any ? result : null;
}

/**
 * 旧格式导入:美梦巡游 <Narrative_Matrix>。
 * @returns {{summary:string, dayNo:number|null, timeOfDay:string, place:string}|null}
 */
export function parseLegacyMatrix(mes) {
    const m = String(mes ?? '').match(/<Narrative_Matrix>([\s\S]*?)<\/Narrative_Matrix>/);
    if (!m) return null;
    const body = m[1];
    const syn = body.match(/\[Synopsis\]\s*[:：]\s*([\s\S]*?)\s*(?=\n\s*\[[A-Za-z][A-Za-z ]*\]\s*[:：]|$)/);
    const coord = body.match(/\[Coordinates\]\s*[:：]\s*Day\s*(\d+)\s*(?:[(（]([^)）]*)[)）])?\s*(?:@\s*([^\n]+))?/i);
    const summary = syn ? syn[1].trim() : '';
    if (!summary && !coord) return null;
    return {
        summary,
        dayNo: coord ? Number(coord[1]) : null,
        timeOfDay: coord?.[2]?.trim() ?? '',
        place: coord?.[3]?.trim() ?? '',
    };
}
