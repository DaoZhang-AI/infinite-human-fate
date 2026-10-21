import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { emptyMemory, reconcile } from '../core/memory.js';
import { DEFAULT_CONFIG } from '../store.js';

export const reply = (mes, index, isUser = false) => ({ mes, name: isUser ? 'User' : 'Char1',
    is_user: isUser, is_system: false, send_date: `fixture-${index}` });

/** Evaluate the real entry and its imports with a synthetic host. No initialization callbacks or timers run. */
export async function harness() {
    const elements = new Map(['ihf-people-view', 'ihf-fate-view', 'ihf-table-view'].map(id => [id, { innerHTML: '' }]));
    const calls = [];
    const timers = new Map();
    const chat = [reply('<ihf-ledger>摘要: Char1 和 Char2 在场\n在场: Char1, Char2</ihf-ledger>', 0)];
    const context = { chat, name1: 'User', name2: 'Char1', characterId: 0,
        characters: [{ name: 'Char1', description: 'Char1 与 Char2、NPC 在同一个世界生活。', personality: '谨慎' }],
        groups: [], chatMetadata: {}, extensionSettings: {},
        getCurrentChatId: () => 'fixture', getRequestHeaders: () => ({}), substituteParams: s => s,
        setExtensionPrompt() {}, generateRaw: async () => { throw new Error('Model mock not configured'); },
        ConnectionManagerRequestService: { getSupportedProfiles: () => [{ id: 'fixture', name: 'fixture', model: 'fixture' }],
            sendRequest: async (_id, messages) => { calls.push(messages); throw new Error('Model mock not configured'); } } };
    const jq = new Proxy(() => jq, { get: (_t, k) => k === 'length' ? 0 : (..._args) => jq });
    const sandbox = vm.createContext({ structuredClone, TextEncoder, TextDecoder, URL, URLSearchParams, AbortController,
        console: { info() {}, warn() {}, error() {}, debug() {}, log() {} },
        document: { getElementById: id => elements.get(id) ?? null },
        window: {}, $: jq, jQuery: () => jq,
        SillyTavern: { getContext: () => context }, toastr: { info() {}, success() {}, warning() {}, error() {} },
        setTimeout: (fn, ms) => { const id = Symbol(); timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
        fetch: async () => { throw new Error('Unexpected fetch: real network forbidden'); },
        btoa: s => Buffer.from(s, 'binary').toString('base64') });
    const cache = new Map();
    const load = url => {
        const key = url.href;
        if (!cache.has(key)) cache.set(key, (async () => {
            let source = await readFile(fileURLToPath(url), 'utf8');
            if (url.pathname.endsWith('/index.js')) source += `\nexport {state, renderPeople, renderFate, sceneNames, ensureThreads, refresh,
                planRun, startThoughtPlanning, startBackfill, currentStory, openChat, autoJobs, saveMemory, importMemory,
                knownPeople, setRole, startAffinityInit, renderTable, runJob, callModel, stopJob};
                export function testPanel(page) { ui = {current:page}; }`;
            return new vm.SourceTextModule(source, { identifier: key, context: sandbox });
        })());
        return cache.get(key);
    };
    const main = await load(new URL('../index.js', import.meta.url));
    await main.link((specifier, module) => {
        if (!specifier.startsWith('.')) throw new Error('External import forbidden in fixture');
        return load(new URL(specifier, module.identifier));
    });
    await main.evaluate();
    const api = main.namespace;
    Object.assign(api.state, { config: structuredClone(DEFAULT_CONFIG), memory: emptyMemory('fixture'),
        memId: 'fixture', chatId: 'fixture', lastTier: 'big' });
    api.state.config.recall.enabled = false;
    api.state.config.jobs.subProfile = 'st:fixture';
    api.state.config.jobs.rpm = Infinity; // No real scheduler sleeps in this isolated host.
    api.state.config.fate.world = false;
    api.state.memory.affinityStart = { Char1: { value: 10 }, Char2: { value: 20 }, NPC: { value: 0 } };
    api.state.view = reconcile(api.state.memory, chat);
    api.ensureThreads();
    return { api, context, elements, calls, timers, sandbox };
}
