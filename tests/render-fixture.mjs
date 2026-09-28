import { readFile, writeFile } from 'node:fs/promises';
import { harness } from './harness.mjs';
import { commitThoughtPlan } from '../core/thoughts.js';

const { api, elements } = await harness();
const plan = { current: '想把这顿饭安静吃完', short: { text: '给 User 留言', nextAction: '饭后发一条消息' },
    long: [{ text: '和 User 一起完成计划', nextAction: '先询问 User 下周的安排', failureLimit: 4 }],
    obsession: [{ text: '找回遗失的证据', nextAction: '再去旧档案里寻找线索' }] };
for (const name of ['Char1', 'Char2', 'NPC']) {
    commitThoughtPlan(api.state.memory.fate, api.state.view.rows, {}, name, plan);
    api.state.currentThoughts[name] = { text: plan.current, turn: 1 };
}
api.state.memory.fate.threads.NPC.now = '正在整理档案，暂时没看消息';
api.testPanel('renlei'); api.renderPeople();
const people = elements.get('ihf-people-view').innerHTML;
api.testPanel('mingyun'); api.renderFate();
const fate = elements.get('ihf-fate-view').innerHTML;
const uiSource = await readFile(new URL('../ui.js', import.meta.url), 'utf8');
const css = uiSource.match(/const CSS = `([\s\S]*?)`;/)[1];
const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>四层念头 · 离线 UI fixture</title><style>${css}
body {background:#171721;color:#eee;font-family:system-ui;margin:20px}
#ihf-panel {position:static;transform:none;width:min(960px,100%);height:auto;max-height:none;margin:auto;overflow:visible}
.fixture-content {padding:20px}.fixture-panel[hidden]{display:none}button{cursor:pointer}
</style><body><main id="ihf-panel" data-theme="night"><div class="fixture-content">
<h2>四层念头 · 离线审查</h2><p>使用实际渲染函数与合成数据生成。无网络，无用户数据，不连接酒馆。</p>
<button data-view="people">人类</button> <button data-view="fate">命运</button>
<section id="people" class="fixture-panel">${people}</section><section id="fate" class="fixture-panel" hidden>${fate}</section>
</div></main><script>document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>document.querySelectorAll('.fixture-panel').forEach(p=>p.hidden=p.id!==b.dataset.view));</script></body></html>`;
await writeFile(new URL('./ui-fixture.html', import.meta.url), html.replace(/[\t ]+$/gm, ''), 'utf8');
console.log('Wrote tests/ui-fixture.html from actual panel renderers.');
