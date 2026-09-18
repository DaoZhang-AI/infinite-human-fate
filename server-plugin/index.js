/**
 * 模拟人生 · 服务端转发插件
 *
 * 只干一件事:替浏览器把嵌入(embeddings)、重排(rerank)、拉模型列表(models)
 * 这三种请求发到向量站去。这样公益站看到的是酒馆服务器在发,不是浏览器。
 * (道长 2026-08-21 说的硬规矩:所有酒馆公益站都只允许从酒馆的出口出去。)
 *
 * 地址和 key 每次随请求带过来,这里不存、不打日志。
 * 挂载点:/api/plugins/infinite-human-fate
 * 在 requireLoginMiddleware 和 CSRF 之后加载(见 src/server-main.js),天然受登录保护。
 *
 * 装法:把这个文件夹拷到酒馆根目录的 plugins/infinite-human-fate/,
 * config.yaml 里 enableServerPlugins: true,重启酒馆服务。
 * 无外部依赖,node 18+ 自带 fetch。
 */

const PLUGIN_ID = 'infinite-human-fate';
const PLUGIN_VERSION = '0.1.0';

const info = {
    id: PLUGIN_ID,
    name: '模拟人生',
    description: '向量召回的服务端转发:嵌入、重排、拉模型列表都由酒馆服务器代发。',
};

/** 只许 http(s),别的一律拒 */
function safeUrl(url) {
    const s = String(url ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/i.test(s)) return null;
    return s;
}

function clampTimeout(ms) {
    const n = Number(ms);
    return Number.isFinite(n) ? Math.min(120000, Math.max(3000, n)) : 30000;
}

/** 打到对面。错误信息只带状态码和前 200 字,不带 key */
async function forward(url, key, path, method, body, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url + path, {
            method,
            headers: {
                'Authorization': 'Bearer ' + String(key ?? '').trim(),
                'Content-Type': 'application/json',
            },
            body: method === 'POST' ? JSON.stringify(body) : undefined,
            signal: ctrl.signal,
        });
        const text = await res.text();
        if (!res.ok) return { status: res.status, error: `${path} 返回 HTTP ${res.status}:${text.slice(0, 200)}` };
        try {
            return { status: 200, data: JSON.parse(text) };
        } catch {
            return { status: 502, error: `${path} 回的不是 JSON:${text.slice(0, 200)}` };
        }
    } catch (e) {
        if (e?.name === 'AbortError') return { status: 504, error: `${path} 超过 ${Math.round(timeoutMs / 1000)} 秒没回` };
        return { status: 502, error: `${path} 连不上:${String(e?.message ?? e).slice(0, 200)}` };
    } finally {
        clearTimeout(timer);
    }
}

/** 三条路由共用的壳:校验地址,转发,原样回 */
function relay(path, method, pickBody) {
    return async (request, response) => {
        const b = request.body ?? {};
        const url = safeUrl(b.url);
        if (!url) return response.status(400).json({ error: '地址不合法,要以 http:// 或 https:// 开头' });
        const out = await forward(url, b.key, path, method, pickBody ? pickBody(b) : undefined, clampTimeout(b.timeoutMs));
        if (out.error) return response.status(out.status).json({ error: out.error });
        return response.json(out.data);
    };
}

/**
 * 注册路由。
 * @param {import('express').Router} router
 */
async function init(router) {
    // 扩展靠这个探活:探到了就走转发,探不到就浏览器直连
    router.get('/ping', (_request, response) => {
        response.json({ ok: true, id: PLUGIN_ID, version: PLUGIN_VERSION });
    });

    router.post('/embed', relay('/embeddings', 'POST', b => ({
        model: b.model, input: b.input, encoding_format: b.encoding_format ?? 'float',
    })));

    router.post('/rerank', relay('/rerank', 'POST', b => ({
        model: b.model, query: b.query, documents: b.documents, return_documents: false, top_n: b.top_n,
    })));

    router.post('/models', relay('/models', 'GET'));

    console.log(`[${PLUGIN_ID}] 模拟人生服务端转发已加载 v${PLUGIN_VERSION}`);
}

module.exports = { info, init };
