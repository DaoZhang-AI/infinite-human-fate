/**
 * 命运模块(任务书第三期):NPC 和世界在幕后的活动,以及它们怎么浮出到正文。
 *
 * 和前两期最大的不同:**这一块的状态不是从各层记账里折算出来的,是存死的**。
 * 因为幕后按定义就是正文里没发生的事,聊天记录里没有它的影子,只能由后台推演写进记忆文件。
 * 唯一从记账里来的是 `幕后✓`(模型确认浮出的那件事写进正文了)。
 *
 * 道长定的口径(9/12):
 *   - **按人分栏,不许混成一条流水**,不然模型会糊在一起分不清谁是谁的。另有「共同」栏收多方交汇的事。
 *   - **推演默认写日常,要紧的是例外**。她:"美梦巡游就有世界暗线,吃饭之类的也会写,
 *     反而如果你限制重要事件,才会一直一直影响正文。"日常是稀释剂,也是"原来早有征兆"的材料。
 *   - 每人最多 3 条长期念头;配了「何时会付诸行动」的才可能浮出,没配的只影响他的日常和当前行动。
 *   - **念头原文永不出门**,只发立念头时翻译好的「在场时会做什么」+「界」。
 *     她:"模型分不清暗戳戳勾引和当面 NTR 的区别。"问题不是它藏不住秘密,是它没有强度刻度,
 *     所以每条念头必须配一条具体的界,写不出界的就不发那条行为清单。
 *   - 浮出必须写成**命令**,还要明说这件事还没发生。她:"不然有可能会被 llm 当已经发生的事。"
 *   - 命运只管 NPC 和世界。char 自己的草蛇灰线是另一条,不在这块。
 *
 * 本文件不依赖酒馆,可在 node 里直接测。
 */

import { lcsLen } from './people.js';

export const DEFAULT_FATE = {
    enabled: true,
    /** 最多给几个 NPC 开栏(不含「共同」和「世界」)。推演是一人一次调用,开太多会很慢 */
    maxNpc: 4,
    /** 每人最多几条长期念头 */
    maxIdeas: 3,
    /** 每人「这几天」最多留多少行,超了从最老的丢 */
    logMax: 30,
    /** 每隔这么多层跑一次推演 */
    everyFloors: 9,
    /** 或者剧情日期跳过这么多天也强制跑一次(跨夜之后"当前行动"就馊了) */
    everyDays: 1,
    /** 两次浮出之间至少隔这么多层,免得几拨人一起杀进来 */
    surfaceGap: 12,
    /** 面板「事件影响力」那张图:一件事浮出后,过这么多层影响力归零(只是给玩家看的读数,不进提示词) */
    influenceFloors: 30,
    /** 浮出后连挂这么多层模型还没写进正文,就撤回水下重新攒 */
    surfaceTries: 3,
    /** 世界大事:同时酝酿几件,每隔 worldDueMin~worldDueMax 层必然爆出来一件(一次只爆一件,随机挑)。
     *  道长 9/18:"这个爆点不会推动剧情的,除非你设置一个 X 回合后必然爆料,把这段剧情发给 ai,
     *  不然它就只是一个好看的挂在插件里的东西。" 又说"大事件可以同时有多个,让用户自己填数字,
     *  但是每次触发的只有一个"。世界大事的触发情形都在幕后,正文里永远等不到,所以节奏由插件数层数定。 */
    worldCount: 3,
    worldDueMin: 15,
    worldDueMax: 40,
    /** 要不要单开一栏「世界」记背景板大事(某产品爆火、AI 横空出世)。
     *  网友留言、实时推送那些不归插件管,那是小手机的活。 */
    world: true,
    /** 在场的人要不要发行为清单。道长开,但这一块的验收只能靠她看正文,
     *  演过头就把这个关掉,退回"只发当前行动、念头纯沉水下"。 */
    showActs: true,
    /** 行为清单里要不要加一条"不写心理活动"。默认不管,由卡和预设自己定
     *  (道长:"有些人喜欢看心理活动")。界那一行本来就连心理活动一起管。 */
    banInnerVoice: false,
    /** 好感度那一块被关掉时,界的梯子改用"同场层数"爬,每这么多层升一档。
     *  (道长:"好感度万一被关掉呢",关了好感 affinity 恒为 0,梯子会冻死在第一档) */
    stepEveryFloors: 15,
};

export const COMMON = '共同';
export const WORLD = '世界';

export function emptyFate() {
    return { threads: {}, lastRunFloor: -1, lastRunDay: -1, lastSurfaceFloor: -9999, pending: null, ideasVer: 2 };
}

export function emptyThread(name, kind = 'npc') {
    return { name, kind, now: '', ideas: [], log: [], at: 0 };
}

/**
 * 写不出具体内容的套话。跟 core/prompts.js parseBreakIf 一个路子:
 * 「注意分寸」「等时机成熟」这种写了等于没写,留着反而有害。
 */
const VAGUE = /^(?:.{0,4}(?:注意|把握|掌握|保持)?(?:分寸|尺度|度|界限)|.{0,4}时机(?:成熟|合适|到了)|适度.{0,4}|不过分.{0,4}|视情况.{0,6}|看情况.{0,6}|随机应变.{0,4}|合适的时候.{0,6})[。.]?$/;

export function isVague(s) {
    const t = String(s ?? '').trim().replace(/[。.]$/, '');
    return !t || t.length < 6 || VAGUE.test(t);
}

/** 一条念头能不能浮出:要有写得具体的「何时会付诸行动」 */
export function canSurface(idea) {
    return idea?.state === '进行中' && !!idea.actWhen && !isVague(idea.actWhen);
}

/** 界的各档,带上每档对应的好感门槛。认不出档位名的当最低档(门槛 -100) */
export function limitSteps(idea, tiers = []) {
    const list = Array.isArray(tiers) ? tiers : [];   // 防 .map(actsSendable) 这种把下标当档位表传进来
    return (idea?.limits ?? [])
        .filter(s => s?.text && !isVague(s.text))
        .map(s => {
            const t = list.find(x => x.name === s.tier);
            return { tier: s.tier, min: t ? t.min : -100, text: s.text };
        })
        .sort((a, b) => a.min - b.min);
}

/**
 * 按当前好感挑出这一刻的天花板。
 * 界是梯子不是死线(道长定的:暧昧是一步步升级的,写死一根线等于让这个人一辈子停在原地),
 * 好感涨上去,他自然往上爬;好感不动,他就停在原地。每一刻仍然有硬天花板。
 */
export function pickLimit(idea, affinity = 0, tiers = []) {
    const steps = limitSteps(idea, tiers);
    if (!steps.length) return null;
    let cur = steps[0];
    for (const s of steps) {
        if (affinity >= s.min) cur = s;
    }
    return cur;
}

/**
 * 好感度那块被关掉时的备用绳子(道长:"好感度万一被关掉呢")。
 * 关了好感,affinity 永远是 0,梯子会冻死在第一档,等于又把死线那个毛病放回来。
 * 退而求其次用**这个人跟主角同场过多少层**来爬:粗糙,但单调递增,而且完全不靠被关掉的那块。
 * 注意这条路只升不降,不像好感那样会退档,因为"相处过多少层"本来就退不回去。
 */
export function pickLimitByFloors(idea, floors = 0, tiers = [], stepEvery = 15) {
    const steps = limitSteps(idea, tiers);
    if (!steps.length) return null;
    const idx = Math.min(steps.length - 1, Math.floor(floors / Math.max(1, stepEvery)));
    return steps[idx];
}

/** 这一刻该发哪一档。好感度开着就按好感,关着就按同场层数 */
export function currentLimit(idea, { affinity = 0, floors = 0, tiers = [], useAffinity = true, stepEvery = 15 } = {}) {
    return useAffinity ? pickLimit(idea, affinity, tiers) : pickLimitByFloors(idea, floors, tiers, stepEvery);
}

/** 某个人跟主角同场过多少个 AI 层。不依赖好感度那一块,关了它也照样算得出来 */
export function coPresence(rows, name) {
    let n = 0;
    for (const r of rows ?? []) {
        if (r.isUser || r.hidden || !r.record) continue;
        const rec = r.record;
        const hit = (rec.names ?? []).includes(name)
            || (rec.affinity ?? []).some(x => x.name === name)
            || (rec.traits ?? []).some(x => x.name === name)
            || (rec.emotions ?? []).some(x => x.name === name);
        if (hit) n++;
    }
    return n;
}

/** 一条念头的行为清单能不能发:要有至少一档写得具体的「界」,没有界就只剩强度失控的行为(道长) */
export function actsSendable(idea, tiers = []) {
    return idea?.state === '进行中' && idea.acts?.length > 0 && limitSteps(idea, tiers).length > 0;
}

/** 该不该跑推演了:隔够层数,或者剧情跳过了一天(跨夜之后当前行动就馊了) */
export function needsSurvey(fate, cfg, floor, day) {
    if (cfg?.enabled === false) return false;
    if (fate.lastRunFloor < 0) return true;
    if (floor - fate.lastRunFloor >= (cfg.everyFloors ?? 9)) return true;
    return day - fate.lastRunDay >= (cfg.everyDays ?? 1);
}

/** 这一轮允许浮出吗:上一条还挂着就不许,离上次浮出不够远也不许 */
export function canSurfaceNow(fate, cfg, floor) {
    if (fate.pending) return false;
    return floor - (fate.lastSurfaceFloor ?? -9999) >= (cfg.surfaceGap ?? 12);
}

/** 下一件世界大事在第几层爆:从 floor 往后 [worldDueMin, worldDueMax] 里随机一个 */
export function nextWorldFloor(floor, cfg = {}, rand = Math.random) {
    const lo = Math.max(1, Number(cfg.worldDueMin) || 15);
    const hi = Math.max(lo, Number(cfg.worldDueMax) || 40);
    return floor + lo + Math.floor(rand() * (hi - lo + 1));
}

/**
 * 该不该爆一件世界大事了。到点、没别的事挂着、离上次浮出够远,就从正在酝酿的里随机挑一件。
 * 返回要爆的那件在 ideas 里的下标,不该爆返回 -1。
 * 注意这里不推进下一次的时间:要等这件真写进正文(settlePending 结案)才排下一件,
 * 模型那层没写出来,过浮出间隔会再挂一次,所以是"必然"爆出来。
 */
export function pickWorldIdea(fate, thread, floor, cfg = {}, rand = Math.random) {
    if (thread?.kind !== 'world' || !Number.isFinite(fate.worldNextFloor) || floor < fate.worldNextFloor) return -1;
    if (!canSurfaceNow(fate, cfg, floor)) return -1;
    const live = (thread.ideas ?? []).map((it, i) => (it.state === '进行中' && it.text ? i : -1)).filter(i => i >= 0);
    if (!live.length) return -1;
    return live[Math.floor(rand() * live.length)];
}

/** 往某人栏里追加几行日常,超了从最老的丢 */
export function pushLog(thread, day, lines, max = 30) {
    for (const text of lines) {
        if (text) thread.log.push({ day, text });
    }
    if (thread.log.length > max) thread.log.splice(0, thread.log.length - max);
}

/* ---------------- 注入 ---------------- */

/**
 * [他们此刻各自在干嘛]:一人一行,全员发(道长)。
 * 治的是"用户一打电话,那个 NPC 秒接还全程配合"。后面那句硬话必须跟着,
 * 否则模型会主动把这些人拉进场。
 */
export function buildNowPrompt(fate, cfg) {
    const rows = Object.values(fate.threads ?? {})
        .filter(t => t.kind !== 'common' && t.now)
        .slice(0, (cfg.maxNpc ?? 4) + 1);
    if (!rows.length) return '';
    return [
        '[他们此刻各自在干嘛]',
        ...rows.map(t => (t.kind === 'world' ? `外面在传:${t.now}` : `${t.name}:${t.now}`)),
        '',
        '这几个人现在不在场。别主动把他们写进来。',
        '只有剧情真的找上他们时(打电话、找上门、正好路过),才照这里写他们的反应。',
    ].join('\n');
}

/**
 * [在场的人会怎么做]:只发立念头时翻译好的行为清单和界,念头原文一个字都不出门。
 * 给刻度不给禁令,这是好感度分档那套验证过的写法。
 */
export function buildActsPrompt(fate, presentNames, cfg, ctx = {}) {
    if (cfg.showActs === false) return '';
    const { people = {}, tiers = [], rows = [], useAffinity = true } = ctx;
    const stepEvery = cfg.stepEveryFloors ?? 15;
    const lines = [];
    for (const name of presentNames) {
        const t = fate.threads?.[name];
        if (!t || t.kind !== 'npc') continue;
        const affinity = people[name]?.affinity ?? 0;
        const floors = useAffinity ? 0 : coPresence(rows, name);
        for (const idea of t.ideas ?? []) {
            if (!actsSendable(idea, tiers)) continue;
            const step = currentLimit(idea, { affinity, floors, tiers, useAffinity, stepEvery });
            lines.push(`${name}在场时:`);
            for (const a of idea.acts) lines.push(`- ${a}`);
            lines.push(`现在能到这一步为止:${step.text}。再往前不许。`);
            // "有别人在时"照这个人的性格写,不是插件写死的
            // (道长定的:本来就脸皮厚的人,当着别人的面也照样来,不能一刀切成"退一档")
            if (idea.inPublic) lines.push(`旁边有别人在的时候:${idea.inPublic}`);
        }
    }
    if (!lines.length) return '';
    if (cfg.banInnerVoice) lines.push('不写他们的心理活动,只写做了什么、说了什么。');
    return ['[在场的人会怎么做]', ...lines].join('\n');
}

/**
 * [这一层必须发生]:浮出。三个要件缺一不可(道长):
 * 必须做什么 + 明说还没发生 + 为什么是现在。
 * 第三件直接从这条线的日常日志里取,那就是草蛇灰线,不用另编。
 */
export function buildSurfacePrompt(pending) {
    if (!pending?.what) return '';
    if (pending.kind === 'world') {
        const w = ['[这一层必须发生:外面的一件事爆出来了]', pending.what];
        if (pending.how) w.push(`怎么捅出来的:${pending.how}`);
        w.push('',
            '这件事到这一层才传开,不是回顾。由你在这一层把它写出来:',
            '- 照这个世界观选一条路让它传到主角这边:新闻、推送、广播、公告、邸报、有人在饭桌上或路上提起,都行,别写错时代。',
            '- 再写它对眼前的人和事有什么影响:谁听到了什么反应、原本的安排要不要变。',
            '- 不许一笔带过,至少要有一个在场的人对它有反应。',
            '写完之后,在记账块里写一行:幕后✓: 世界 已发生');
        return w.join('\n');
    }
    const out = ['[这一层必须发生]', pending.what, '', '这件事还没有发生,由你在这一层把它写出来,不是回顾。'];
    if (pending.why) out.push(`他为什么挑这时候:${pending.why}`);
    if (pending.also) out.push(`他同时还惦记着:${pending.also}`);
    out.push(`写完之后,在记账块里写一行:幕后✓: ${pending.name} 已发生`);
    return out.join('\n');
}

/** 把一条线的日常压成"先前的迹象",给浮出那一刻当草蛇灰线用 */
export function recentSigns(thread, n = 4) {
    return (thread?.log ?? []).slice(-n).map(l => l.text).join('、');
}

/** 他同时还惦记着的别的念头(多槽位白捡的:一条念头时根本写不出这句) */
export function otherWants(thread, exceptIdx) {
    return (thread?.ideas ?? [])
        .filter((it, i) => i !== exceptIdx && it.state === '进行中' && it.text)
        .map(it => it.text)
        .join(';');
}

/**
 * 造一条待浮出记录。注意 what 写成命令句,不是陈述句。
 */
export function makePending(thread, ideaIdx, floor) {
    const idea = thread.ideas[ideaIdx];
    if (!idea) return null;
    if (thread.kind === 'world') {
        return { name: thread.name, kind: 'world', ideaIdx, what: idea.text, how: idea.actWhen, sinceFloor: floor, tries: 0 };
    }
    return {
        name: thread.name,
        ideaIdx,
        what: `${thread.name}${idea.actWhen}。`,
        why: recentSigns(thread),
        also: otherWants(thread, ideaIdx),
        sinceFloor: floor,
        tries: 0,
    };
}

/**
 * 每层收尾:模型写了 `幕后✓` 就结案,连挂够次数还没写就撤回水下重新攒。
 * @returns {{cleared:boolean, dropped:boolean}}
 */
export function settlePending(fate, cfg, floor, confirmedNames) {
    const p = fate.pending;
    if (!p) return { cleared: false, dropped: false };
    const hit = (confirmedNames ?? []).some(n => n && (n.includes(p.name) || p.name.includes(n)));
    if (hit) {
        const idea = fate.threads[p.name]?.ideas?.[p.ideaIdx];
        if (idea) {
            idea.state = '了了';
            idea.surfacedAt = floor;
        }
        fate.pending = null;
        fate.lastSurfaceFloor = floor;
        return { cleared: true, dropped: false };
    }
    if (floor > p.sinceFloor) {
        p.tries = floor - p.sinceFloor;
        if (p.tries >= (cfg.surfaceTries ?? 3)) {
            fate.pending = null;
            fate.lastSurfaceFloor = floor;
            return { cleared: false, dropped: true };
        }
    }
    return { cleared: false, dropped: false };
}

/**
 * 弱兜底:还没轮到浮出的那件事,已经被写进正文了。
 *
 * 第一版是"把念头拆成词去正文里找",在一个乐队故事里「乐队」「主唱」天天出现,会天天误报,
 * 那样的提醒等于没有。改成**拿「何时会付诸行动」整句去比最长公共子串**:
 * 它描述的是一件具体的、此刻还不该发生的事,重合够长就说明那件事真被写出来了。
 * 只提醒不拦(改不了正文),让道长自己决定要不要回退重 roll。
 */
/**
 * baseline = 卡的设定和更早的正文。9/18 误报的教训:一张卡里「那部旧手机响了,他接起来」天天出现,
 * 触发条件恰好也这么写,于是每层都报"已经写进正文了"。
 * 所以只有最新正文和触发条件的重合,**比设定和旧正文里本来就有的重合多出 margin 字以上**,才算真漏了。
 */
export function leakCheck(fate, text, min = 8, baseline = '', margin = 4) {
    const strip = s => String(s ?? '').replace(/[\s,，。、;；:：!！?？"'“”‘’()（）…—]/g, '');
    const body = strip(text);
    const base = strip(baseline);
    const hits = [];
    if (body.length < min) return hits;
    for (const t of Object.values(fate.threads ?? {})) {
        (t.ideas ?? []).forEach((idea, i) => {
            if (idea.state !== '进行中' || !idea.actWhen) return;
            // 已经排队等浮出的那条不算漏,它本来就该写出来
            if (fate.pending && fate.pending.name === t.name && fate.pending.ideaIdx === i) return;
            const want = strip(idea.actWhen);
            const n = lcsLen(want, body);
            if (n < min) return;
            if (base && n < lcsLen(want, base) + margin) return;
            hits.push({ name: t.name, idea: idea.text, actWhen: idea.actWhen, overlap: n });
        });
    }
    return hits;
}
