import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../core/thoughts.js';
import { parseLedger } from '../core/ledger.js';
import { emptyMemory, reconcile, recordFromMessage, recordFromLedgerText } from '../core/memory.js';
import { presentNames, buildStatusSection, DEFAULT_PEOPLE } from '../core/people.js';
import { emptyFate, emptyThread, coPresence } from '../core/fate.js';
import { createMemoryWriter, captureGuard } from '../core/runtime.js';
import { mergeMemory } from '../store.js';

globalThis.fetch = () => { throw new Error('Network is forbidden in offline tests'); };
const ai = (mes, hidden = false) => ({ mes, is_user: false, is_system: hidden });
const ledger = lines => `<ihf-ledger>摘要: fixture\n${lines}</ihf-ledger>`;
const idea = (label = '念头', failureLimit = 3) => ({ text: label, nextAction: '给 User 留一条消息', failureLimit });
const plan = (extra = {}) => ({ current: '这饭真好吃', short: idea('短期'), long: [idea('长期')], obsession: [idea('执念')], ...extra });
function setup() {
    const mem = emptyMemory('fixture');
    mem.fate.threads.Char1 = emptyThread('Char1');
    const chat = [ai(ledger('在场: Char1'))];
    const rows = () => reconcile(mem, chat).rows;
    T.migrateThoughts(mem.fate);
    return { mem, chat, rows, project: () => T.projectThoughts(mem.fate, rows()).people.Char1 };
}
function advance(s, count) { for (let i = 0; i < count; i++) s.chat.push(ai(`reply ${s.chat.length}`)); }
function receipt(s, layer, outcome = '进展', nextAction = '再次联系 User') {
    const it = s.project()[layer];
    const target = Array.isArray(it) ? it[0] : it;
    return `念头✓: ${target.id} | ${target.pending.id} | ${outcome} | 正文给出明确结果 | ${nextAction}`;
}

test('presence parse -> both record paths -> cached repair -> reconcile -> scene, including explicit empty', () => {
    assert.equal(Object.hasOwn(parseLedger('摘要: old\n专名: Char1'), 'present'), false);
    for (const make of [recordFromMessage, recordFromLedgerText]) {
        assert.deepEqual(make(ledger('在场: Char1\n专名: NPC')).present, ['Char1']);
        assert.deepEqual(make(ledger('在场: 无\n专名: NPC')).present, []);
    }
    const mem = emptyMemory('fixture');
    const chat = [ai(ledger('在场: Char1')), ai(ledger('在场: 无\n专名: NPC'))];
    let view = reconcile(mem, chat);
    assert.deepEqual([...presentNames(view.rows, 12)], []);
    delete view.rows[1].record.present;
    view.rows[1].record.vec = { test: true };
    view = reconcile(mem, chat);
    assert.equal(view.added, 1);
    assert.deepEqual(view.rows[1].record.present, []);
    assert.deepEqual(view.rows[1].record.vec, { test: true });
    assert.equal(reconcile(mem, chat).added, 0);
    assert.equal(coPresence(view.rows, 'NPC'), 0);
    assert.equal(buildStatusSection({ people: { NPC: { name: 'NPC', startSource: 'llm', affinity: 0 } },
        promises: [], rows: view.rows, cfg: DEFAULT_PEOPLE }).includes('NPC'), false);
    assert.deepEqual([...presentNames(reconcile(emptyMemory('old'), [ai(ledger('专名: Char1'))]).rows, 2)], ['Char1']);
});

test('migration is lossless and repeated migration does not duplicate ideas or logs', () => {
    const fate = emptyFate();
    fate.ideasVer = 1;
    fate.threads.Char1 = { ...emptyThread('Char1'), ideas: [{ ...idea('旧念头'), state: '进行中' }],
        parkedIdeas: [{ ...idea('旧执着'), state: '了了', surfacedAt: 3 }], log: [{ day: 1, text: '旧日志' }] };
    const before = structuredClone(fate.threads.Char1);
    assert.equal(T.migrateThoughts(fate), true);
    assert.equal(T.migrateThoughts(fate), false);
    assert.deepEqual(fate.threads.Char1.ideas, before.ideas);
    assert.deepEqual(fate.threads.Char1.parkedIdeas, before.parkedIdeas);
    assert.deepEqual(fate.threads.Char1.log, before.log);
    const layers = T.projectThoughts(fate).people.Char1;
    assert.equal(layers.long.length, 1);
    assert.equal(layers.archive.length, 1);
});

test('strict plans allow explicit empty thoughts but reject malformed structures without mutation', () => {
    assert.doesNotThrow(() => T.parseThoughtPlan(JSON.stringify(plan({ short: null, long: [], obsession: [] }))));
    for (const bad of [null, [], { current: 'current only' }, plan({ updates: {} }), plan({ long: [null] }),
        plan({ short: {} }), plan({ obsession: [{ text: 'missing action' }] }), plan({ updates: [null] })]) {
        assert.throws(() => T.parseThoughtPlan(JSON.stringify(bad)));
    }
});

test('current thoughts never persist, and unchanged/current-only updates add no operations', () => {
    const s = setup();
    T.commitThoughtPlan(s.mem.fate, s.rows(), {}, 'Char1', plan());
    const before = s.mem.fate.thoughtEngine.events.length;
    for (let i = 0; i < 100; i++) T.commitThoughtPlan(s.mem.fate, s.rows(), {}, 'Char1', plan({ current: `memory-only ${i}` }));
    assert.equal(s.mem.fate.thoughtEngine.events.length, before);
    assert.equal(JSON.stringify(s.mem).includes('memory-only'), false);
    assert.equal(JSON.stringify(s.mem).includes('这饭真好吃'), false);
});

test('layers default to 5/10/15 elapsed AI turns and user messages never accelerate them', () => {
    const s = setup();
    T.commitThoughtPlan(s.mem.fate, s.rows(), {}, 'Char1', plan());
    for (let i = 0; i < 30; i++) s.chat.push({ mes: `User ${i}`, is_user: true });
    let run = T.dispatchThoughts(s.mem.fate, s.rows());
    assert.equal(run.turn, 1); assert.equal(run.changed, false);
    advance(s, 5);
    run = T.dispatchThoughts(s.mem.fate, s.rows());
    assert.ok(run.people.Char1.short.pending);
    assert.equal(run.people.Char1.long[0].pending, null);
    assert.equal(run.people.Char1.obsession[0].pending, null);
    assert.equal(T.dispatchThoughts(s.mem.fate, s.rows()).changed, false);
    advance(s, 5); run = T.dispatchThoughts(s.mem.fate, s.rows());
    assert.ok(run.people.Char1.long[0].pending);
    assert.equal(run.people.Char1.obsession[0].pending, null);
    advance(s, 5); assert.ok(T.dispatchThoughts(s.mem.fate, s.rows()).people.Char1.obsession[0].pending);
});

test('short execution deletes active thought, carries only result to replacement, never promotes', () => {
    const s = setup();
    T.commitThoughtPlan(s.mem.fate, s.rows(), {}, 'Char1', plan());
    advance(s, 5); T.dispatchThoughts(s.mem.fate, s.rows());
    s.chat.push(ai(ledger(receipt(s, 'short', '挫败'))));
    let layers = s.project();
    assert.equal(layers.short, null);
    assert.equal(layers.long.length, 1);
    assert.equal(layers.archive.length, 0);
    assert.equal(layers.replacement.outcome, 'failed');
    T.commitThoughtPlan(s.mem.fate, s.rows(), {}, 'Char1', plan({ short: idea('换一个新短期') }));
    layers = s.project();
    assert.equal(layers.short.text, '换一个新短期');
    assert.equal(layers.replacement, null);
    assert.equal(layers.short.history.length, 0);
});

test('exact idea/attempt receipt, duplicate and old receipts, reroll and continuation are idempotent', () => {
    const s = setup();
    T.commitThoughtPlan(s.mem.fate, s.rows(), { longEvery: 1 }, 'Char1', plan());
    advance(s, 10); T.dispatchThoughts(s.mem.fate, s.rows());
    const good = receipt(s, 'long', '挫败');
    s.chat.push(ai(ledger(good.replace('try-', 'wrong-'))));
    assert.equal(s.project().long[0].history.length, 0);
    s.chat[s.chat.length - 1] = ai(ledger(`${good}\n${good}`));
    assert.equal(s.project().long[0].history.length, 1);
    assert.equal(s.project().long[0].failures, 1);
    const original = s.chat.at(-1);
    s.chat[s.chat.length - 1] = ai('rewritten without receipt');
    assert.equal(s.project().long[0].failures, 0);
    s.chat[s.chat.length - 1] = original;
    assert.equal(s.project().long[0].failures, 1);
    const turn = T.thoughtClock(s.rows()).turn;
    s.chat.at(-1).mes += '\ncontinued text';
    assert.equal(T.thoughtClock(s.rows()).turn, turn);
    assert.equal(s.project().long[0].failures, 1);
    advance(s, 10); T.dispatchThoughts(s.mem.fate, s.rows());
    s.chat.push(ai(ledger(good)));
    assert.equal(s.project().long[0].failures, 1);
});

test('long threshold clamps to 1..10; obsession survives abandon and arbitrary failures', () => {
    const s = setup();
    T.commitThoughtPlan(s.mem.fate, s.rows(), {}, 'Char1', plan({ long: [idea('长期', -20)], obsession: [idea('执念', 1000)] }));
    assert.equal(s.project().long[0].failureLimit, 1);
    assert.equal(s.project().obsession[0].failureLimit, 10);
    advance(s, 15); T.dispatchThoughts(s.mem.fate, s.rows());
    s.chat.push(ai(ledger(`${receipt(s, 'long', '挫败')}\n${receipt(s, 'obsession', '放弃')}`)));
    let layers = s.project();
    assert.equal(layers.long.length, 0); assert.equal(layers.archive[0].state, 'abandoned');
    assert.equal(layers.obsession.length, 1); assert.equal(layers.obsession[0].history.length, 1);
    for (let i = 0; i < 12; i++) {
        advance(s, 15); T.dispatchThoughts(s.mem.fate, s.rows());
        s.chat.push(ai(ledger(receipt(s, 'obsession', '挫败'))));
    }
    layers = s.project(); assert.equal(layers.obsession[0].failures, 12);
    advance(s, 15); T.dispatchThoughts(s.mem.fate, s.rows());
    s.chat.push(ai(ledger(receipt(s, 'obsession', '达成'))));
    assert.equal(s.project().obsession.length, 0);
    assert.equal(s.project().archive.at(-1).state, 'completed');
});

test('swipe excludes only replaced visible reply; continue and archived/hidden history stay counted', () => {
    const rows = [{ index: 0, fp: 'a', isUser: false, hidden: true }, { index: 1, fp: 'b', isUser: true },
        { index: 2, fp: 'c', isUser: false }];
    assert.deepEqual(T.generationThoughtRows(rows, [1], 'swipe'), rows.slice(0, 2));
    assert.deepEqual(T.generationThoughtRows(rows, [1, 2], 'continue'), rows);
    assert.equal(T.thoughtClock(rows).turn, 2);
});

test('checkpoint bounds undo data; hiding receipts before and after checkpoint never loses real progress', () => {
    const s = setup();
    T.commitThoughtPlan(s.mem.fate, s.rows(), {}, 'Char1', plan());
    advance(s, 15); T.dispatchThoughts(s.mem.fate, s.rows());
    s.chat.push(ai(ledger(receipt(s, 'long', '进展'))));
    const before = structuredClone(s.project().long[0].history);
    s.chat.at(-1).is_system = true;
    assert.deepEqual(s.project().long[0].history, before);
    advance(s, 140);
    assert.equal(T.compactThoughts(s.mem.fate, s.rows()), true);
    for (const m of s.chat.slice(0, 80)) m.is_system = true;
    assert.equal(T.projectThoughts(s.mem.fate, s.rows()).blocked, false);
    assert.deepEqual(s.project().long[0].history, before);
    advance(s, 1); assert.equal(T.projectThoughts(s.mem.fate, s.rows()).blocked, false);
    s.chat[0].mes = 'edited outside retained undo range';
    assert.equal(T.projectThoughts(s.mem.fate, s.rows()).blocked, true);
    assert.deepEqual(s.project().long[0].history, before);
});

test('save writer serializes delayed writes without replacing live objects or losing newer edits', async () => {
    let finishRead, finishWrite;
    const remote = emptyMemory('fixture');
    remote.fate.lastRunFloor = 999;
    const memory = emptyMemory('fixture'); T.migrateThoughts(memory.fate);
    const fate = memory.fate;
    const writes = [];
    let calls = 0;
    const save = createMemoryWriter({ read: async () => ++calls === 1 ? await new Promise(r => { finishRead = r; }) : remote,
        merge: mergeMemory, write: async (_id, snapshot) => { writes.push(snapshot); if (writes.length === 1) await new Promise(r => { finishWrite = r; }); } });
    const one = save('fixture', memory, {});
    await new Promise(r => setImmediate(r));
    memory.floors.a = { summary: 'edited during read' }; finishRead(remote);
    await new Promise(r => setImmediate(r));
    memory.floors.b = { summary: 'edited during write' };
    const two = save('fixture', memory, {});
    finishWrite(); await Promise.all([one, two]);
    assert.equal(memory.fate, fate);
    assert.equal(writes.length, 2);
    assert.ok(writes[1].floors.a); assert.ok(writes[1].floors.b);
    assert.ok(memory.floors.b);
});

test('async guard invalidates same-chat reopen, import and changed body; failed write can retry', async () => {
    const state = { epoch: 1, memory: {}, config: { enabled: true } }; let signature = 'one';
    const valid = captureGuard(state, () => signature);
    valid(); signature = 'two'; assert.throws(valid, { name: 'AbortError' });
    signature = 'one'; state.epoch++; assert.throws(valid, { name: 'AbortError' });
    let writes = 0;
    const save = createMemoryWriter({ read: async () => null, merge: m => m,
        write: async () => { if (++writes === 1) throw new Error('retry'); } });
    await assert.rejects(save('fixture', {}, {}));
    await save('fixture', {}, {}); assert.equal(writes, 2);
});
