/**
 * 人类模块(任务书第二期):好感度、情绪、性格弧、约定账。
 *
 * 关键设计:这几样都不存死值,每次对账从各层的增量重新折算一遍,和剧情日期一个路子
 * (见 core/memory.js reconcile)。删楼、滑 swipe、开分支都不用专门处理,重对一遍账就对了。
 *
 * 模型只写"谁、往哪边动几分、因为什么事",所有加减、封顶、分档、过期、锚定都在这里算。
 * 道长定的口径(9/12):
 *   - LLM 只管 ±,不管运算和最终结果,算错了插件不背锅;每层加减卡上下限,瞎填就卡住。
 *   - 反过来给它看的时候不给数字,只给文字档(见 affinityTierOf / arcStageOf)。
 *   - 破锚之后不复用旧弧,直接封存旧弧、另起一条新弧,好让它看得见性格是怎么一路变过来的。
 *   - 第一条弧的"从"必须是角色描述里的原句,不许模型自己概括(见 memory.origins)。
 *
 * 本文件不依赖酒馆,可在 node 里直接测。
 */

/** 默认设置。放在这里而不是 store.js,是为了让 core/ 在 node 里能独立跑测试 */
export const DEFAULT_PEOPLE = {
    enabled: true,
    /** 四块各自能单独关(道长:有些角色卡自带好感度,两套一起发会打架)。
     *  关掉的那块:记账要求里那几行不发、折算时不认、也不注入;
     *  已经记在各层里的原始行照样留着,回头再打开就又都算出来了。 */
    modules: {
        affinity: true,
        emotion: true,
        arc: true,
        promise: true,
        item: true,
    },
    /** 好感度分档(道长,共用一套)。
     *  档名和文案一律只说"他肯为你投入到什么程度",**不说关系类型**:
     *  发小、上司、仇人之子这些是角色卡给的,一个发小也可以不咸不淡,
     *  写成"陌生""熟人"就和角色卡打架了(9/12 道长当场逮到的)。
     *  语气台词也不在这儿,归性格弧和人设管,不然二十个角色会说出一个味来。
     *  注入时只发当前这一档的文案,不发数字。 */
    affinityTiers: [
        { min: -100, max: -61, name: '恨', text: '不会放过你。会主动找机会让你付代价。' },
        { min: -60, max: -31, name: '敌意', text: '说话带刺,会在别人面前说你坏话,会给你使绊子。' },
        { min: -30, max: -1, name: '反感', text: '能不理就不理。你开口他也懒得好好答。' },
        { min: 0, max: 20, name: '不咸不淡', text: '不会为你改自己的安排。你的事他不上心,顺口答应的也未必往心里记。' },
        { min: 21, max: 40, name: '有好感', text: '肯顺手帮个不费事的忙。心里的事还不跟你讲。' },
        { min: 41, max: 60, name: '肯上心', text: '会主动找你。肯为你花时间、花钱。开始跟你讲他自己的事。' },
        { min: 61, max: 80, name: '放在心上', text: '你的事排在他自己的事前面。会替你出头,会在意你和别人的关系。' },
        { min: 81, max: 95, name: '掏心掏肺', text: '把你当自己的一部分。你出事他会不顾后果。' },
        { min: 96, max: 100, name: '唯一', text: '' },
    ],
    /** 单层加减封顶,模型瞎填就卡在这儿 */
    affinityStep: 10,
    /** 开局好感:auto = 开局扫一遍人设和开场白,让模型给每个人拟一个起点(道长:
     *  "我估计有人会忘记自己加");off = 全员从 0 起步。她随时可以在面板里手改,手改的不会被覆盖。 */
    affinityInit: 'auto',
    arcStep: 10,
    /** 性格弧走满多少算定型 */
    anchorAt: 100,
    /** major = 只在重大事件后(默认);all = 全开,模拟真实世界。
     *  整块关掉用 modules.emotion,填 'off' 也当关掉 */
    emotionMode: 'major',
    /** major 档下同一角色隔够这么多 AI 层才认下一次,免得每层都有情绪反而假 */
    emotionCooldown: 10,
    /** 各情绪持续几个 AI 层,到点自动回平稳 */
    emotionDur: { 低落: 15, 暴怒: 3, 亢奋: 5, 恐惧: 8 },
    /** [重要物品] 最多列这么多件,按最近动过的排 */
    itemMax: 10,
    /** 一律不记的东西:吃的喝的抽的、用完就没的。命中就整行丢掉。
     *  道长:"我和你说没用,该写还是写,除非你直接把那些列做禁词一律不记录。"
     *  两字以上的词:名字里包含就算命中。
     *  单字词:只在去掉量词后**完全等于**它时才算(不然"水"会吃掉"墨水""水晶吊坠")。
     *  宁可漏拦一两样,也别把真道具拦掉,漏了自己往表里加就是。 */
    itemNever: [
        '饭', '菜', '面', '粥', '汤', '水', '茶', '酒', '烟', '糖',
        '咖啡', '饮料', '可乐', '奶茶', '矿泉水', '热水', '凉水', '白酒', '啤酒', '香烟',
        '零食', '巧克力', '面包', '包子', '蛋糕', '外卖', '早饭', '午饭', '晚饭', '宵夜',
        '热汤', '米饭', '炒饭', '盒饭', '剩饭', '汤面', '炒面', '泡面', '方便面', '馒头', '饺子', '点心', '糕点',
        '纸巾', '餐巾', '卫生纸',
    ],
    /** 随身常见物:只有换了人拿、或者丢了毁了才记。单纯出现、单纯拿着一律不记
     *  (道长:"手机这种只有重大事件发生的时候再记录吧,不然手机会一直存在的")。 */
    itemCommon: [
        '手机', '电话', '钱包', '包', '书包', '背包', '伞', '外套', '衣服', '鞋', '帽子', '口罩',
        '眼镜', '车', '自行车', '耳机', '充电器', '笔', '本子', '杯子', '毛巾', '行李箱', '打火机', '钥匙',
    ],
    /** [人物现状] 只写最近这么多层里露过面的人。层数按消息条数算(用户、AI 各算一层),
     *  12 条约等于六个来回,够覆盖当前这场戏,群像卡也不会把二十个人全塞进去 */
    presentFloors: 12,
};

/** 情绪只认这五种。模型写别的词按这张表归位,归不了的整行丢掉 */
const EMOTION_ALIAS = {
    平稳: '平稳', 平静: '平稳', 恢复: '平稳', 正常: '平稳', 缓解: '平稳',
    低落: '低落', 抑郁: '低落', 消沉: '低落', 沮丧: '低落', 失落: '低落', 难过: '低落',
    暴怒: '暴怒', 愤怒: '暴怒', 生气: '暴怒', 震怒: '暴怒', 发火: '暴怒',
    亢奋: '亢奋', 兴奋: '亢奋', 激动: '亢奋', 狂喜: '亢奋',
    恐惧: '恐惧', 害怕: '恐惧', 惊恐: '恐惧', 后怕: '恐惧', 恐慌: '恐惧',
};

export const EMOTION_KINDS = ['低落', '暴怒', '亢奋', '恐惧'];

/** 模型写的情绪词 → 五种里的一种;认不出返回 null */
export function normalizeEmotion(word) {
    const w = String(word ?? '').trim();
    if (!w) return null;
    if (EMOTION_ALIAS[w]) return EMOTION_ALIAS[w];
    // 它可能写"有点低落""陷入暴怒",包含就算
    for (const [k, v] of Object.entries(EMOTION_ALIAS)) if (w.includes(k)) return v;
    return null;
}

/** 好感度分档:只拿档位文案去注入,数字不给模型看 */
export function affinityTierOf(tiers, value) {
    for (const t of tiers) {
        if (value >= t.min && value <= t.max) return t;
    }
    return tiers.at(-1) ?? null;
}

/** 性格弧进度也换成文字说法,同样不给数字 */
export function arcStageOf(value, anchorAt) {
    if (value >= anchorAt) return '已定型';
    const r = value / Math.max(1, anchorAt);
    if (r < 0.15) return '刚起了个头';
    if (r < 0.4) return '走了一小段';
    if (r < 0.7) return '走了一半多';
    if (r < 0.9) return '快走满了';
    return '就差一点';
}

/** 去掉"那把""一碗""三支"这类开头的量词,好让禁词表对得上 */
const QUANT = /^(?:[这那某每][个只支把条件张块份袋盒瓶杯碗根包本台部辆]?|[一二两三四五六七八九十半几]+[个只支把条件张块份袋盒瓶杯碗根包本台部辆]?)/;

function normItem(name) {
    let s = String(name ?? '').trim();
    for (let i = 0; i < 2; i++) s = s.replace(QUANT, '').trim();
    return s || String(name ?? '').trim();
}

/**
 * 这件东西该怎么办:never = 一律不记;common = 只有转手或丢毁才记;ok = 照常记。
 * 多字词包含就算命中;单字词要去掉量词后完全等于它才算,
 * 否则"水"会把"墨水""水晶吊坠"一起拦掉。
 */
export function classifyItem(name, cfg = {}) {
    const s = normItem(name);
    if (!s) return 'never';
    const hit = list => (list ?? []).some(w => (w.length >= 2 ? s.includes(w) : s === w));
    if (hit(cfg.itemNever)) return 'never';
    if (hit(cfg.itemCommon)) return 'common';
    return 'ok';
}

/** 常见物要"真出事"才入账:换了人拿,或者丢了毁了。单纯出现、单纯拿着不算 */
export function isBigMove(it) {
    if (!it?.moved) return false;
    if (!it.to) return true;                       // 丢了、毁了
    return !!it.from && it.from !== it.to;         // 换了人拿
}

function clampStep(d, step) {
    if (!Number.isFinite(d)) return 0;
    return Math.max(-step, Math.min(step, Math.trunc(d)));
}

function emptyPerson(name, start = 0) {
    return {
        name,
        start,
        affinity: start,
        affinityLog: [],
        emotion: null,
        emotionLog: [],
        arcs: [],
        lastSeen: -1,
    };
}

function openArc(person, from, index, day) {
    const arc = {
        seq: person.arcs.length + 1,
        from: from ?? null,
        to: null,
        value: 0,
        state: '进行中',
        openedIndex: index,
        openedDay: day,
        anchoredIndex: null,
        anchoredDay: null,
        brokenIndex: null,
        brokenDay: null,
        breakIf: [],
        brokenBy: '',
        log: [],
    };
    person.arcs.push(arc);
    return arc;
}

/** 当前还没封存的那条弧;一个角色同一时间只有一条活弧,破锚才换下一条 */
export function activeArc(person) {
    const last = person.arcs.at(-1);
    return last && last.state !== '封存' ? last : null;
}

/** 最长公共子串长度。约定配对、幕后漏字检查都用它 */
export function lcsLen(a, b) {
    if (!a || !b) return 0;
    let best = 0;
    const prev = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
        let diag = 0;
        for (let j = 1; j <= b.length; j++) {
            const tmp = prev[j];
            prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
            if (prev[j] > best) best = prev[j];
            diag = tmp;
        }
    }
    return best;
}

const NOISE = /[\s,，。、;；:：!！?？"'“”‘’()（）\[\]【】]/g;

/** 把"约定✓"配回未结约定。配不上返回 null,由调用方单独挂账 */
export function matchPromise(open, settleText) {
    const s = String(settleText ?? '').replace(/已?(兑现|完成|做到|作废|取消|黄了|失效)/g, '').replace(NOISE, '');
    let best = null;
    let bestLen = 0;
    for (const p of open) {
        const t = String(p.text ?? '').replace(NOISE, '');
        const n = lcsLen(s, t);
        if (n > bestLen) { bestLen = n; best = p; }
    }
    return bestLen >= 4 ? best : null;
}

function settleKind(text) {
    return /作废|取消|黄了|失效|没做到|未兑现/.test(String(text ?? '')) ? '已作废' : '已兑现';
}

/**
 * 逐层折算。rows 是 reconcile() 的逐层视图(已带 day),按楼序走一遍。
 * @param {object[]} rows
 * @param {object} cfg config.people
 * @param {Record<string,string>} origins 角色 → 角色描述里的性格原句(memory.origins)
 * @param {Record<string,{breakIf:string[]}>} anchors 锚定记录,键见 anchorKey()
 * @param {Record<string,{value:number, why:string, source:string}>} starts 开局好感,见 memory.affinityStart
 * @returns {{people: Record<string, object>, promises: object[], stats: object}}
 */
export function foldPeople(rows, cfg, origins = {}, anchors = {}, starts = {}) {
    const mod = cfg.modules ?? {};
    const on = k => mod[k] !== false;
    const people = {};
    // 开局好感先垫上,后面各层的加减都是在这个起点上累加
    for (const [name, st] of on('affinity') ? Object.entries(starts) : []) {
        const v = Math.max(-100, Math.min(100, Math.trunc(Number(st?.value) || 0)));
        people[name] = emptyPerson(name, v);
        people[name].startWhy = st?.why ?? '';
        people[name].startSource = st?.source ?? '';
    }
    const promises = [];
    /** 东西名 → {name, holder, lost, log}。holder 为空 = 没了或下落不明 */
    const items = {};
    const stats = { dropped: 0, clamped: 0, anchored: 0, broken: 0, emotionSkipped: 0, itemsBlocked: [] };
    const step = cfg.affinityStep ?? 10;
    const arcStep = cfg.arcStep ?? 10;
    const anchorAt = cfg.anchorAt ?? 100;
    const mode = mod.emotion === false ? 'off' : (cfg.emotionMode ?? 'major');
    const cooldown = cfg.emotionCooldown ?? 10;

    const get = name => (people[name] ??= emptyPerson(name));
    let aiFloor = 0;

    for (const r of rows) {
        const rec = r.record;
        if (r.isUser) continue;
        aiFloor++;

        // 情绪过期:按 AI 层数走,到点自动回平稳,不用模型管
        for (const p of Object.values(people)) {
            if (p.emotion && aiFloor - p.emotion.startFloor >= p.emotion.dur) {
                p.emotionLog.push({ ...p.emotion, endIndex: r.index, reason: '自然消退' });
                p.emotion = null;
            }
        }
        if (!rec) continue;
        // 专名里混着地名、物品、作品名,不能拿它建档,只给已经在册的人更新"最近露面"
        for (const n of rec.names ?? []) if (people[n]) people[n].lastSeen = r.index;

        // 好感
        for (const it of on('affinity') ? rec.affinity ?? [] : []) {
            if (!it.name || !it.why) { stats.dropped++; continue; }
            const p = get(it.name);
            const d = clampStep(it.d, step);
            if (Math.abs(it.d) > step) stats.clamped++;
            if (!d) { stats.dropped++; continue; }
            const before = p.affinity;
            p.affinity = Math.max(-100, Math.min(100, p.affinity + d));
            p.affinityLog.push({ index: r.index, day: r.day, d: p.affinity - before, raw: it.d, why: it.why });
            p.lastSeen = r.index;
        }

        // 性格弧
        for (const it of on('arc') ? rec.traits ?? [] : []) {
            if (!it.name || !it.why) { stats.dropped++; continue; }
            const p = get(it.name);
            p.lastSeen = r.index;
            let arc = activeArc(p);
            if (!arc) arc = openArc(p, origins[it.name] ?? null, r.index, r.day);
            if (arc.state === '锚定') continue; // 锚定之后普通增减不生效,只记进历史给道长看
            const d = clampStep(it.d, arcStep);
            if (Math.abs(it.d) > arcStep) stats.clamped++;
            if (it.to) arc.to = it.to;
            if (!d) { stats.dropped++; continue; }
            const before = arc.value;
            arc.value = Math.max(0, Math.min(anchorAt, arc.value + d));
            arc.log.push({ index: r.index, day: r.day, d: arc.value - before, raw: it.d, why: it.why });
            if (arc.value >= anchorAt && arc.state === '进行中') {
                arc.state = '锚定';
                arc.anchoredIndex = r.index;
                arc.anchoredDay = r.day;
                arc.breakIf = anchors[anchorKey(it.name, arc.seq)]?.breakIf ?? [];
                stats.anchored++;
            }
        }

        // 破锚:封存旧弧,另起一条新弧,新弧的"从"就是旧弧定型时的样子
        for (const it of on('arc') ? rec.breaks ?? [] : []) {
            const p = people[it.name];
            const arc = p ? activeArc(p) : null;
            if (!arc || arc.state !== '锚定') { stats.dropped++; continue; }
            arc.state = '封存';
            arc.brokenIndex = r.index;
            arc.brokenDay = r.day;
            arc.brokenBy = it.why;
            openArc(p, arc.to ?? arc.from, r.index, r.day);
            p.lastSeen = r.index;
            stats.broken++;
        }

        // 情绪。同时只有一种,新的盖掉旧的;"平稳"当场清掉
        for (const it of on('emotion') ? rec.emotions ?? [] : []) {
            const kind = normalizeEmotion(it.kind);
            if (!it.name || !kind) { stats.dropped++; continue; }
            const p = get(it.name);
            p.lastSeen = r.index;
            if (kind === '平稳') {
                if (p.emotion) {
                    p.emotionLog.push({ ...p.emotion, endIndex: r.index, reason: it.why || '缓解' });
                    p.emotion = null;
                }
                continue;
            }
            if (mode === 'off') { stats.emotionSkipped++; continue; }
            if (!it.why) { stats.dropped++; continue; }
            // "只在重大事件后"档:同一角色隔够层数才认下一次,免得每层都有情绪反而假
            if (mode === 'major') {
                const last = p.emotionLog.at(-1);
                const lastStart = p.emotion?.startFloor ?? last?.startFloor ?? -Infinity;
                if (aiFloor - lastStart < cooldown) { stats.emotionSkipped++; continue; }
            }
            if (p.emotion) p.emotionLog.push({ ...p.emotion, endIndex: r.index, reason: '被新情绪盖掉' });
            p.emotion = {
                kind,
                cause: it.why,
                index: r.index,
                day: r.day,
                startFloor: aiFloor,
                dur: cfg.emotionDur?.[kind] ?? 5,
            };
        }

        // 物品账:谁拿着、从谁手里来的、丢没丢
        for (const it of on('item') ? rec.items ?? [] : []) {
            if (!it.name) { stats.dropped++; continue; }
            // 禁词表在代码里拦,不指望提示词(道长:跟它说没用,该写还是写)
            const cls = classifyItem(it.name, cfg);
            if (cls === 'never' || (cls === 'common' && !isBigMove(it))) {
                stats.itemsBlocked.push(it.name);
                continue;
            }
            const cur = (items[it.name] ??= { name: it.name, holder: '', lost: false, log: [] });
            // 模型写的"原主"和账上对不上时以账上为准,它写的那个只当一次转手记下来
            const from = it.from || cur.holder;
            cur.holder = it.to;
            cur.lost = it.moved && !it.to;
            cur.log.push({ index: r.index, day: r.day, from, to: it.to, why: it.why });
        }

        // 约定账
        for (const text of on('promise') ? rec.promisesMade ?? [] : []) {
            if (text) promises.push({ text, index: r.index, day: r.day, state: 'open', settledIndex: null, settledWhy: '' });
        }
        for (const text of on('promise') ? rec.promisesSettled ?? [] : []) {
            if (!text) continue;
            const hit = matchPromise(promises.filter(p => p.state === 'open'), text);
            if (hit) {
                hit.state = settleKind(text);
                hit.settledIndex = r.index;
                hit.settledWhy = text;
            } else {
                promises.push({ text, index: r.index, day: r.day, state: settleKind(text), settledIndex: r.index, settledWhy: text, orphan: true });
            }
        }
    }

    // 走到末尾还没到点的情绪,把剩余层数算出来给面板显示
    for (const p of Object.values(people)) {
        if (p.emotion) p.emotion.left = Math.max(0, p.emotion.dur - (aiFloor - p.emotion.startFloor));
    }
    return { people, promises, items, stats };
}

/** 锚定记录的键:角色 + 这是他第几条弧。弧序是折算出来的,删楼会跟着变,和记录一起自洽 */
export function anchorKey(name, seq) {
    return `${name}#${seq}`;
}

/** 缺破锚条件的已锚定弧,交给 index.js 排队去问模型 */
export function pendingAnchors(people) {
    const out = [];
    for (const p of Object.values(people)) {
        for (const a of p.arcs) {
            if (a.state !== '进行中' && a.anchoredIndex != null && !a.breakIf.length) {
                out.push({ name: p.name, seq: a.seq, arc: a });
            }
        }
    }
    return out;
}

/** 还没拿到角色描述原句的角色(只有第一条弧要,后面的弧"从"是上一条弧定型的样子) */
export function pendingOrigins(people, origins) {
    return Object.values(people)
        .filter(p => p.arcs.length && !p.arcs[0].from && !(p.name in origins))
        .map(p => p.name);
}

/**
 * 物品账要发出去的那几行。按最近动过的取,再按第一次出现的先后排回去,读着才像一条线。
 * 只写现在在谁手里和最后那一下,中间转过几手不发(要查在面板里看)。
 */
export function describeItems(items, max = 10) {
    const all = Object.values(items).filter(it => it.log.length);
    const recent = [...all].sort((a, b) => (b.log.at(-1).index ?? 0) - (a.log.at(-1).index ?? 0)).slice(0, max);
    const keep = new Set(recent.map(it => it.name));
    return all.filter(it => keep.has(it.name)).map(it => {
        const last = it.log.at(-1);
        if (it.lost || !it.holder) return `${it.name}:没了${last.why ? `(${last.why})` : ''}`;
        const from = last.from && last.from !== it.holder ? `,${last.from}给的` : '';
        return `${it.name}:在${it.holder}手里${from}${last.why ? `(${last.why})` : ''}`;
    });
}

/** 开局好感还没估过的时候返回 true。一场聊天只估一次,估完她手改也不会被冲掉 */
export function needsAffinityInit(memory, cfg) {
    if (cfg?.modules?.affinity === false) return false;
    return (cfg?.affinityInit ?? 'auto') === 'auto' && !memory?.affinityInitAt;
}

/** 最近 n 层里露过面的人。[人物现状] 只写这些人,群像卡不会把二十个人全塞进去 */
export function presentNames(rows, n) {
    const out = new Set();
    let seen = 0;
    for (let i = rows.length - 1; i >= 0 && seen < n; i--) {
        const r = rows[i];
        if (r.hidden) continue;
        seen++;
        const rec = r.record;
        if (!rec) continue;
        for (const x of rec.names ?? []) out.add(x);
        for (const x of rec.affinity ?? []) out.add(x.name);
        for (const x of rec.traits ?? []) out.add(x.name);
        for (const x of rec.emotions ?? []) out.add(x.name);
        for (const x of rec.breaks ?? []) out.add(x.name);
    }
    out.delete('');
    return out;
}

/**
 * [人物现状]:进记忆块的那一节。只写在场的人,好感只给档位文案不给数字。
 * @returns {string} 没内容返回空串
 */
export function buildStatusSection({ people, promises, items = {}, rows, cfg, userName = '你' }) {
    const mod = cfg.modules ?? {};
    const on = k => mod[k] !== false;
    let present = presentNames(rows, cfg.presentFloors ?? 12);
    // 开局那几层还没人记过账,谁都"没露面";这时候拿开局估出来的人顶上,免得头几轮一片空白
    if (![...present].some(n => people[n])) {
        const seeded = Object.values(people).filter(p => p.startSource).slice(0, 4).map(p => p.name);
        if (seeded.length) present = new Set(seeded);
    }
    const lines = [];
    for (const name of present) {
        const p = people[name];
        if (!p) continue;
        const bits = [];
        const tier = on('affinity') ? affinityTierOf(cfg.affinityTiers ?? [], p.affinity) : null;
        if (tier) bits.push(`对${userName}:${tier.name}。${tier.text}`);
        const arc = on('arc') ? activeArc(p) : null;
        if (arc?.state === '锚定') {
            bits.push(`性格已定型:${arc.to ?? arc.from ?? '(未命名)'}`);
        } else if (arc && arc.value > 0) {
            const from = arc.from ? `本来${arc.from}` : '';
            const to = arc.to ? `正在变得${arc.to}` : '正在起变化';
            bits.push([from, to, arcStageOf(arc.value, cfg.anchorAt ?? 100)].filter(Boolean).join(','));
        }
        const done = on('arc') ? p.arcs.filter(a => a.state === '封存') : [];
        if (done.length) bits.push(`过去:${done.map(a => `${a.from ?? '?'}→${a.to ?? '?'}(后来因为${a.brokenBy}又变了)`).join(';')}`);
        if (p.emotion) bits.push(`现在${p.emotion.kind}:${p.emotion.cause}`);
        if (bits.length) lines.push(`- ${name}:${bits.join(' / ')}`);
    }
    const open = on('promise') ? promises.filter(p => p.state === 'open') : [];
    if (open.length) {
        lines.push('- 未结的约定:');
        for (const p of open.slice(-8)) lines.push(`  · ${p.text}`);
    }
    const things = on('item') ? describeItems(items, cfg.itemMax ?? 10) : [];
    if (things.length) {
        lines.push('- 要紧的东西在谁手里:');
        for (const t of things) lines.push(`  · ${t}`);
    }
    return lines.length ? ['[人物现状]', ...lines].join('\n') : '';
}

/**
 * 挂在最靠近生成点那几条位置的内容:已定型的性格 + 正在气头上/低落里的人。
 * 具体挂在倒数第几条由 config.injectDepth 决定(默认 1,不能是 0,见 store.js)。
 * 只写在场的人,写不满就不发。
 */
export function buildAnchorPrompt({ people, rows, cfg }) {
    const mod = cfg.modules ?? {};
    const on = k => mod[k] !== false;
    const present = presentNames(rows, cfg.presentFloors ?? 12);
    const lines = [];
    for (const name of present) {
        const p = people[name];
        if (!p) continue;
        const arc = on('arc') ? activeArc(p) : null;
        if (arc?.state === '锚定' && (arc.to || arc.from)) {
            lines.push(`${name}的性格已经定型:${arc.to ?? arc.from}。这是他现在的样子,不要写回从前。`);
            // 这里是整套设计的关键:不问模型"这算不算重大",只让它比对有没有发生下面写死的这几件事
            if (arc.breakIf.length) {
                lines.push(`只有当这一层真的发生了下面这种事,他才会动摇,也只有这时候才写破锚行:${arc.breakIf.map((c, i) => `${i + 1}) ${c}`).join(' ')}`);
            }
        }
        if (p.emotion) {
            lines.push(`${name}现在${p.emotion.kind}。起因:${p.emotion.cause}。这个状态会影响他这一层的一言一行。`);
        }
    }
    return lines.length ? ['[当前状态]', ...lines].join('\n') : '';
}
