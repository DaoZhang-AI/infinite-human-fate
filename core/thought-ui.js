/** Shared by the live panel and the standalone, offline UI fixture. Uses the existing skin classes. */
export const escapeThoughtHtml = value => String(value ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const esc = escapeThoughtHtml;
const kv = (label, value) => `<div class="ihf-kv"><div class="ihf-k">${label}</div><div class="ihf-v">${value}</div></div>`;

export function thoughtCard(idea) {
    const long = idea.layer !== 'short';
    const title = idea.layer === 'long' ? '长期念头' : idea.layer === 'obsession' ? '执念' : '短期念头';
    const history = idea.history ?? [];
    return `<div class="ihf-idea" data-layer="${esc(idea.layer)}">${kv(title, esc(idea.text))}
        ${long ? kv('已经做了', history.length ? `<ol class="ihf-list">${history.map(h =>
            `<li>${esc(h.action)}：${esc(h.result)} <span class="ihf-muted">第 ${h.turn} 回合</span></li>`).join('')}</ol>` : '还没有行动回执') : ''}
        ${long ? kv('现在处在', `第 ${history.length + 1} 次尝试`) : ''}
        ${kv('具体下次行动', esc(idea.pending?.action || idea.nextAction || '等待根据结果规划'))}
        ${kv('状态', idea.state !== 'active' ? (idea.state === 'completed' ? '达成，已归档' : '放弃，已归档')
            : idea.pending ? '已浮现，等待明确结果' : `最早第 ${idea.dueTurn} 回合浮现`)}
        ${long ? kv('挫败回合', `${idea.failures} / ${idea.layer === 'obsession' ? '不因挫败消失' : idea.failureLimit}`) : ''}
    </div>`;
}

export function currentThoughtHtml(current, configured) {
    return kv('目前想法', current?.text ? `${esc(current.text)} <span class="ihf-muted">第 ${current.turn} 回合正文更新后推演</span>`
        : `<span class="ihf-muted">${configured ? '本轮尚未推演，正文更新后刷新' : '配置副 API 后随正文更新，或手动推演'}</span>`);
}

export function awayPeopleHtml(names, threads, role = () => '') {
    return names.map(name => `<div class="ihf-muted ihf-away" data-person="${esc(name)}"><b>${esc(name)}</b> ${role(name)}：${esc(threads?.[name]?.now || '当前状态尚未推演')}</div>`).join('');
}

export function fateThoughtHtml(threads = {}) {
    const cards = [];
    for (const t of Object.values(threads)) {
        if (t.kind !== 'npc') continue;
        const layers = t.thoughts;
        const active = [...(layers?.long ?? []), ...(layers?.obsession ?? [])];
        const archive = layers?.archive ?? [];
        if (!active.length && !archive.length) continue;
        cards.push(`<div class="ihf-thread"><div class="ihf-thread-head"><b>${esc(t.name)}</b></div>${active.map(thoughtCard).join('')}
            ${archive.length ? `<details><summary>已归档 ${archive.length} 件</summary>${archive.map(thoughtCard).join('')}</details>` : ''}</div>`);
    }
    return cards.join('');
}
