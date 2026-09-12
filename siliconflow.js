/**
 * 硅基流动的向量和重排请求。
 * 浏览器可带 key 直连:9/11 预检实测 /v1/embeddings、/v1/rerank 都回 Access-Control-Allow-Origin: *。
 * node 18+ 自带 fetch,离线测试也用这份。
 * 报错信息里只放状态码和对方返回的前 200 字,绝不带 key。
 */

async function post(cfg, path, body, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(String(cfg.base_url).replace(/\/+$/, '') + path, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + String(cfg.key).trim(), 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`硅基流动 ${path} 返回 HTTP ${res.status}:${(await res.text()).slice(0, 200)}`);
        return await res.json();
    } catch (e) {
        if (e?.name === 'AbortError') throw new Error(`硅基流动 ${path} 超过 ${Math.round(timeoutMs / 1000)} 秒没回`);
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

/** @returns {Promise<number[][]>} 与 texts 同序 */
export async function embed(texts, cfg, timeoutMs = 20000) {
    const d = await post(cfg, '/embeddings', { model: cfg.embed_model, input: texts, encoding_format: 'float' }, timeoutMs);
    return [...d.data].sort((a, b) => a.index - b.index).map(x => x.embedding);
}

/** @returns {Promise<{index:number, relevance_score:number}[]>} */
export async function rerank(query, docs, cfg, timeoutMs = 10000) {
    const d = await post(cfg, '/rerank', { model: cfg.rerank_model, query, documents: docs, return_documents: false, top_n: docs.length }, timeoutMs);
    return d.results ?? [];
}
