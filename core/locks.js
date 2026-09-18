/**
 * 随机角色锁定(道长 9/17 提的:有张卡的女二由卡内指令随机起名定样貌,
 * 指令常驻上下文,每回合都可能重摇,女二反复变脸换名)。
 *
 * 机制:
 *   1. 第一次出场后,把名字、样貌等录成档案(能从回复里按标签抓就抓,抓不到让副 API 提取);
 *   2. 录完之后,把那条「随机生成」指令从发给模型的上下文里藏掉,换成档案顶上去;
 *   3. 玩家点「重新摇」,档案清掉,指令重新放行。
 * 任何「随机生成一次之后就该固定」的东西(NPC、地点、设定)都适用。
 *
 * 规则跟着卡走(存设置文件,按卡的头像名分);档案跟着这一局走(存记忆文件 memory.locks)。
 * 这里只放纯函数,不碰酒馆。
 */

/**
 * 把含有 match 的那一块从 content 里藏掉。
 * 优先藏最近的一对 <标签>…</标签>(卡里的指令通常是这样包的);找不到就藏含 match 的那一段(空行分隔)。
 * @returns {{text:string, hit:boolean}}
 */
export function hideInstruction(content, match) {
    const s = String(content ?? '');
    const m = String(match ?? '').trim();
    if (!s || !m) return { text: s, hit: false };
    const at = s.indexOf(m);
    if (at < 0) return { text: s, hit: false };
    // 往前找最近的开标签,再找它的闭标签,闭标签要在 match 之后
    const before = s.slice(0, at);
    const openRe = /<([^\s<>/][^<>]*?)>(?![\s\S]*<\1>)/g;
    let open = null;
    let mm;
    while ((mm = openRe.exec(before))) open = { name: mm[1], idx: mm.index };
    if (open) {
        const closeTag = `</${open.name}>`;
        const closeAt = s.indexOf(closeTag, at + m.length);
        if (closeAt >= 0) {
            return { text: trimJoin(s.slice(0, open.idx), s.slice(closeAt + closeTag.length)), hit: true };
        }
    }
    // 退而求其次:藏这一段
    const segStart = s.lastIndexOf('\n\n', at);
    const segEnd = s.indexOf('\n\n', at + m.length);
    const a = segStart < 0 ? 0 : segStart;
    const b = segEnd < 0 ? s.length : segEnd;
    return { text: trimJoin(s.slice(0, a), s.slice(b)), hit: true };
}

function trimJoin(a, b) {
    return (a.replace(/\s+$/, '') + '\n\n' + b.replace(/^\s+/, '')).trim();
}

/** 回复里按标签抓档案:<女二档案>名字｜年龄｜外貌</女二档案> → "名字｜年龄｜外貌"。tag 可带可不带尖括号 */
export function captureProfile(reply, tag) {
    const t = String(tag ?? '').trim().replace(/^<|>$/g, '');
    if (!t) return '';
    const re = new RegExp(`<${escapeRe(t)}>([\\s\\S]*?)</${escapeRe(t)}>`);
    const m = String(reply ?? '').match(re);
    return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const LOCK_EXTRACT_SYSTEM = `你是记录员。下面这一层正文里,如果「要记的角色」第一次出场了,把这个角色定下来的东西抄出来:名字、年龄(有就写)、外貌(三十字以内)、其它这一层写死的设定(有就写)。
只抄正文里明确写了的,不补、不猜。
输出格式(一行,竖线隔开,没有的项写"未写"):
名字｜年龄｜外貌｜其它
如果这一层这个角色根本没出场、或者出场了但连名字都没写,只回一个字:无`;

/**
 * 让副 API 从这一层正文里提取档案。
 * @param {{label:string, hint:string, text:string}} o label = 叫什么(女二),hint = 卡里对这个角色的说明(可空)
 */
export function buildLockExtractMessages({ label, hint, text }) {
    const user = [
        `【要记的角色】${label}`,
        hint ? `【卡里怎么说这个角色】\n${String(hint).slice(0, 800)}` : '',
        `【这一层正文】\n${String(text ?? '').slice(0, 4000)}`,
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: LOCK_EXTRACT_SYSTEM },
        { role: 'user', content: user },
    ];
}

/** 提取结果 → 档案一行;模型说"无"或没按格式写返回 '' */
export function parseLockExtract(out) {
    const s = String(out ?? '').trim();
    if (!s || /^无[。.]?$/.test(s)) return '';
    const line = s.split('\n').map(x => x.trim()).find(x => /[｜|]/.test(x));
    if (!line) return '';
    const parts = line.split(/[｜|]/).map(x => x.trim());
    if (!parts[0] || /^(未写|无|不详|未知)$/.test(parts[0])) return '';
    return parts.filter(x => x && !/^(未写|无)$/.test(x)).join('｜');
}

/** 发给模型的档案块:已固定的角色一律沿用,别再重摇 */
export function buildLockPrompt(archives) {
    const rows = Object.entries(archives ?? {}).filter(([, a]) => a?.profile);
    if (!rows.length) return '';
    return [
        '[本局已定下的角色]',
        ...rows.map(([label, a]) => `${label}:${a.profile}`),
        '这些角色的名字、外貌、设定在本局已经定了,之后一律沿用,不要再重新起名、改年龄或改外貌。',
    ].join('\n');
}
