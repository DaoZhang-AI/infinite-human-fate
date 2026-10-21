import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, reply } from './harness.mjs';
import { allowedPerson, rememberPeople, inheritAffinity, eligibleSummaryIndices, personEvents, cardMaterial } from '../core/dossiers.js';
import { emptyMemory, reconcile } from '../core/memory.js';
import { DEFAULT_PEOPLE } from '../core/people.js';
import { commitThoughtPlan, editThoughtLayers, projectThoughts } from '../core/thoughts.js';
import { buildMemoryBlock } from '../core/assemble.js';
import { fuzzyAgo } from '../core/calendar.js';
import { mergeMemory } from '../store.js';
import { buildLedgerInstruction } from '../core/ledger.js';

test('persistent roster survives absence/reload, role switching creates cards, user aliases excluded, blacklist restores', async () => {
    const { api, context } = await harness();
    api.setRole('Char2', 'main'); api.setRole('NPC', 'npc'); api.refresh();
    assert.equal(api.state.memory.roles.Char2, 'main');
    assert.ok(api.state.memory.dossiers.NPC);
    context.chat = [reply('空场', 0)]; api.refresh();
    assert.ok(api.knownPeople().has('Char2'));
    const memory = JSON.parse(JSON.stringify(api.state.memory));
    api.state.memory = memory; api.refresh();
    assert.ok(api.knownPeople().has('NPC'));
    for (const alias of ['User', '你', '{{user}}']) assert.equal(allowedPerson(memory, alias, 'User'), false);
    memory.personBlocks = { Char2: { blocked: true, updated: 1 } };
    memory.affinityStart.Char2 = { value: 80 };
    api.refresh();
    assert.equal(api.knownPeople().has('Char2'), false);
    assert.equal(api.state.view.people.Char2, undefined);
    assert.equal(memory.fate.threads.Char2, undefined);
    assert.equal(projectThoughts(memory.fate, api.state.view.rows).people.Char2, undefined);
    memory.personBlocks.Char2 = { blocked: false, updated: 2 }; api.refresh();
    assert.ok(api.knownPeople().has('Char2')); assert.ok(memory.fate.threads.Char2);
    assert.equal(api.state.view.people.Char2.affinity, 80);
    assert.equal(rememberPeople(memory, ['Char2', '你'], 'User'), 0);
});

test('absolute affinity inheritance checkpoints avoids double counting/clamp inversion; manual scores survive estimation', async () => {
    const memory = emptyMemory('scores');
    const chat = [reply('Char1 好感度：98\n<ihf-ledger>摘要: 初见\n好感: Char1 +10 初见</ihf-ledger>', 0),
        reply('<ihf-ledger>摘要: 帮忙\n好感: Char1 -5 帮忙</ihf-ledger>', 2)];
    let view = reconcile(memory, chat);
    assert.equal(inheritAffinity(memory, view.rows, chat, ['Char1']), 1);
    view = reconcile(memory, chat);
    assert.equal(view.people.Char1.affinity, 93);
    assert.equal(inheritAffinity(memory, view.rows, chat, ['Char1']), 0);
    chat.push(reply('Char1 好感度：72', 4));
    view = reconcile(memory, chat); inheritAffinity(memory, view.rows, chat, ['Char1']);
    assert.equal(reconcile(memory, chat).people.Char1.affinity, 72);
    const { api, context } = await harness();
    api.state.memory.affinityStart = { Char1: { value: 42, source: 'manual' } };
    context.chat[0].mes += '\nChar2 好感度：61';
    context.ConnectionManagerRequestService.sendRequest = async () => 'Char1 0 估计\nChar2 1 估计\nNPC 12 估计\n你 50 估计';
    await api.startAffinityInit('sub');
    assert.equal(api.state.memory.affinityStart.Char1.value, 42);
    assert.equal(api.state.memory.affinityStart.Char2.value, 61);
    assert.equal(api.state.memory.affinityStart.NPC.value, 12);
    assert.equal(api.state.memory.affinityStart.你, undefined);
});

test('summary delay uses message floors, opening=0, user=1, AI=2; hidden replies do not move eligibility', () => {
    const rows = [0, 1, 2, 3, 4, 5, 6].map(index => ({ index, isUser: index % 2 === 1 }));
    assert.deepEqual(eligibleSummaryIndices(rows.slice(0, 3)), []);
    assert.deepEqual(eligibleSummaryIndices(rows.slice(0, 5)), [0]);
    assert.deepEqual(eligibleSummaryIndices(rows), [0, 2]);
    rows[6].hidden = true;
    assert.deepEqual(eligibleSummaryIndices(rows), [0]);
    assert.doesNotMatch(buildLedgerInstruction({ summary: false }), /摘要:/);
});

test('manual record deletion survives reconciliation, reload and stale remote merge without requeueing', async () => {
    const { api, context, elements } = await harness();
    const old = structuredClone(api.state.memory);
    const fp = api.state.view.rows[0].fp;
    api.state.memory.recordEdits = { [fp]: { deleted: true, updated: 20 } };
    delete api.state.memory.floors[fp]; api.refresh();
    assert.equal(api.state.view.rows[0].record, null);
    assert.deepEqual(Array.from(api.state.view.pending), []);
    const merged = mergeMemory(api.state.memory, old);
    assert.equal(merged.floors[fp], undefined);
    assert.equal(reconcile(merged, context.chat).rows[0].record, null);
    api.testPanel('wuxian'); api.renderTable();
    assert.doesNotMatch(elements.get('ihf-table-view').innerHTML, /Char1 和 Char2 在场/);
});

test('edited records invalidate stale vectors and timeline; newer edits survive merging both directions', () => {
    const local = emptyMemory('edit'); const remote = emptyMemory('edit');
    remote.floors.fp = { summary: 'stale', at: 40, vec: [1] };
    remote.timeline.old = { at: 30, lines: [{ text: 'stale' }] };
    local.floors.fp = { summary: 'edited', at: 50 };
    local.recordEdits = { fp: { updated: 50, record: local.floors.fp } }; local.timelineResetAt = 50;
    local.personBlocks = { Char1: { blocked: false, updated: 60 } };
    remote.personBlocks = { Char1: { blocked: true, updated: 20 } };
    for (const merged of [mergeMemory(local, remote), mergeMemory(remote, local)]) {
        assert.equal(merged.floors.fp.summary, 'edited'); assert.equal(merged.floors.fp.vec, undefined);
        assert.deepEqual(merged.timeline, {}); assert.equal(merged.personBlocks.Char1.blocked, false);
    }
});

test('manual thought edit replays at its real prefix, supports deleting obsession, preserves rollback semantics', () => {
    const memory = emptyMemory('manual');
    const rows = [{ fp: 'a', isUser: false }, { fp: 'b', isUser: true }];
    commitThoughtPlan(memory.fate, rows, {}, 'NPC', { obsession: [{ text: '寻找线索', nextAction: '去档案室' }] });
    let layers = structuredClone(projectThoughts(memory.fate, rows).people.NPC);
    assert.equal(layers.obsession.length, 1);
    layers.obsession = [];
    editThoughtLayers(memory.fate, [...rows, { fp: 'c', isUser: false }], {}, 'NPC', layers);
    assert.equal(projectThoughts(memory.fate, [...rows, { fp: 'c', isUser: false }]).people.NPC.obsession.length, 0);
    commitThoughtPlan(memory.fate, [...rows, { fp: 'c', isUser: false }], {}, 'NPC', { obsession: [{ text: '寻找线索', nextAction: '去档案室' }] });
    assert.equal(projectThoughts(memory.fate, [...rows, { fp: 'c', isUser: false }]).people.NPC.obsession.length, 0);
    assert.equal(projectThoughts(memory.fate, rows).people.NPC.obsession.length, 1);
});

test('events follow exact people; export selection and per-event modes never invent abstraction', () => {
    const memory = emptyMemory('materials');
    const rows = [{ fp: 'a', index: 0, isUser: false, day: 1, record: { summary: 'NPC修好了钟。User给NPC写信。', present: ['NPC'], traits: [] } },
        { fp: 'b', index: 2, isUser: false, day: 2, record: { summary: 'Char1正在读书。', present: ['Char1'] } }];
    const events = personEvents(memory, rows, 'NPC'); assert.equal(events.length, 1);
    const args = { name: 'NPC', role: 'char', origin: '谨慎', events, choices: {}, userName: 'User' };
    assert.equal(cardMaterial(args).events[0].text, 'NPC修好了钟。{{user}}给NPC写信。');
    args.choices.a = { selected: true, mode: 'omit' };
    assert.equal(cardMaterial(args).events[0].text, 'NPC修好了钟。');
    args.choices.a = { selected: true, mode: 'abstract' };
    assert.throws(() => cardMaterial(args), /抽象总结/);
    args.choices.a.abstractText = 'NPC在修复旧物后收到一封信。';
    assert.equal(cardMaterial(args).events[0].text, args.choices.a.abstractText);
    args.choices.a.selected = false; assert.equal(cardMaterial(args).events.length, 0);
    memory.dossiers = { NPC: { events: { a: { deleted: true } } } };
    assert.equal(personEvents(memory, rows, 'NPC').length, 0);
});

test('day counters stay exact while narrative injection uses code-derived relative time', () => {
    const rows = [{ index: 0, day: 1, isUser: false, record: { summary: 'NPC完成学业' } }, { index: 1, day: 568, isUser: false }];
    const result = buildMemoryBlock({ rows, chat: [{ mes: '' }, { mes: '' }], zones: { body: [1], summary: [0], older: [] }, lastDay: 568,
        tier: { memoryChars: 1000 }, archive: false });
    assert.match(result.text, /将近两年前/); assert.doesNotMatch(result.text, /Day568/);
    assert.equal(rows[1].day, 568); assert.equal(fuzzyAgo(400), '一年多前');
});

test('stop aborts request and late result cannot save a record or run a following unit', async () => {
    const { api, context } = await harness();
    let resolve; let signal; let count = 0;
    context.ConnectionManagerRequestService.sendRequest = (_id, _messages, _max, options) => {
        count++; signal = options.signal; return new Promise(r => { resolve = r; });
    };
    const work = api.runJob('fixture', [1, 2], async () => api.callModel([], 'st:fixture'));
    await new Promise(r => setImmediate(r));
    api.stopJob(); assert.equal(signal.aborted, true);
    resolve('late'); await work;
    assert.equal(count, 1); assert.equal(api.state.jobs.done, 0); assert.equal(api.state.jobs.stop, true);
});

test('background render preserves an open person editor; stable summary fills without changing immediate deltas', async () => {
    const { api, context, elements } = await harness();
    api.testPanel('renlei'); api.renderPeople();
    const before = elements.get('ihf-people-view').innerHTML;
    elements.set('ihf-person-editor', { children: [{}] });
    api.state.selectedPerson = 'NPC'; api.renderPeople();
    assert.equal(elements.get('ihf-people-view').innerHTML, before);
    context.chat[0].mes = '<ihf-ledger>在场: Char1\n好感: Char1 +3 帮忙</ihf-ledger>'; api.refresh();
    const old = api.state.view.rows[0].record;
    context.ConnectionManagerRequestService.sendRequest = async () => '<ihf-ledger>摘要: 稳定后的剧情\n好感: Char1 +8 模型重估</ihf-ledger>';
    await api.startBackfill([0], 'sub');
    const record = api.state.memory.floors[api.state.view.rows[0].fp];
    assert.equal(record.summary, '稳定后的剧情');
    assert.equal(JSON.stringify(record.affinity), JSON.stringify(old.affinity));
    assert.equal(record.affinity[0].d, 3);
});

test('actual automatic scheduler waits through floor 2 and generates only floor 0 after floor 4', async () => {
    for (const mode of ['main-inline', 'sub-after']) {
        const { api, context, calls } = await harness();
        api.state.config.ledger.mode = mode; api.state.config.people.enabled = false; api.state.config.fate.enabled = false;
        context.ConnectionManagerRequestService.sendRequest = async (_id, messages) => { calls.push(messages); return '<ihf-ledger>摘要: stable</ihf-ledger>'; };
        context.chat = [reply('opening', 0), reply('user1', 1, true), reply('reply2', 2)];
        api.refresh(); api.state.autoAllowed = true; api.autoJobs();
        await new Promise(r => setImmediate(r)); assert.equal(calls.length, 0);
        context.chat.push(reply('user3', 3, true), reply('reply4', 4)); api.refresh(); api.autoJobs();
        await new Promise(r => setImmediate(r));
        assert.equal(calls.length, 1); assert.equal(api.state.view.rows[0].record.summary, 'stable');
        assert.equal(api.state.view.rows[2].record, null); assert.equal(api.state.view.rows[4].record, null);
    }
});
