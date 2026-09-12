/**
 * 认楼用的正文指纹。
 *
 * 为什么不往消息 extra 里写编号:每条 swipe 各带一份 extra,左右滑时整份替换
 * (public/script.js:10288 附近),编号会丢。改用正文指纹当键,聊天文件一个字都不碰:
 *   删楼不错位;滑到别的 swipe 自动换那条的记录,滑回来旧记录还在;
 *   编辑后指纹变了,自然进待补;开分支时消息原样复制,指纹对得上就能照抄主线的记录。
 *
 * 本文件不依赖酒馆,可在 node 里直接测。
 */

/** 旧 v5.6 记忆脚本会往楼头塞 <span data-rag>,插件接管前先无视它,免得指纹来回跳 */
const LEGACY_TAG_RE = /^<span data-rag="(?:fold|recall)"[^>]*><\/span>/;

export function normalizeForFingerprint(mes) {
    return String(mes ?? '')
        .replace(LEGACY_TAG_RE, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function fnv1a(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

/** 任意文本的短指纹,用来判断摘要改没改、向量要不要重算 */
export function hashText(s) {
    const str = String(s ?? '');
    return fnv1a(str, 0x811c9dc5).toString(16).padStart(8, '0') + fnv1a(str, 0x9747b28c ^ str.length).toString(16).padStart(8, '0');
}

/** 两个不同起点的 32 位 FNV-1a 拼成 16 位十六进制,几千层内撞车概率可忽略 */
export function fingerprint(mes, isUser) {
    const s = (isUser ? 'u:' : 'a:') + normalizeForFingerprint(mes);
    const a = fnv1a(s, 0x811c9dc5).toString(16).padStart(8, '0');
    const b = fnv1a(s, 0x9747b28c ^ s.length).toString(16).padStart(8, '0');
    return a + b;
}
