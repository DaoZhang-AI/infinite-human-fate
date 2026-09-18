/**
 * 向量(嵌入)和重排的请求。嵌入、重排各自一套地址 / key / 模型,不绑死硅基流动。
 *
 * 两条路,按 cfg.vector.via 选:
 *   server = 经酒馆服务器转发(需要装配套的服务端插件 plugins/infinite-human-fate),
 *            公益站看到的是酒馆在发,不是浏览器;
 *   direct = 浏览器直连(硅基流动这类允许跨域的官方站可以,公益站别走这条,会被封);
 *   auto   = 探到服务端插件就转发,探不到就直连。
 *
 * 报错信息里只放状态码和对方返回的前 200 字,绝不带 key。
 * node 18+ 自带 fetch,离线测试也能用这份(走 direct)。
 */

export const RELAY_BASE = '/api/plugins/infinite-human-fate';

/** 探过一次就记住:true 转发可用,false 不可用,null 还没探 */
let relayOk = null;

/** 酒馆的请求头(带 csrf),index.js 注入;离线测试没有 */
let headersFn = () => ({ 'Content-Type': 'application/json' });
export function setHeaders(fn) { headersFn = fn; }

function trimUrl(url) {
    return String(url ?? '').trim().replace(/\/+$/, '');
}

/** 服务端插件在不在。一个页面只探一次 */
export async function probeRelay(force = false) {
    if (relayOk !== null && !force) return relayOk;
    try {
        const res = await fetch(`${RELAY_BASE}/ping`, { headers: headersFn(), cache: 'no-store' });
        relayOk = res.ok && (await res.json())?.ok === true;
    } catch {
        relayOk = false;
    }
    return relayOk;
}

export function relayAvailable() { return relayOk === true; }

async function useRelay(via) {
    if (via === 'direct') return false;
    if (via === 'server') return true;
    return await probeRelay();
}

/** 直连:浏览器(或 node)直接打对面 */
async function postDirect(ep, path, body, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(trimUrl(ep.url) + path, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + String(ep.key ?? '').trim(), 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`${path} 返回 HTTP ${res.status}:${(await res.text()).slice(0, 200)}`);
        return await res.json();
    } catch (e) {
        if (e?.name === 'AbortError') throw new Error(`${path} 超过 ${Math.round(timeoutMs / 1000)} 秒没回`);
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

async function getDirect(ep, path, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(trimUrl(ep.url) + path, {
            headers: { 'Authorization': 'Bearer ' + String(ep.key ?? '').trim() },
            signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`${path} 返回 HTTP ${res.status}:${(await res.text()).slice(0, 200)}`);
        return await res.json();
    } catch (e) {
        if (e?.name === 'AbortError') throw new Error(`${path} 超过 ${Math.round(timeoutMs / 1000)} 秒没回`);
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

/** 转发:交给酒馆服务器上的插件去打,地址和 key 随请求带过去,服务端不存 */
async function viaRelay(route, ep, body, timeoutMs) {
    const res = await fetch(`${RELAY_BASE}/${route}`, {
        method: 'POST',
        headers: headersFn(),
        body: JSON.stringify({ url: trimUrl(ep.url), key: String(ep.key ?? '').trim(), timeoutMs, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) throw new Error(data?.error ?? `转发返回 HTTP ${res.status}`);
    return data;
}

/** 这一组(嵌入或重排)填齐了没有:地址和模型都有才算 */
export function endpointReady(ep) {
    return !!(ep && trimUrl(ep.url) && String(ep.model ?? '').trim());
}

/** 重排的 key 没填、地址又和嵌入同一家,就借嵌入的 key */
export function effectiveRerank(vector) {
    const r = { ...(vector?.rerank ?? {}) };
    const e = vector?.embed ?? {};
    if (!String(r.key ?? '').trim() && trimUrl(r.url) && trimUrl(r.url) === trimUrl(e.url)) r.key = e.key;
    return r;
}

/** @returns {Promise<number[][]>} 与 texts 同序 */
export async function embed(texts, vector, timeoutMs = 20000) {
    const ep = vector.embed;
    const body = { model: ep.model, input: texts, encoding_format: 'float' };
    const d = (await useRelay(vector.via))
        ? await viaRelay('embed', ep, body, timeoutMs)
        : await postDirect(ep, '/embeddings', body, timeoutMs);
    return [...(d.data ?? [])].sort((a, b) => a.index - b.index).map(x => x.embedding);
}

/** @returns {Promise<{index:number, relevance_score:number}[]>} */
export async function rerank(query, docs, vector, timeoutMs = 10000) {
    const ep = effectiveRerank(vector);
    const body = { model: ep.model, query, documents: docs, return_documents: false, top_n: docs.length };
    const d = (await useRelay(vector.via))
        ? await viaRelay('rerank', ep, body, timeoutMs)
        : await postDirect(ep, '/rerank', body, timeoutMs);
    return d.results ?? [];
}

/** 拉模型列表(OpenAI 风格的 GET /models)。@returns {Promise<string[]>} */
export async function listModels(ep, via, timeoutMs = 15000) {
    const d = (await useRelay(via))
        ? await viaRelay('models', ep, {}, timeoutMs)
        : await getDirect(ep, '/models', timeoutMs);
    const arr = Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : [];
    return [...new Set(arr.map(m => String(m?.id ?? m ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
