import { escapeThoughtHtml as esc, currentThoughtHtml, thoughtCard } from './thought-ui.js?v=0.13.0';
import { personEvents } from './dossiers.js?v=0.13.0';

const button = (action, label, name = '') => `<button type="button" class="ihf-btn" data-person-action="${action}" data-name="${esc(name)}">${label}</button>`;

export function dossierHtml({ memory, view, names, selected, detail, here, roleOf, current, configured, choices = {}, exporting = false }) {
    const index = Math.max(0, names.indexOf(selected));
    const name = names[index];
    const tools = `<div class="ihf-acts">${button('add', '添加 char')}${button('add-npc', '添加 NPC')}
        ${button('blocks', '黑名单')}</div><label class="ihf-muted"><input id="ihf-include-user" type="checkbox"> 将 User 纳入人物管理（默认不加入）</label>`;
    if (!name) return tools + '<p class="ihf-muted">还没有人物卡。添加人物，或点击下方「建立人物卡并补好感」。</p><div id="ihf-person-editor"></div>';
    const p = view.people[name] ?? { name, affinity: 0, arcs: [], affinityLog: [], emotionLog: [] };
    const dossier = memory.dossiers?.[name] ?? {};
    const thread = memory.fate?.threads?.[name];
    const state = here.has(name) ? '在场' : thread?.now || '离场，当前状态尚未推演';
    const front = `<div class="ihf-deck" aria-label="人物卡，左右滑动切换"><button type="button" class="ihf-playing-card" data-person-action="flip" data-name="${esc(name)}">
        <span class="ihf-card-corner">${roleOf(name) === 'char' ? '♠' : '♣'}<small>${esc(roleOf(name))}</small></span>
        <span class="ihf-card-name">${esc(name)}</span><span class="ihf-card-score">${p.affinity ?? 0}<small>好感度</small></span>
        <span class="ihf-card-thought">${esc(current[name]?.text || thread?.now || '本轮想法尚未推演')}</span>
        <span class="ihf-card-foot">${esc(state)}<br>点击翻卡，查看全部记录</span></button></div>
        <nav class="ihf-deck-nav" aria-label="选择人物">${button('prev', '← 上一位')}<span>${index + 1} / ${names.length}</span>${button('next', '下一位 →')}</nav>
        <div class="ihf-roster">${names.map(n => `<button type="button" class="ihf-roster-person ${n === name ? 'ihf-on' : ''}" data-person-action="select" data-name="${esc(n)}">${esc(n)} · ${esc(roleOf(n))}${here.has(n) ? ' · 在场' : ''}</button>`).join('')}</div>`;
    if (!detail) return tools + front + '<div id="ihf-person-editor"></div>';
    const events = personEvents(memory, view.rows, name);
    const edit = (target, label, id = '') => `<button type="button" class="ihf-btn" data-edit="${target}" data-name="${esc(name)}" data-id="${esc(id)}">${label}</button>`;
    return tools + `<div class="ihf-person-detail" data-person="${esc(name)}">
        <div class="ihf-acts">${button('back', '← 收起详情')}<b>${esc(name)}</b>
        ${button('role', `当前 ${roleOf(name)}，改为 ${roleOf(name) === 'char' ? 'NPC' : 'char'}`, name)}${button('block', '删除人物并加入黑名单', name)}</div>
        <p class="ihf-muted">${esc(state)}。人物卡跨轮保留；修改和删除记录会保存到本局。</p>
        <div>好感度 <b>${p.affinity ?? 0}</b> ${edit('score', '修改当前分数')}</div>
        <div>性格原句：${esc(memory.origins?.[name] || '尚未摘录')} ${edit('origin', '修改 / 删除原句')}</div>
        ${currentThoughtHtml(current[name], configured)}${edit('current', '修改 / 清除本轮想法')}
        <div>人物备注：${esc(dossier.notes || '无')} ${edit('notes', '编辑备注')}</div>
        <h4>独立念头与全部行动历史</h4>${[thread?.thoughts?.short, ...(thread?.thoughts?.long ?? []), ...(thread?.thoughts?.obsession ?? []), ...(thread?.thoughts?.archive ?? [])].filter(Boolean).map(thoughtCard).join('') || '<p class="ihf-muted">暂无念头记录</p>'}
        ${edit('thoughts', '编辑 / 删除念头和行动记录')}${edit('legacy', '编辑 / 删除旧版记录与幕后状态')}
        <h4>性格演变与好感记录</h4>
        ${(p.arcs ?? []).map(arc => `<div class="ihf-thread"><b>${esc(arc.from || '原句待补')} → ${esc(arc.to || '尚在变化')}</b><div>${esc(arc.state)} · 进度 ${arc.value}</div>
            ${(arc.log ?? []).map(l => `<div class="ihf-muted">第 ${l.index} 层：${l.d > 0 ? '+' : ''}${l.d}，${esc(l.why)}</div>`).join('')}
            ${(arc.breakIf ?? []).map(text => `<div class="ihf-muted">可能动摇：${esc(text)}</div>`).join('')}</div>`).join('') || '<p class="ihf-muted">暂无性格变化</p>'}
        ${edit('anchors', '修改 / 删除性格动摇条件')}
        ${(p.affinityLog ?? []).map(l => `<div>第 ${l.index} 层好感 ${l.d > 0 ? '+' : ''}${l.d}：${esc(l.why)}</div>`).join('')}
        <div>当前情绪：${esc(p.emotion?.kind || '平稳')}${p.emotion?.cause ? `，${esc(p.emotion.cause)}` : ''}</div>
        ${(p.emotionLog ?? []).map(l => `<div class="ihf-muted">${esc(l.kind)}：${esc(l.cause)}，${esc(l.reason)}</div>`).join('')}
        <p class="ihf-muted">这些变化来自下面各层的记录，可逐层修改或删除；性格随保留的记录重新计算。</p>
        <h4>关联事件与逐层记录 (${events.length})</h4>${events.map(event => `<div class="ihf-thread"><b>第 ${event.index} 层 · Day${event.day}</b><p>${esc(event.text)}</p>
            ${edit('event', '修改 / 删除个人事件', event.id)}${edit('record', '修改 / 删除本层全部记录', event.id)}</div>`).join('') || '<p class="ihf-muted">人物在正文中参与事件后会出现在这里。</p>'}
        <div class="ihf-acts">${button('export', '选择写卡资料', name)}</div>
        ${exporting ? exportHtml(events, choices, edit) : ''}
        <div id="ihf-person-editor"></div></div>`;
}

function exportHtml(events, choices, edit) {
    const modes = selected => ['placeholder', 'omit', 'abstract'].map((value, i) => `<option value="${value}"${value === selected ? ' selected' : ''}>${['保留关系，用 {{user}}', '去掉包含 User 的句子', '抽象总结'][i]}</option>`).join('');
    return `<section class="ihf-export-material"><h4>写卡资料预览</h4><p class="ihf-muted">先选择事件和处理方式，再预览或传送。抽象总结需填写或生成后核对。姓名与性格也可在预览里修改。</p>
        <label>统一处理 <select id="ihf-export-all">${modes('placeholder')}</select></label>
        <div class="ihf-acts">${button('select-all', '全选')}${button('select-none', '全不选')}${button('abstract', '生成所选事件的抽象总结')}</div>
        ${events.map(event => { const choice = choices[event.id] ?? { selected: true, mode: 'placeholder' }; return `<div class="ihf-thread">
            <label><input type="checkbox" data-export-select="${esc(event.id)}"${choice.selected ? ' checked' : ''}> 第 ${event.index} 层</label>
            <select data-export-mode="${esc(event.id)}">${modes(choice.mode)}</select><p>${esc(choice.abstractText || event.text)}</p>
            ${edit('abstract', '填写 / 修改抽象总结', event.id)}</div>`; }).join('')}
        ${button('preview', '预览、下载或传送资料')}</section>`;
}
