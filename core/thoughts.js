/** Four independent layers. Model output proposes actions; only exact receipts settle them. */
import { hashText } from './fingerprint.js?v=0.13.0';

export const LAYERS = ['short', 'long', 'obsession'];
export const INTERVALS = { short: 5, long: 10, obsession: 15 };
export const clamp = (value, lo, hi, fallback) => Number.isFinite(Number(value)) && value !== null && value !== ''
    ? Math.max(lo, Math.min(hi, Math.trunc(Number(value)))) : fallback;
export const interval = (cfg, layer) => clamp(cfg?.[`${layer}Every`], 1, 999, INTERVALS[layer]);
const copy = value => structuredClone(value);
const text = value => typeof value === 'string' ? value.trim() : '';
const emptyLayers = () => ({ short: null, long: [], obsession: [], archive: [], replacement: null, initialized: false });

/** Hiding an old reply is presentation, not a new branch or a reversal of its elapsed turn. */
export function thoughtClock(rows = []) {
    let anchor = 'root';
    let turn = 0;
    const entries = rows.map(row => {
        anchor = hashText(`${anchor}:${row.fp}`);
        if (!row.isUser) turn++;
        return { ...row, anchor, turn };
    });
    return { anchor, turn, entries };
}

/** SillyTavern removes only the last visible reply from coreChat during swipe. Hidden history stays real. */
export function generationThoughtRows(rows, aligned, type) {
    if (type !== 'swipe') return rows;
    const last = rows.findLast(r => !r.hidden && !r.isUser);
    return last && !aligned.includes(last.index) ? rows.filter(r => r.index !== last.index) : rows;
}

function makeIdea(raw, layer, id, turn) {
    if (!raw || !text(raw.text)) return null;
    const nextAction = text(raw.nextAction || raw.onTrigger || raw.fallback || raw.actWhen);
    return {
        ...copy(raw), id, layer, text: text(raw.text), nextAction,
        state: 'active', createdTurn: turn, dueTurn: turn,
        failureLimit: clamp(raw.failureLimit, 1, 10, 3), failures: 0,
        history: [], pending: null,
    };
}

/** Non-destructive, once-only migration. The old arrays and logs remain available for export. */
export function migrateThoughts(fate) {
    if (fate.thoughtEngine?.version === 1) return false;
    fate.threads ??= {};
    for (const [name, thread] of Object.entries(fate.parked ?? {})) {
        if (!fate.threads[name]) fate.threads[name] = copy(thread);
    }
    const base = {};
    for (const t of Object.values(fate.threads)) {
        if (t.kind !== 'npc') continue;
        const layers = emptyLayers();
        const legacy = [...(t.ideas ?? []), ...(t.parkedIdeas ?? [])];
        legacy.forEach((raw, i) => {
            const idea = makeIdea(raw, 'long', `legacy-${hashText(`${t.name}:${i}:${raw.text}`)}`, 0);
            if (!idea) return;
            if (raw.state && raw.state !== '进行中') {
                idea.state = raw.state === '了了' ? 'completed' : 'abandoned';
                layers.archive.push(idea);
            } else layers.long.push(idea);
        });
        base[t.name] = layers;
    }
    fate.thoughtEngine = { version: 1, base, events: [] };
    // Old name-only confirmations cannot be associated with a new attempt.
    if (fate.pending?.kind !== 'world') {
        if (fate.pending) fate.legacyPending = copy(fate.pending);
        fate.pending = null;
    }
    return true;
}

export function parseThoughtPlan(raw) {
    const source = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let data;
    try { data = JSON.parse(source); } catch { throw new Error('念头回复不是完整 JSON，可以重试'); }
    if (!data || Array.isArray(data) || typeof data !== 'object'
        || !['short', 'long', 'obsession'].every(k => Object.hasOwn(data, k))) {
        throw new Error('念头回复缺少四层字段，可以重试');
    }
    for (const layer of ['long', 'obsession']) {
        if (data[layer] !== undefined && !Array.isArray(data[layer])) throw new Error(`${layer} 必须是数组`);
    }
    if (data.short != null && (typeof data.short !== 'object' || Array.isArray(data.short))) throw new Error('short 必须是念头或 null');
    for (const raw of [...(data.short === null ? [] : [data.short]), ...data.long, ...data.obsession]) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !text(raw.text) || !text(raw.nextAction)) {
            throw new Error('念头必须包含内容和具体下次行动');
        }
    }
    if (data.updates !== undefined && (!Array.isArray(data.updates) || data.updates.some(x => !x || !text(x.id) || !text(x.nextAction)))) {
        throw new Error('updates 必须包含原念头 ID 和具体下次行动');
    }
    return data;
}

/** Receipts are structured, never fuzzy name matches. A bare "happened" is deliberately insufficient. */
export function parseThoughtReceipt(raw) {
    const parts = String(raw ?? '').split(/[|｜]/).map(s => s.trim());
    if (parts.length < 4) return null;
    const [ideaId, attemptId, outcome, result, nextAction = ''] = parts;
    const outcomes = { progress: 'progress', failed: 'failed', completed: 'completed', abandoned: 'abandoned',
        进展: 'progress', 挫败: 'failed', 达成: 'completed', 放弃: 'abandoned' };
    if (!/^[\w-]+$/.test(ideaId) || !/^[\w-]+$/.test(attemptId) || !outcomes[outcome] || !result) return null;
    return { ideaId, attemptId, outcome: outcomes[outcome], result, nextAction };
}

export function activeIdeas(layers) {
    return [layers?.short, ...(layers?.long ?? []), ...(layers?.obsession ?? [])].filter(Boolean);
}

function settle(layers, receipt, row, cfg) {
    const idea = activeIdeas(layers).find(it => it.id === receipt.ideaId);
    if (!idea?.pending || idea.pending.id !== receipt.attemptId || row.turn <= idea.pending.turn) return;
    const attempt = idea.pending;
    const item = { attemptId: attempt.id, action: attempt.action, result: receipt.result,
        outcome: receipt.outcome, turn: row.turn, source: row.anchor };
    if (idea.layer === 'short') {
        layers.short = null;
        layers.replacement = { result: receipt.result, outcome: receipt.outcome, action: attempt.action };
        return;
    }
    idea.history.push(item);
    idea.pending = null;
    if (receipt.outcome === 'failed') idea.failures++;
    const completed = receipt.outcome === 'completed';
    const abandoned = idea.layer === 'long' && (receipt.outcome === 'abandoned' || idea.failures >= idea.failureLimit);
    if (completed || abandoned) {
        idea.state = completed ? 'completed' : 'abandoned';
        idea.archivedTurn = row.turn;
        layers[idea.layer] = layers[idea.layer].filter(it => it.id !== idea.id);
        layers.archive.push(idea);
    } else {
        idea.nextAction = text(receipt.nextAction);
        idea.dueTurn = row.turn + interval(cfg, idea.layer);
    }
}

function applyEvent(all, event, cfg) {
    const layers = all[event.name] ??= emptyLayers();
    if (event.kind === 'manual') {
        all[event.name] = copy(event.data);
    } else if (event.kind === 'plan') {
        const data = event.data;
        for (const layer of LAYERS) {
            const incoming = layer === 'short' ? (data.short ? [data.short] : []) : (data[layer] ?? []);
            // A model never replaces an active goal, promotes a short thought, or deletes an obsession.
            if (layer === 'short' && layers.short) continue;
            const existing = layer === 'short' ? [] : layers[layer];
            for (const [i, raw] of incoming.entries()) {
                if (layers.deletedGoals?.includes(text(raw?.text))) continue;
                if (existing.length >= 3 || existing.some(it => it.text === text(raw?.text))) continue;
                const idea = makeIdea(raw, layer, `${event.id}-${layer}-${i}`, event.turn);
                if (!idea) continue;
                idea.dueTurn = event.turn + interval(cfg, layer);
                if (layer === 'short') { layers.short = idea; layers.replacement = null; break; }
                existing.push(idea);
            }
        }
        for (const update of data.updates ?? []) {
            const idea = activeIdeas(layers).find(it => it.id === update.id);
            if (idea && !idea.pending && text(update.nextAction)) idea.nextAction = text(update.nextAction);
        }
        layers.initialized = true;
    } else if (event.kind === 'dispatch') {
        const idea = activeIdeas(layers).find(it => it.id === event.ideaId);
        if (idea && !idea.pending && idea.nextAction) {
            idea.pending = { id: event.id, turn: event.turn, action: idea.nextAction };
        }
    }
}

/** Replay only operations on this exact prefix. Removed/swiped receipts stop contributing immediately. */
export function projectThoughts(fate, rows = [], cfg = {}) {
    migrateThoughts(fate);
    const engine = fate.thoughtEngine;
    const clock = thoughtClock(rows);
    const all = copy(engine.base);
    const start = engine.baseAnchor ? clock.entries.findIndex(r => r.anchor === engine.baseAnchor) : -1;
    const blocked = !!engine.baseAnchor && start < 0;
    for (const t of Object.values(fate.threads)) if (t.kind === 'npc') all[t.name] ??= emptyLayers();
    const events = new Map();
    for (const event of engine.events) {
        if (!events.has(event.anchor)) events.set(event.anchor, []);
        events.get(event.anchor).push(event);
    }
    const run = anchor => { for (const event of events.get(anchor) ?? []) applyEvent(all, event, cfg); };
    if (!blocked) run(engine.baseAnchor || 'root');
    for (const row of blocked ? [] : clock.entries.slice(start + 1)) {
        if (!row.isUser) {
            for (const receipt of row.record?.thoughtResults ?? []) {
                for (const layers of Object.values(all)) settle(layers, receipt, row, cfg);
            }
        }
        run(row.anchor);
    }
    for (const [name, layers] of Object.entries(all)) {
        if (fate.excludedNames?.includes(name)) { delete all[name]; continue; }
        if (fate.threads[name]) fate.threads[name].thoughts = layers;
    }
    return { ...clock, people: all, blocked };
}

/** Explicit user edits participate in replay; model plans cannot delete goals. */
export function editThoughtLayers(fate, rows, cfg, name, layers) {
    const clock = projectThoughts(fate, rows, cfg);
    if (clock.blocked) throw new Error('编辑超出念头撤销范围，请先恢复原分支');
    if (!layers || !Array.isArray(layers.long) || !Array.isArray(layers.obsession) || !Array.isArray(layers.archive)) throw new Error('念头列表格式不正确');
    for (const idea of [...activeIdeas(layers), ...layers.archive]) {
        if (!idea.id || !Array.isArray(idea.history) || !['short', 'long', 'obsession'].includes(idea.layer)) throw new Error('念头编号、层级或行动历史格式不正确');
    }
    const before = clock.people[name];
    const kept = new Set([...activeIdeas(layers), ...layers.archive].map(it => it.text));
    layers.deletedGoals = [...new Set([...(before?.deletedGoals ?? []), ...(layers.deletedGoals ?? []),
        ...[...activeIdeas(before), ...(before?.archive ?? [])].filter(it => !kept.has(it.text)).map(it => it.text)])];
    fate.thoughtEngine.events.push({ id: `manual-${Date.now()}-${fate.thoughtEngine.events.length}`, kind: 'manual',
        name, anchor: clock.anchor, turn: clock.turn, data: copy(layers) });
    return projectThoughts(fate, rows, cfg);
}

/** Current thought is stripped before the persistent event is created. */
export function commitThoughtPlan(fate, rows, cfg, name, plan) {
    const clock = projectThoughts(fate, rows, cfg);
    if (clock.blocked) throw new Error('修改超出念头撤销范围，已暂停自动更新');
    const layers = clock.people[name] ?? emptyLayers();
    const id = `plan-${hashText(`${name}:${clock.anchor}:${JSON.stringify(plan.short)}:${fate.thoughtEngine.events.length}`)}`;
    const data = {};
    if (!layers.short && plan.short) data.short = copy(plan.short);
    for (const layer of ['long', 'obsession']) {
        const additions = (plan[layer] ?? []).filter(raw => ![...layers[layer], ...layers.archive.filter(it => it.layer === layer)]
            .some(it => it.text === text(raw.text)))
            .slice(0, Math.max(0, 3 - layers[layer].length));
        if (additions.length) data[layer] = copy(additions);
    }
    const updates = (plan.updates ?? []).filter(update => activeIdeas(layers).some(it =>
        it.id === update.id && !it.pending && it.nextAction !== text(update.nextAction)));
    if (updates.length) data.updates = copy(updates);
    if (Object.keys(data).length || !layers.initialized) {
        fate.thoughtEngine.events.push({ id, kind: 'plan', name, anchor: clock.anchor, turn: clock.turn, data });
    }
    const t = fate.threads[name];
    if (text(plan.now)) t.now = text(plan.now);
    return projectThoughts(fate, rows, cfg);
}

/** Each layer has its own schedule, with at most one pending attempt per idea. */
export function dispatchThoughts(fate, rows, cfg = {}) {
    let projected = projectThoughts(fate, rows, cfg);
    if (projected.blocked) return { ...projected, changed: false };
    let changed = false;
    for (const [name, layers] of Object.entries(projected.people)) {
        for (const idea of activeIdeas(layers)) {
            const due = idea.createdTurn === 0 && idea.history.length === 0
                ? Math.max(idea.dueTurn, interval(cfg, idea.layer)) : idea.dueTurn;
            if (idea.pending || !idea.nextAction || projected.turn < due) continue;
            const id = `try-${hashText(`${idea.id}:${idea.history.length}:${projected.anchor}`)}`;
            fate.thoughtEngine.events.push({ id, kind: 'dispatch', name, ideaId: idea.id,
                anchor: projected.anchor, turn: projected.turn });
            changed = true;
        }
    }
    if (changed) projected = projectThoughts(fate, rows, cfg);
    return { ...projected, changed };
}

/** Bound operational undo data, retaining every long/obsession attempt inside the checkpoint. */
export function compactThoughts(fate, rows, cfg = {}) {
    const clock = thoughtClock(rows);
    const engine = fate.thoughtEngine;
    if (!engine || projectThoughts(fate, rows, cfg).blocked) return false;
    let cutoff = clock.entries.findLastIndex(r => r.turn <= clock.turn - 128);
    if (engine.events.length > 512) {
        const boundary = engine.events.at(-256)?.anchor;
        cutoff = Math.max(cutoff, clock.entries.findIndex(r => r.anchor === boundary));
    }
    if (cutoff < 0) {
        // Obsolete branches have no effect and only the most recent 512 operations are undoable.
        if (engine.events.length <= 512) return false;
        const valid = new Set(['root', ...clock.entries.map(r => r.anchor)]);
        engine.events = engine.events.filter(e => valid.has(e.anchor));
        return true;
    }
    const at = clock.entries[cutoff];
    const baseIndex = engine.baseAnchor ? clock.entries.findIndex(r => r.anchor === engine.baseAnchor) : -1;
    if (cutoff < baseIndex || (cutoff === baseIndex && engine.events.length <= 512)) return false;
    const base = copy(projectThoughts(fate, rows.slice(0, cutoff + 1), cfg).people);
    const later = new Set(clock.entries.slice(cutoff + 1).map(r => r.anchor));
    engine.base = base;
    engine.baseAnchor = at.anchor;
    engine.baseTurn = at.turn;
    engine.events = engine.events.filter(e => later.has(e.anchor));
    projectThoughts(fate, rows, cfg);
    return true;
}

export function buildThoughtPrompt(fate, turn) {
    const lines = [];
    for (const t of Object.values(fate.threads ?? {})) for (const it of activeIdeas(t.thoughts)) {
        if (!it.pending) continue;
        const p = it.pending;
        if (turn === p.turn) lines.push(`${t.name}本轮尝试:${p.action}。这是待执行行动，不能当成已经成功。`);
        else lines.push(`${t.name}的尝试等待结果。仅在正文明确给出结果时回执，不能重复执行:${p.action}`);
        lines.push(`本次回执格式:念头✓: ${it.id} | ${p.id} | 进展/挫败/达成/放弃 | 正文实际结果 | 具体下次行动`);
    }
    return lines.length ? ['[独立念头行动]', '没有明确执行结果就不写回执。进展不等于达成长远目标。', ...lines].join('\n') : '';
}

export function buildThoughtMessages({ name, card, story, layers, isPresent, romance = false }) {
    return [
        { role: 'system', content: `为指定人物实时推演独立四层念头。只输出 JSON。只写该人物，不把其他人的动机给他。
格式:{"now":"一句当前状态","current":"此刻一闪而过的想法","short":{"text":"短期念头","nextAction":"具体行动"},"long":[],"obsession":[],"updates":[]}
short 可以为 null。long/obsession 的每项:{"text":"念头","nextAction":"具体下次行动","failureLimit":3}。长期的 failureLimit 根据性格选择 1..10。
四层独立，不把短期升级成长远目标。已有活动念头不重复创建，不改变其层级，不替它宣告成功或放弃。
只为确有依据的空槽提出念头，长期与执念可以一直为空。执念除达成永不消失。
deletedGoals 是用户手工删除的念头，不重新创建或换措辞恢复。
长期和执念必须结合全部历次尝试/行动/结果规划下次行动，updates 格式:{"id":"原念头ID","nextAction":"具体下一步"}。
短期为空且有执行结果时，只根据当前剧情和该结果生成新短期，不续写已删除短期的历史。
current 每次根据最新正文重算，不引用上次的当前想法。不得把计划或尝试当成已经执行。
${romance ? '允许有与 User 无关的感情线，但只能使用材料中已有的人物。' : '不额外杜撰幕后感情线。'}
示例人物只能使用 Char1 / Char2 / User / NPC，实际输出沿用材料提供的称呼。` },
        { role: 'user', content: JSON.stringify({ name, isPresent, card, story,
            active: activeIdeas(layers).map(it => ({ id: it.id, layer: it.layer, text: it.text,
                nextAction: it.nextAction, pending: it.pending, failures: it.failures, failureLimit: it.failureLimit,
                history: it.layer === 'short' ? undefined : it.history })),
            archived: layers?.archive ?? [],
            deletedGoals: layers?.deletedGoals ?? [],
            shortResult: layers?.replacement ?? null }) },
    ];
}
