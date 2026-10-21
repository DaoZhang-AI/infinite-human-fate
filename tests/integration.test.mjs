import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, reply } from './harness.mjs';
import { commitThoughtPlan, dispatchThoughts, projectThoughts, thoughtClock } from '../core/thoughts.js';
import { reconcile, emptyMemory } from '../core/memory.js';
import { mergeMemory } from '../store.js';
const plan = { current: '看着眼前的饭菜', short: { text: '短期测试', nextAction: '给 User 留言' },
    long: [{ text: '长期测试', nextAction: '与 User 商量计划', failureLimit: 3 }],
    obsession: [{ text: '执念测试', nextAction: '继续寻找证据' }] };

test('actual human/fate renderers: persistent deck opens full away details; fate keeps lasting goals/world', async () => {
    const { api, elements } = await harness();
    for (const name of ['Char1', 'Char2', 'NPC']) commitThoughtPlan(api.state.memory.fate, api.state.view.rows, {}, name, plan);
    api.state.memory.fate.threads.NPC.now = '正在吃饭';
    api.testPanel('renlei'); api.renderPeople();
    const people = elements.get('ihf-people-view').innerHTML;
    assert.match(people, /ihf-playing-card/);
    assert.equal((people.match(/data-person-action="select"/g) ?? []).length, 3);
    api.state.selectedPerson = 'NPC'; api.state.personDetail = true; api.renderPeople();
    assert.match(elements.get('ihf-people-view').innerHTML, /正在吃饭/);
    assert.match(elements.get('ihf-people-view').innerHTML, /目前想法/);
    api.testPanel('mingyun'); api.renderFate();
    const fate = elements.get('ihf-fate-view').innerHTML;
    assert.match(fate, /长期测试/); assert.match(fate, /执念测试/);
    assert.doesNotMatch(fate, /短期测试|目前想法|正在吃饭/);
});

test('explicit empty scene reaches actual UI, including cached v0.11 record repair', async () => {
    const { api, context, elements } = await harness();
    context.chat.push(reply('<ihf-ledger>摘要: 场景已空\n在场: 无\n专名: Char1, Char2</ihf-ledger>', 1));
    api.refresh(); delete api.state.view.rows.at(-1).record.present; api.refresh();
    assert.equal(api.sceneNames().size, 0);
    api.testPanel('renlei'); api.renderPeople();
    const html = elements.get('ihf-people-view').innerHTML;
    assert.equal((html.match(/data-person-action="select"/g) ?? []).length, 3);
    assert.match(html, /离场/);
});

test('real planning uses latest unledgered narrative and stores current thought only in memory cache', async () => {
    const { api, context, calls } = await harness();
    context.chat.push(reply('LATEST_UNLEDGERED_BODY', 1)); api.refresh();
    context.ConnectionManagerRequestService.sendRequest = async (_id, messages) => { calls.push(messages); return JSON.stringify(plan); };
    // One character keeps this integration fast; the batch scheduler is tested independently.
    api.state.memory.fate.threads = { Char1: api.state.memory.fate.threads.Char1 };
    api.state.memory.fate.thoughtEngine.base = {};
    api.state.memory.affinityStart = {};
    context.chat[0].mes = '<ihf-ledger>摘要: Char1\n在场: Char1</ihf-ledger>'; api.refresh();
    await api.startThoughtPlanning('sub');
    assert.ok(calls.some(messages => JSON.stringify(messages).includes('LATEST_UNLEDGERED_BODY')));
    assert.equal(api.state.currentThoughts.Char1.text, plan.current);
    assert.equal(JSON.stringify(api.state.memory).includes(plan.current), false);
    const count = calls.length;
    api.testPanel('renlei'); api.renderPeople(); api.renderPeople();
    assert.equal(calls.length, count);
});

test('delayed model response cannot mutate another chat or a changed body', async () => {
    for (const change of ['chat', 'body']) {
        const { api, context } = await harness();
        api.state.memory.fate.threads = { Char1: api.state.memory.fate.threads.Char1 };
        api.state.memory.affinityStart = {};
        context.chat[0].mes = '<ihf-ledger>摘要: Char1\n在场: Char1</ihf-ledger>'; api.refresh();
        let resolve;
        context.ConnectionManagerRequestService.sendRequest = () => new Promise(r => { resolve = r; });
        const work = api.startThoughtPlanning('sub');
        await new Promise(r => setImmediate(r));
        if (change === 'chat') { api.state.epoch++; api.state.memory = emptyMemory('other'); }
        else context.chat[0].mes += '\nchanged';
        resolve(JSON.stringify(plan)); await work;
        assert.equal(api.state.currentThoughts.Char1, undefined);
        assert.equal(api.state.memory.fate.thoughtEngine?.events?.length ?? 0, 0);
    }
});

test('real interceptor planning uses swipe prefix, keeps hidden history, and continue does not start new attempt', async () => {
    const { api, context } = await harness();
    commitThoughtPlan(api.state.memory.fate, api.state.view.rows, { longEvery: 1 }, 'Char1', plan);
    for (let i = 1; i < 12; i++) context.chat.push(reply(`body ${i}`, i));
    api.refresh();
    dispatchThoughts(api.state.memory.fate, api.state.view.rows);
    const original = projectThoughts(api.state.memory.fate, api.state.view.rows).people.Char1.long[0];
    context.chat.push(reply(`<ihf-ledger>摘要: 行动失败\n念头✓: ${original.id} | ${original.pending.id} | 挫败 | 没有接通 | 下次再联系</ihf-ledger>`, 12));
    api.refresh(); assert.equal(api.state.memory.fate.threads.Char1.thoughts.long[0].failures, 1);
    context.chat[0].is_system = true;
    await api.planRun(context.chat.filter(m => !m.is_system).slice(0, -1), 'swipe');
    assert.equal(api.state.memory.fate.threads.Char1.thoughts.long[0].failures, 0);
    assert.equal(api.state.thoughtProjection.turn, 12);
    const before = api.state.memory.fate.thoughtEngine.events.length;
    await api.planRun(context.chat.filter(m => !m.is_system), 'continue');
    assert.equal(api.state.memory.fate.threads.Char1.thoughts.long[0].failures, 1);
    assert.equal(api.state.memory.fate.thoughtEngine.events.length, before);
});

test('two-device newer remote engine creates a visible save conflict and does not overwrite either copy', async () => {
    const { api, sandbox, timers } = await harness();
    const local = api.state.memory;
    commitThoughtPlan(local.fate, api.state.view.rows, {}, 'Char1', plan);
    const remote = structuredClone(local); remote.rev = 10;
    remote.fate.thoughtEngine.base.Char1 = { preserve: 'remote progress' };
    const before = JSON.stringify(local);
    assert.throws(() => mergeMemory(local, remote), { name: 'MemoryConflictError' });
    assert.equal(JSON.stringify(local), before);
    let uploads = 0;
    sandbox.fetch = async (_url, options) => { if (options?.method === 'POST') uploads++; return { ok: true, json: async () => remote }; };
    await api.saveMemory();
    assert.equal(uploads, 0); assert.equal(api.state.saveConflict, true);
    assert.match(api.state.error, /导出本地记忆/);
    assert.equal([...timers.values()].filter(t => t.ms === 15000).length, 0);
    await api.saveMemory(); assert.equal(uploads, 0);
});

test('opening chat does not issue model requests; memory file reads use mocks only', async () => {
    const { api, sandbox, calls } = await harness();
    const memory = structuredClone(api.state.memory);
    sandbox.fetch = async url => ({ ok: true, status: 200, json: async () => String(url).includes('.index.') ? { chats: { fixture: 'fixture' } } : memory });
    await api.openChat();
    assert.equal(calls.length, 0); assert.equal(api.state.autoAllowed, false);
    api.autoJobs(); assert.equal(calls.length, 0);
});
