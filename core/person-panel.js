import { rememberPeople, personEvents, cardMaterial, allowedPerson } from './dossiers.js?v=0.13.0';
import { editThoughtLayers, projectThoughts } from './thoughts.js?v=0.13.0';
import { anchorKey } from './people.js?v=0.13.0';

/** Local editor. No writes to chat messages, credentials, or external applications. */
export function mountPersonHandlers({ state, ctx, render, refresh, scheduleSave, setRole, knownPeople, runJob, callModel, backendOf, roleOf, stop }) {
    const panel = document.getElementById('ihf-panel');
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const labels = { summary: '本层摘要', names: '涉及的人与地点', present: '在场人物', timeRaw: '经过时间', abs: '精确 Day', place: '地点', timeOfDay: '时段',
        affinity: '好感变化', traits: '性格变化', emotions: '情绪变化', breaks: '性格动摇', items: '物品', promisesMade: '新约定', promisesSettled: '已结约定',
        thoughtResults: '念头执行结果', fateDone: '幕后事件结果', name: '人物 / 名称', d: '变化分数', why: '原因', to: '变成 / 交给', from: '来自',
        kind: '类别', now: '当前幕后状态', ideas: '旧版念头', parkedIdeas: '旧版暂存念头', log: '历史记录', text: '内容', day: '剧情 Day',
        short: '短期念头', long: '长期念头', obsession: '执念', archive: '已归档念头', replacement: '上次短期结果', initialized: '已推演',
        layer: '层级', state: '状态', createdTurn: '建立回合', dueTurn: '最早浮现回合', failureLimit: '挫败上限', failures: '当前挫败次数',
        history: '历次行动', pending: '等待结果的尝试', action: '行动', result: '结果', outcome: '结果类别', turn: '回合', nextAction: '下次行动',
        onTrigger: '触发后行动', fallback: '等不到时', on: '触发时机', surfacedAt: '浮现层', at: '记录时间', moved: '发生转移', holder: '持有人',
        breakIf: '可能动摇的事件', seq: '性格弧编号', onFailure: '挫败后', bornDay: '建立 Day', bornFloor: '建立层', lastDay: '最近 Day', deletedGoals: '已删除念头（避免自动重复）',
    };
    let start;
    panel.addEventListener('touchstart', e => { if (e.target.closest('.ihf-deck')) start = e.touches[0].clientX; }, { passive: true });
    panel.addEventListener('touchend', e => {
        if (start === undefined) return;
        const dx = e.changedTouches[0].clientX - start; start = undefined;
        if (Math.abs(dx) > 45) { state.swipedUntil = Date.now() + 400; navigate(dx < 0 ? 1 : -1); }
    }, { passive: true });
    function navigate(delta) {
        const names = [...knownPeople()];
        if (!names.length) return;
        state.selectedPerson = names[(Math.max(0, names.indexOf(state.selectedPerson)) + delta + names.length) % names.length];
        state.personDetail = false; state.exportingPerson = ''; render();
    }
    let editorHost = 'ihf-person-editor';
    function editor(title, value, save, { json = false, remove = null, after = '' } = {}) {
        const el = document.getElementById(editorHost);
        const epoch = state.epoch;
        if (!el) return;
        const raw = json === 'raw';
        let draft = structuredClone(value);
        el.innerHTML = `<section class="ihf-card ihf-form" role="region" aria-label="${esc(title)}"><h4>${esc(title)}</h4>
            ${json && !raw ? '<div class="ihf-fields"></div>' : `<textarea rows="10" aria-label="${esc(title)}">${esc(raw ? JSON.stringify(value, null, 2) : value)}</textarea>`}
            <div class="ihf-acts"><button class="ihf-btn ihf-primary" data-editor="save">保存</button>${remove ? '<button class="ihf-btn" data-editor="delete">删除这项记录</button>' : ''}<button class="ihf-btn" data-editor="cancel">取消</button></div>
            <div class="ihf-error" role="status"></div>${after}</section>`;
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        el.querySelector('[data-editor="cancel"]').onclick = () => { el.innerHTML = ''; };
        if (json && !raw) {
            const fields = el.querySelector('.ihf-fields');
            const draw = () => {
                fields.replaceChildren();
                function field(parent, key, container, label, canRemove = false) {
                    const item = parent[key];
                    if (['id', 'ideaId', 'attemptId', 'source', 'anchor', 'at', 'vec'].includes(String(key))) return;
                    const row = document.createElement('div'); row.className = 'ihf-edit-field';
                    const head = document.createElement('label'); head.textContent = label;
                    row.appendChild(head); container.appendChild(row);
                    if (item !== null && typeof item === 'object') {
                        for (const child of Object.keys(item)) field(item, child, row, Array.isArray(item) ? `第 ${Number(child) + 1} 项` : labels[child] || child, Array.isArray(item));
                        if (!Object.keys(item).length) row.appendChild(document.createTextNode('暂无记录'));
                        const scalarLists = ['names', 'present', 'promisesMade', 'promisesSettled', 'fateDone', 'breakIf'];
                        const templates = { affinity: { name: person(), d: 0, why: '' }, traits: { name: person(), d: 0, to: '', why: '' },
                            emotions: { name: person(), kind: '平稳', why: '' }, breaks: { name: person(), why: '' },
                            items: { name: '', from: '', to: '', why: '', moved: true } };
                        if (Array.isArray(item) && (scalarLists.includes(key) || templates[key])) {
                            const add = document.createElement('button'); add.type = 'button'; add.className = 'ihf-btn'; add.textContent = '新增一项';
                            add.onclick = () => { item.push(templates[key] ? structuredClone(templates[key]) : ''); draw(); }; row.appendChild(add);
                        }
                    } else {
                        const numeric = typeof item === 'number' || key === 'abs';
                        const input = document.createElement(typeof item === 'boolean' || numeric ? 'input' : 'textarea');
                        input.setAttribute('aria-label', label);
                        if (typeof item === 'boolean') { input.type = 'checkbox'; input.checked = item; }
                        else if (numeric) { input.type = 'number'; input.value = item ?? ''; }
                        else { input.rows = 2; input.value = item ?? ''; }
                        input.oninput = () => { parent[key] = typeof item === 'boolean' ? input.checked : numeric ? (input.value === '' && key === 'abs' ? null : Number(input.value)) : input.value; };
                        row.appendChild(input);
                    }
                    if (canRemove) {
                        const del = document.createElement('button'); del.type = 'button'; del.className = 'ihf-btn'; del.textContent = '删除此项';
                        del.onclick = () => { parent.splice(Number(key), 1); draw(); }; row.appendChild(del);
                    }
                }
                const root = { value: draft };
                field(root, 'value', fields, '记录内容');
            };
            draw();
        }
        const act = fn => { try {
            if (state.epoch !== epoch) throw new Error('聊天已经切换，请重新打开编辑');
            fn(); el.innerHTML = ''; scheduleSave(); refresh();
        } catch (e) { el.querySelector('[role="status"]').textContent = e.message; } };
        el.querySelector('[data-editor="save"]').onclick = () => act(() => {
            const text = json && !raw ? null : el.querySelector('textarea').value;
            save(raw ? JSON.parse(text) : json ? draft : text);
        });
        if (remove) el.querySelector('[data-editor="delete"]').onclick = () => act(() => remove());
        return el;
    }
    const person = () => state.selectedPerson || [...knownPeople()][0];
    const events = () => personEvents(state.memory, state.view.rows, person());
    const choice = id => state.exportChoices[id] ??= { selected: true, mode: 'placeholder' };
    function invalidate() {
        // Any timeline may contain this edited fact. Discard its derived summaries, retain source floors.
        state.memory.timeline = {};
        state.memory.timelineResetAt = Date.now();
    }
    function editRecord(fp) {
        const original = state.memory.floors[fp];
        const record = original ? { place: '', timeOfDay: '', abs: null, ...original } : null;
        if (!record) return;
        editor('本层记录：修改内容或删除单项，保存后重新计算人物状态', record, value => {
            if (!value || Array.isArray(value) || typeof value !== 'object' || typeof value.summary !== 'string') throw new Error('记录需要是对象，并保留 summary 文本字段');
            for (const k of ['names', 'present', 'affinity', 'traits', 'emotions', 'breaks', 'items', 'promisesMade', 'promisesSettled', 'thoughtResults']) {
                if (value[k] !== undefined && !Array.isArray(value[k])) throw new Error(`${k} 需要是列表`);
                if (Array.isArray(value[k]) && value[k].some(x => k === 'names' || k === 'present' ? typeof x !== 'string' : !x || typeof x !== 'object')) throw new Error(`${k} 列表格式不正确`);
            }
            delete value.vec;
            value.at = Date.now(); value.source = 'manual';
            state.memory.floors[fp] = value;
            (state.memory.recordEdits ??= {})[fp] = { updated: Date.now(), record: structuredClone(value), deleted: false };
            invalidate();
        }, { json: true, remove: () => {
            delete state.memory.floors[fp];
            (state.memory.recordEdits ??= {})[fp] = { updated: Date.now(), deleted: true };
            invalidate();
        } });
    }
    function exportPreview() {
        const name = person();
        const payload = cardMaterial({ name, role: roleOf(name),
            origin: state.memory.origins?.[name], person: state.view.people[name], events: events(), choices: state.exportChoices, userName: ctx().name1 });
        const el = editor('资料最终预览：可在传送前修改任意文字', payload, () => {}, { json: 'raw',
            after: '<div class="ihf-acts"><button class="ihf-btn" data-deliver="download">下载资料</button><button class="ihf-btn" data-deliver="send">传送给写卡插件</button></div>' });
        if (!el) return;
        const read = () => {
            const data = JSON.parse(el.querySelector('textarea').value);
            if (data.format !== 'ihf-card-material' || data.version !== 1 || !data.character || !Array.isArray(data.events)) throw new Error('资料格式不正确');
            return data;
        };
        el.querySelectorAll('[data-deliver]').forEach(btn => btn.onclick = () => {
            try {
                const data = read();
                if (btn.dataset.deliver === 'download') {
                    const link = document.createElement('a'); const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
                    link.href = url; link.download = 'character-material.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
                } else {
                    let received = false;
                    // An installed card editor explicitly acknowledges this user-initiated request.
                    document.dispatchEvent(new CustomEvent('ihf:card-material', { detail: { payload: structuredClone(data), accept: () => { received = true; } } }));
                    el.querySelector('[role="status"]').textContent = received ? '写卡插件已接收资料' : '尚无写卡插件接收，资料可下载后导入';
                }
            } catch (e) { el.querySelector('[role="status"]').textContent = e.message; }
        });
    }
    panel.addEventListener('change', async e => {
        const target = e.target;
        if (target.id === 'ihf-include-user') {
            const { saveConfigPatch } = await import('../store.js?v=0.13.0');
            state.config = await saveConfigPatch({ people: { includeUser: target.checked } }, ctx().getRequestHeaders());
            refresh();
        }
        if (target.dataset.exportSelect) choice(target.dataset.exportSelect).selected = target.checked;
        if (target.dataset.exportMode) { choice(target.dataset.exportMode).mode = target.value; render(); }
        if (target.id === 'ihf-export-all') { for (const event of events()) choice(event.id).mode = target.value; render(); }
    });
    panel.addEventListener('click', async e => {
        const target = e.target.closest('[data-person-action], [data-edit], [data-table-edit]');
        if (!target || !state.memory) return;
        const name = target.dataset.name || person();
        try {
            if (target.dataset.personAction) document.getElementById('ihf-person-editor')?.replaceChildren();
            if (target.dataset.tableEdit) { editorHost = 'ihf-table-editor'; editRecord(target.dataset.tableEdit); return; }
            editorHost = 'ihf-person-editor';
            if (target.dataset.edit) {
                const dossier = state.memory.dossiers[name] ??= { name, created: Date.now() };
                const update = fn => value => { fn(value); dossier.updated = Date.now(); };
                switch (target.dataset.edit) {
                    case 'record': editRecord(target.dataset.id); break;
                    case 'notes': editor('人物备注', dossier.notes || '', update(v => { dossier.notes = v; }), { remove: update(() => { dossier.notes = ''; }) }); break;
                    case 'anchors': {
                        const rows = (state.view.people[name]?.arcs ?? []).map(arc => ({ seq: arc.seq, breakIf: [...arc.breakIf] }));
                        const save = entries => {
                            if (!Array.isArray(entries) || entries.some(v => !Number.isInteger(v.seq) || v.seq < 1 || !Array.isArray(v.breakIf) || v.breakIf.some(t => typeof t !== 'string'))) throw new Error('性格弧编号与动摇条件格式不正确');
                            for (const arc of rows) state.memory.anchors[anchorKey(name, arc.seq)] = { name, seq: arc.seq, breakIf: [], manual: true, at: Date.now() };
                            for (const arc of entries) state.memory.anchors[anchorKey(name, arc.seq)] = { ...arc, name, manual: true, at: Date.now() };
                        };
                        editor('性格动摇条件：可删去单条条件，手改后不再自动覆盖', rows, save, { json: true, remove: () => save([]) }); break;
                    }
                    case 'origin': editor('性格原句', state.memory.origins[name] || '', update(v => { state.memory.origins[name] = v; }), { remove: update(() => { state.memory.origins[name] = ''; }) }); break;
                    case 'score': editor('当前好感度（-100 至 100）', state.view.people[name]?.affinity ?? 0, v => {
                        if (!v.trim() || !Number.isFinite(Number(v)) || Number(v) < -100 || Number(v) > 100) throw new Error('请填 -100 至 100 的数值');
                        state.memory.affinityStart[name] = { value: Math.trunc(Number(v)), source: 'manual', why: '手工校正当前分数', coveredFps: state.view.rows.filter(r => !r.isUser).map(r => r.fp) };
                    }); break;
                    case 'current': editor('本轮想法（下一轮重新推演）', state.currentThoughts[name]?.text || '', v => {
                        state.currentThoughts[name] = { text: v, anchor: state.thoughtRetryAnchor, turn: state.thoughtProjection?.turn ?? 0, manual: true };
                    }, { remove: () => { state.currentThoughts[name] = { text: '', anchor: state.thoughtRetryAnchor, turn: state.thoughtProjection?.turn ?? 0, manual: true }; } }); break;
                    case 'event': {
                        const event = events().find(x => x.id === target.dataset.id);
                        editor('个人事件摘要', event?.text || '', update(v => { (dossier.events ??= {})[target.dataset.id] = { text: v }; }),
                            { remove: update(() => { (dossier.events ??= {})[target.dataset.id] = { deleted: true }; }) }); break;
                    }
                    case 'abstract': editor('去掉用户关系，写成独立经历的抽象总结', choice(target.dataset.id).abstractText || '', v => { choice(target.dataset.id).abstractText = v; }); break;
                    case 'thoughts': {
                        const layers = projectThoughts(state.memory.fate, state.view.rows, state.config.fate).people[name];
                        editor('念头与行动历史：可删除单项或修改内容', layers, v => editThoughtLayers(state.memory.fate, state.view.rows, state.config.fate, name, v), { json: true,
                            remove: () => editThoughtLayers(state.memory.fate, state.view.rows, state.config.fate, name, { short: null, long: [], obsession: [], archive: [], replacement: null, initialized: true }) }); break;
                    }
                    case 'legacy': {
                        const thread = state.memory.fate.threads[name];
                        editor('旧版记录与当前幕后状态', { now: thread?.now || '', ideas: thread?.ideas ?? [], parkedIdeas: thread?.parkedIdeas ?? [], log: thread?.log ?? [] }, v => {
                            if (!v || typeof v.now !== 'string' || !['ideas', 'parkedIdeas', 'log'].every(k => Array.isArray(v[k]))) throw new Error('状态应为文本，记录应为列表');
                            Object.assign(thread, v);
                        }, { json: true, remove: () => Object.assign(thread, { now: '', ideas: [], parkedIdeas: [], log: [] }) }); break;
                    }
                }
                return;
            }
            switch (target.dataset.personAction) {
                case 'prev': navigate(-1); return;
                case 'next': navigate(1); return;
                case 'select': state.selectedPerson = name; state.personDetail = false; state.exportingPerson = ''; break;
                case 'flip': {
                    if (Date.now() < (state.swipedUntil ?? 0)) return;
                    const epoch = state.epoch;
                    target.classList.add('ihf-flipping');
                    setTimeout(() => { if (epoch === state.epoch) { state.personDetail = true; render(); } }, 220); return;
                }
                case 'back': state.personDetail = false; state.exportingPerson = ''; break;
                case 'role': setRole(name, roleOf(name) === 'char' ? 'npc' : 'main'); return;
                case 'add': case 'add-npc': {
                    editor('输入人物的准确姓名（不会合并相似姓名）', '', value => {
                        const n = value.trim();
                        if (!allowedPerson(state.memory, n, ctx().name1, state.config.people.includeUser)) throw new Error('姓名为空、在黑名单中，或 User 纳入开关尚未开启');
                        rememberPeople(state.memory, [n], ctx().name1, state.config.people.includeUser);
                        setRole(n, target.dataset.personAction === 'add' ? 'main' : 'npc');
                    }); return;
                }
                case 'block': {
                    editor(`确认删除 ${name} 并加入黑名单，输入姓名确认；可在黑名单中恢复`, '', value => {
                        if (value !== name) throw new Error('姓名不一致');
                        (state.memory.personBlocks ??= {})[name] = { blocked: true, updated: Date.now() };
                        stop(); state.personDetail = false; delete state.currentThoughts[name];
                    }); return;
                }
                case 'blocks': {
                    const blocks = Object.entries(state.memory.personBlocks ?? {}).filter(([, v]) => v.blocked).map(([n]) => n);
                    editor('黑名单：删除名单中的姓名即可恢复原人物卡', blocks, value => {
                        if (!Array.isArray(value) || value.some(n => typeof n !== 'string')) throw new Error('请保留姓名列表格式');
                        for (const n of new Set([...blocks, ...value])) (state.memory.personBlocks ??= {})[n] = { blocked: value.includes(n), updated: Date.now() };
                    }, { json: true }); return;
                }
                case 'export': state.exportingPerson = name; break;
                case 'select-all': case 'select-none': for (const event of events()) choice(event.id).selected = target.dataset.personAction === 'select-all'; break;
                case 'abstract': {
                    const todo = events().filter(event => choice(event.id).selected && choice(event.id).mode === 'abstract');
                    if (!todo.length) throw new Error('先将需要处理的事件选为「抽象总结」');
                    const backend = backendOf(state.config.jobs.backfillBackend);
                    if (!backend) throw new Error('先选择可用连接，或直接填写抽象总结');
                    await runJob('生成写卡抽象总结', todo, async event => {
                        const out = await callModel([{ role: 'system', content: '将所给人物经历概括为独立的人生事件。去掉与用户的特定关系和用户身份，不出现用户姓名、你、User或占位符。不添加事实。只返回一句总结。示例只用 Char1 / Char2 / User / NPC。' },
                            { role: 'user', content: JSON.stringify({ character: name, user: ctx().name1, event: event.text }) }], backend);
                        if (!out.trim()) throw new Error('没有生成抽象总结');
                        choice(event.id).abstractText = out.trim();
                    }); break;
                }
                case 'preview': exportPreview(); return;
            }
            render();
        } catch (error) { toastr.error(error.message, '模拟人生'); }
    });
}
