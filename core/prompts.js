/**
 * 插件自己要模型干的两件活:补记账、压时间线。只做记录,不写故事。
 * 规矩照任务书第五、六节;时间线那几条是道长逐条改定的(一行一件事、不带细节、名字要具体、不编)。
 *
 * 本文件不依赖酒馆,可在 node 里直接测。
 */

function clip(s, n) {
    const t = String(s ?? '').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
}

const BACKFILL_SYSTEM = `你是记忆整理员,只做记录,不写故事。读下面这一层角色扮演的正文,照格式输出一个记账块,除此之外什么都不要写。

规则:
- 摘要:100 字左右,流水账体,谁对谁做了什么,状态怎么变了。只写原文里有的,不补不猜。
- 专名:只收人名、地名、物品、组织、作品名、事件名,逗号分隔。没有正式名字的东西,用原文里最认得出它的叫法(比如歌用首句)。不写动作词、氛围词、情绪词。
- 时间:这一层相对上一层过了多久,只选一种写法:同日 / +1夜 / +3天 / 跳至 4月5日
- 约定+、约定✓、好感、性格、情绪、破锚、物品这几行,这一层没有就整行不写。好感、性格、情绪、破锚、物品可以各写多行。
- 好感:某角色对用户的好感这一层有明显变化才写。平常 1 到 3 分,真正的大事才给 5 以上,最多 10。
- 情绪:某角色这一层受了重大打击或刺激,整个人进入某种状态才写。只能填 低落/暴怒/亢奋/恐惧 四种之一,缓过来了填 平稳。日常的小情绪不写。
- 破锚:这一层的事动摇了某角色已经定型的性格才写。
- 物品:某件要紧东西这一层换了人拿,或者出现、丢了、毁了才写。凭空出现写 →现主,丢了毁了写 原主→。吃的喝的抽的不写;手机钱包伞这类随身东西只在换了人拿或者丢了毁了时才写。

格式:
<ihf-ledger>
摘要: …
专名: …
时间: …
约定+: 谁 对 谁 答应了什么
约定✓: 约定内容 已兑现 或 已作废
好感: 角色 +2 因为什么事
性格: 角色 +5 往[正在变成什么样] 因为什么事
情绪: 角色 暴怒 起因
破锚: 角色 起因
物品: 东西 原主→现主 因为什么事
</ihf-ledger>`;

/** 补记账:上一句用户发言 + 这一层正文 → 记账块。
 *  modules 里关掉的那几行不提,免得模型照写、补出一堆用不上的东西 */
export function buildBackfillMessages({ prevUser, text, modules = {} }) {
    const off = Object.entries({ promise: '约定+、约定✓', affinity: '好感', arc: '性格、破锚', emotion: '情绪', item: '物品' })
        .filter(([k]) => modules[k] === false).map(([, v]) => v);
    const system = off.length
        ? `${BACKFILL_SYSTEM}

这次不要写这几行,一行都不要:${off.join('、')}。`
        : BACKFILL_SYSTEM;
    const user = [
        prevUser ? `【上一层用户说】\n${clip(prevUser, 600)}` : '',
        `【这一层正文】\n${clip(text, 3000)}`,
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

const TIMELINE_SYSTEM = `你是记忆整理员,只做记录,不写故事。把下面这几层角色扮演正文压成时间线。

规则:
1. 一行一件事,只写谁、对谁、做了什么。原因、对白、情绪、动作细节、身体描写一律不写。
   比如写"Char1 夜闯 Char2 的房间,两人不欢而散",不写"Char1 扯开她的衣襟"这种动作。
2. 身份用括号备注,只在人物第一次出场或关系变化时带,比如"Char1(Char2 的发小)"。
3. 名字要具体:没有正式名字的东西,用原文里最认得出它的叫法(歌用首句或副歌),不写"一首歌"这种认不出是哪首的泛称。
4. 原文没写的不补,不编年份,不下判断。
5. 每行 30 字以内。按先后顺序覆盖这一整段,不许只写开头几层:地点或时段一变算一个新场景,每个场景只记 1 到 2 行最要紧的事,整段不超过 8 行。日常琐碎不记。
6. 每行开头照抄那一层标的日期,后面接竖线再写事件。例如:3月2日 Day5｜Char1 把那把剑还给了 Char2
   没有月日的就只写 Day 数,例如:Day5｜Char1 把那把剑还给了 Char2

只输出时间线,不要标题,不要解释。`;

/**
 * 压时间线:必须喂原文,不许拿摘要去压(8/3 家规;9/11 "初识"事故就是照摘要编出来的)。
 * @param {{label:string, text:string}[]} floors label 形如 "2月18日 Day1"
 */
export function buildTimelineMessages(floors) {
    const body = floors.map(f => `〔${f.label}〕\n${f.text}`).join('\n\n');
    return [
        { role: 'system', content: TIMELINE_SYSTEM },
        { role: 'user', content: body },
    ];
}

const ORIGIN_SYSTEM = `你是资料员。下面是一段角色设定。把其中描写指定角色**性格**的句子原样摘出来,一个字都不许改、不许概括、不许补写。

规则:
- 只摘性格,不摘外貌、身世、职业、能力。
- 可以摘多句,按原文顺序连起来,句子之间用句号隔开。
- 原文里找不到写这个角色性格的句子,就只回两个字:无。
- 除了摘出来的原句,什么都不要写。`;

/** 性格弧第一条的"从"必须是角色描述里的原句(道长),不许模型自己概括 */
export function buildOriginMessages({ name, description }) {
    return [
        { role: 'system', content: ORIGIN_SYSTEM },
        { role: 'user', content: `【要摘的角色】${name}

【角色设定】
${clip(description, 6000)}` },
    ];
}

const AFFINITY_INIT_SYSTEM = `你是资料员,只做判断,不写故事。

读下面的角色设定和开场白,判断故事**开始的这一刻**,每个角色对用户是什么态度,给一个分数。

分数是 -100 到 100,只看"他现在肯为这个用户投入到什么程度",不看他们认不认识:
  -100 到 -61 恨:不会放过对方,会主动让对方付代价
  -60 到 -31 敌意:说话带刺,会使绊子
  -30 到 -1 反感:能不理就不理
  0 到 20 不咸不淡:不会为对方改自己的安排
  21 到 40 有好感:肯顺手帮个不费事的忙
  41 到 60 肯上心:会主动找对方,肯花时间花钱
  61 到 80 放在心上:对方的事排在自己的事前面
  81 到 95 掏心掏肺:把对方当自己的一部分
  96 到 100 唯一

规则:
1. 一行一个人,格式:角色名 分数 理由。理由一句话,说清楚是从设定里哪句看出来的。
2. 只写设定和开场白里真出现过的、有名字的角色,不写用户自己,不写路人,最多 6 个。
3. 多年发小也可能只是不咸不淡,朝夕相处的上司也可能是敌意。**关系近不等于分数高**,只看肯不肯为对方付出。
4. 设定里看不出态度的,就给 0,理由写"设定里没写"。
5. 不编设定里没有的事。只输出这几行,不要标题,不要解释。`;

/** 开局好感:扫一遍人设和开场白,给每个人拟一个起点(道长:有人会忘了自己设) */
export function buildAffinityInitMessages({ userName, description, opening }) {
    const body = [
        `【用户扮演的人】${userName || '用户'}`,
        `【角色设定】\n${clip(description, 6000)}`,
        opening ? `【开场白】\n${clip(opening, 3000)}` : '',
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: AFFINITY_INIT_SYSTEM },
        { role: 'user', content: body },
    ];
}

/** "Char1 35 从小一起长大,但这些年生分了" → {name, value, why}[]。认不出的行丢掉 */
export function parseAffinityInit(text) {
    const out = [];
    const seen = new Set();
    for (const raw of String(text ?? '').split('\n')) {
        const line = raw.replace(/^\s*(?:\d+[.、)]|[-*·•])\s*/, '').replace(/[｜|]/g, ' ').trim();
        const m = line.match(/^(.+?)[\s,，:：]+([+-]?\d{1,3})(?:\s*分)?[\s,，:：]+(.+)$/);
        if (!m) continue;
        const name = m[1].replace(/^[\s"'“”【\[]+|[\s"'“”】\]:：]+$/g, '').trim();
        const value = Math.max(-100, Math.min(100, Number(m[2])));
        const why = m[3].trim();
        if (!name || name.length > 20 || seen.has(name) || !Number.isFinite(value)) continue;
        seen.add(name);
        out.push({ name, value, why });
        if (out.length >= 6) break;
    }
    return out;
}

/* ---------------- 第三期:命运 ---------------- */

const FATE_SURVEY_SYSTEM = `你是记录员。下面这个人不在主角身边,你要写他这几天自己的日子。

规则:
1. **绝大部分是过日子**:吃饭、上班、赶工、跟人闲扯、发呆、处理麻烦事。
   不要每次都写要紧的事,不要每次都推进剧情。平淡才是常态。
2. 写 2 到 4 行,一行一件,每行 30 字以内,只写他做了什么,不写他心里怎么想。
3. 只用材料里出现过的人名地名,不编新角色、不编新地点。
4. 另外写一行"此刻":他现在这一刻正在做的事,一句话,具体到动作
   (好例子:开嗓中 / 点了外卖,发了条朋友圈说挺好吃的 / 在婚庆现场搭架子。
    坏例子:在思考人生 / 心情复杂 / 谋划着什么)。
5. 最后一行写"付诸行动":只有当他这几天做的事**正好就是**下面列出的某条触发情形时,
   才写那条的编号;但凡还差一点、还没到那一步,一律写"无"。宁可写无。

只按这个格式输出,不要解释:
此刻: …
这几天:
- …
- …
付诸行动: 无`;

/** 幕后推演:一个人一个人地问(道长:分开写,不然模型会把所有事糊在一起) */
export function buildFateSurveyMessages({ name, kind, card, ideas = [], recentLog = '', story = '', days = 1 }) {
    const wants = ideas
        .map((it, i) => (it.actWhen ? `${i + 1}) ${it.text}\n   触发情形:${it.actWhen}` : `${i + 1}) ${it.text}(这条没有触发情形,永远写"无")`))
        .join('\n');
    const who = kind === 'world'
        ? '这不是某个人,是"外面的世界"。写这几天外头在传什么、出了什么大事(某个东西火了、某人塌了、行情变了)。"此刻"写外面此刻在传什么。'
        : kind === 'common'
            ? '这一栏专收好几个人搅在一起的事。只写"这几天",不写"此刻",不写"付诸行动"。'
            : '';
    const body = [
        `【这一栏是谁】${name}`,
        who,
        card ? `【他是什么人】\n${clip(card, 1500)}` : '',
        wants ? `【他长期惦记着的事(只影响他怎么过日子,不要直接写出来)】\n${wants}` : '',
        recentLog ? `【他前几天干了什么】\n${clip(recentLog, 800)}` : '',
        story ? `【主角这边最近发生了什么】\n${clip(story, 2000)}` : '',
        `【距上次记录过了大约 ${days} 天】`,
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: FATE_SURVEY_SYSTEM },
        { role: 'user', content: body },
    ];
}

/** 解析推演结果 */
export function parseFateSurvey(text) {
    const lines = String(text ?? '').split('\n');
    let now = '';
    let act = 0;
    const log = [];
    let inLog = false;
    for (const raw of lines) {
        const l = raw.trim();
        if (!l) continue;
        let m = l.match(/^此刻\s*[:：]\s*(.+)$/);
        if (m) { now = m[1].trim(); inLog = false; continue; }
        if (/^这几天\s*[:：]?\s*$/.test(l)) { inLog = true; continue; }
        m = l.match(/^付诸行动\s*[:：]\s*(.+)$/);
        if (m) {
            const t = m[1].trim();
            const n = t.match(/[1-9１-９①-⑨]/);
            if (n && !/^无|没有|不/.test(t)) act = '①②③④⑤⑥⑦⑧⑨'.indexOf(n[0]) >= 0
                ? '①②③④⑤⑥⑦⑧⑨'.indexOf(n[0]) + 1
                : Number(n[0].replace(/[１-９]/, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
            inLog = false;
            continue;
        }
        if (inLog || /^[-*·•]/.test(l)) {
            const t = l.replace(/^[-*·•]\s*/, '').replace(/^\d+[.、)]\s*/, '').trim();
            if (t && t.length <= 60) log.push(t);
        }
    }
    return { now: now.slice(0, 60), log: log.slice(0, 4), act };
}

const FATE_IDEA_SYSTEM = `你是资料员。读下面这个人的设定和已经发生的剧情,写出他**长期惦记着**的事。

规则:
1. 写 1 到 3 条。设定里就算只给了这个人一两句(身份、跟谁什么关系、什么处境),
   也要**照他的身份和处境推出他自己会惦记的事**:合情合理、跟设定不冲突就行,这不算瞎编。
   比如设定只说"他是记者,有篇稿子被压了",就可以推出他一直惦记那篇稿子还能不能见报。
   只有连这个人是谁都看不出来的时候,才回"无"。
2. 每条都要配这几样:
   - 触发情形:什么场面出现时他会真的动手。必须是一件具体的、看得见的事,
     写明他当众或当着谁做了什么。写不出来就写"无"(那这条就只在背后影响他,不会浮出来)。
   - 在场时会:他和主角在同一个场合时会做的 2 到 3 件事。**只写他做什么说什么,不要写限制**
     (限制全部写在"界"里,两边都写会打架)。
   - 界:分 2 到 3 档,一档一行,从最克制往最放开排。
   - 有别人在时:旁边有第三个人的时候怎么办。
3. **"界"是梯子,不是一根线。** 关系是一步步深的,写死一根线等于让他一辈子停在原地。
   每一档挂在一个好感档位上,格式照抄:「好感在「档位名」以上: 他能做到什么地步」。
   好感档位只能从这几个里选:{{TIERS}}
4. **梯子的高度要照这个人的性格定,不是照统一标准定。**
   同样是第一档,一个调情惯了的人可以已经在开玩笑动手动脚,一个闷性子的人可能只敢多看两眼;
   同样是最高档,前者可能直接上手,后者也不过是碰碰她手腕。**照他的性格写,别拿别人的尺子量他。**
5. 每一档都要具体。
   好例子:会单独约她,会说她的歌只有他懂,还是不碰她
   坏例子:注意分寸 / 适度表现 / 把握尺度(这种写了等于没写)
6. "有别人在时"也照性格写,只写一句,三种意思任选:
   退回上一档(要脸的、怕人看见的) / 照样如此,他不在乎 / 反而更来劲,他就爱当众
7. 只用材料里出现过的人名地名,不编新角色。

格式,一条一段,不要解释:
① 他惦记的事
触发情形: …
在场时会: … / … / …
界:
① 好感在「A」以上: …
② 好感在「B」以上: …
有别人在时: …`;

/**
 * 立念头:开栏时问一次,之后面板里改。念头原文永不出门,出门的只有"在场时会"和当前那一档的"界"。
 * traits 是这个人的性格原句(性格弧那块从角色卡摘的那段),梯子的高度照它定
 * (道长定的:本来就脸皮厚的人,当着别人的面也照样来,梯子高度要照性格定)。
 */
/** 设定里跟这个人有关的段落(按空行或标签切段,提到名字的留下)。一段都没有就返回空 */
export function excerptAbout(card, name, max = 3000) {
    const parts = String(card ?? '').split(/\n\s*\n|(?=<[^/][^>]{0,40}>)/).map(s => s.trim()).filter(Boolean);
    const hit = parts.filter(p => p.includes(name));
    return clip(hit.join('\n\n'), max);
}

/**
 * 立念头。9/18 的教训:卡的设定整篇都在写主角,只丢"要写谁 = 某 NPC"进去,
 * 模型会把主角的心事写到 NPC 头上(父亲那栏写的全是主角的事)。
 * 所以:①明说谁是主角、谁是用户,念头的主语只能是这个 NPC;②设定先挑提到他的段落,整篇只作背景。
 */
export function buildFateIdeaMessages({ name, card, story, traits, tierNames = [], owners = [], userName = '' }) {
    const sys = FATE_IDEA_SYSTEM.replace('{{TIERS}}', tierNames.join('、') || '好感由低到高的各档');
    const about = excerptAbout(card, name);
    const ownerLine = owners.length
        ? `【注意】这张卡的主角是${owners.join('、')},用户扮演的是${userName || '用户'}。这一栏写的是${name},不是${owners.join('、')}。`
            + `每条念头的主语都必须是${name}本人,写${name}自己惦记的事;${owners.join('、')}在念头里只能作为别人出现。`
            + `${name}的心事可以跟${owners.join('、')}有关(比如当爹的惦记儿子),但惦记的人是${name},写的是${name}的心思和${name}会做的事;`
            + `别把${owners.join('、')}自己的心事搬过来。`
            + `\n写完每条自己核对一遍:这件事里动手的、惦记的,是不是${name}本人?用的东西、去的地方,是不是${name}自己的?`
            + `只要这条换成${owners.join('、')}来做也说得通(比如用的是${owners.join('、')}的手机、办的是${owners.join('、')}的公事),就是写错了人,删掉重写。`
        : '';
    const body = [
        `【要写谁】${name}`,
        ownerLine,
        traits ? `【${name}是什么性子(照这个定梯子的高度)】\n${clip(traits, 800)}` : '',
        about ? `【设定里提到${name}的地方】\n${about}` : `【设定里提到${name}的地方】(没有)`,
        card ? `【整张卡的设定(只当背景,别把里面主角的心事写给${name})】\n${clip(card, 2500)}` : '',
        story ? `【已经发生的剧情】\n${clip(story, 3000)}` : '',
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: sys },
        { role: 'user', content: body },
    ];
}

const FATE_WORLD_SYSTEM = `你是资料员。读下面的设定和已经发生的剧情,写出这个世界里**正在酝酿、还没爆出来的大事**:
行业里的风向、城里的新闻、某个产品或某个人要出事、行情要变,这一类背景板上的事。

规则:
1. 最多 3 条,有几条写几条,看不出来就回"无"。
2. **不写任何一个人的心事**,尤其不写主角和用户之间的事。这里只写外面的世界。
3. 每条配一行「触发情形」:什么时候会爆出来,写一件具体的、看得见的事。
4. 只用材料里出现过的地名、机构名,可以不提具体人。按世界观来,古代就是邸报茶馆,现代就是新闻热搜,别写错时代。

格式,一条一段,不要解释:
① 正在酝酿的事
触发情形: …`;

/** 「世界」那一栏立念头:写大势,不写人,不要梯子(9/18 用写人的提示词,世界栏写成了主角的心事) */
export function buildFateWorldMessages({ card, story, owners = [] }) {
    const body = [
        owners.length ? `【注意】主角是${owners.join('、')},这里不写他们的心事。` : '',
        card ? `【设定】\n${clip(card, 4000)}` : '',
        story ? `【已经发生的剧情】\n${clip(story, 3000)}` : '',
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: FATE_WORLD_SYSTEM },
        { role: 'user', content: body },
    ];
}

const LIMIT_STEP = /^(?:[①-⑨]|\d+[.、)])?\s*好感(?:在|到)?\s*[「『"'"']?([^」』"'"':：]{1,8})[」』"'"']?\s*(?:以上|及以上|往上)?\s*[:：]\s*(.+)$/;

/**
 * 解析念头。
 * 界是分档的梯子(道长定的:暧昧是一步步升级的,写死一根线等于让这个人永远不会主动)。
 * 老格式的单行「界: xxx」仍然认,当成一档、门槛最低。
 */
export function parseFateIdeas(text, max = 3) {
    const out = [];
    let cur = null;
    let inLimits = false;
    const push = () => { if (cur) out.push(cur); };
    for (const raw of String(text ?? '').split('\n')) {
        const l = raw.trim();
        if (!l) continue;
        const step = l.match(LIMIT_STEP);
        if (step && cur && inLimits) {
            cur.limits.push({ tier: step[1].trim(), text: step[2].trim() });
            continue;
        }
        let m = l.match(/^(?:[①-⑨]|\d+[.、)])\s*(.+)$/);
        if (m && !/^(触发情形|在场时会|界|有别人在时)\s*[:：]/.test(l) && !step) {
            push();
            cur = { text: m[1].trim(), actWhen: '', acts: [], limits: [], inPublic: '', state: '进行中', surfacedAt: null };
            inLimits = false;
            continue;
        }
        if (!cur) continue;
        m = l.match(/^触发情形\s*[:：]\s*(.*)$/);
        if (m) { cur.actWhen = /^无|^没有|^不确定|^$/.test(m[1].trim()) ? '' : m[1].trim(); inLimits = false; continue; }
        m = l.match(/^在场时会\s*[:：]\s*(.+)$/);
        if (m) {
            cur.acts = m[1].split(/\s*\/\s*|\s*;\s*|\s*；\s*/).map(x => x.trim()).filter(x => x.length >= 4).slice(0, 4);
            inLimits = false;
            continue;
        }
        m = l.match(/^有别人在时\s*[:：]\s*(.+)$/);
        if (m) { cur.inPublic = m[1].trim(); inLimits = false; continue; }
        m = l.match(/^界\s*[:：]?\s*(.*)$/);
        if (m) {
            inLimits = true;
            const rest = m[1].trim();
            if (rest) cur.limits.push({ tier: '', text: rest }); // 老格式的单行界
            continue;
        }
        if (/^[-*·•]/.test(l)) {
            const t = l.replace(/^[-*·•]\s*/, '').trim();
            if (t.length < 4) continue;
            if (inLimits) cur.limits.push({ tier: '', text: t });
            else if (cur.acts.length < 4) cur.acts.push(t);
        }
    }
    push();
    return out.filter(x => x.text && x.text.length >= 4 && !/^无$/.test(x.text)).slice(0, max);
}

const BREAKIF_SYSTEM = `你是记忆整理员,只做记录,不写故事。

一个角色的性格刚刚定型了。请写出会让他从这个性格退回去、重新动摇的具体情形。

规则:
1. 只写 2 条,一行一条,不编号,不解释。
2. 每条必须是一件具体的、看得见的事,写明谁对他做了什么。
   好例子:User 当着他的面把他交出去换赏钱
   坏例子:他再次受到伤害 / 有人让他失望 / 发生了重大变故(这种太空,写了等于没写)
3. 必须是这个故事里真有可能发生的事,人名地名只用下面材料里出现过的。
4. 不写他自己的心理活动,只写外面发生的事。`;

/**
 * 性格走满时问一次:什么事会让他退回去。写死存进记忆文件(memory.anchors),
 * 之后每层只让模型比对"这一层有没有发生这种事",比让它判断"这算不算重大"准得多(道长路子)。
 */
export function buildBreakIfMessages({ name, from, to, context }) {
    const body = [
        `【角色】${name}`,
        from ? `【他本来的性格】${clip(from, 800)}` : '',
        `【他现在定型成了】${clip(to || '(没命名)', 400)}`,
        context ? `【这段故事里发生过的事】
${clip(context, 3000)}` : '',
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: BREAKIF_SYSTEM },
        { role: 'user', content: body },
    ];
}

/** 破锚条件回来之后的清洗:一行一条,砍掉编号和太空的句子 */
export function parseBreakIf(text) {
    const VAGUE = /^(?:.{0,6}(?:再次|又一次)?(?:受到伤害|失望|背叛|打击|变故|意外|挫折|伤害)|.{0,8}发生(?:了)?(?:重大)?(?:变故|意外|事情)).{0,4}$/;
    return String(text ?? '')
        .split('\n')
        .map(l => l.replace(/^\s*(?:\d+[.、)]|[-*·•])\s*/, '').trim())
        .filter(l => l.length >= 8 && l.length <= 80 && !VAGUE.test(l))
        .slice(0, 2);
}
