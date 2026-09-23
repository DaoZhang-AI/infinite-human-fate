/**
 * 界面外壳:悬浮球 + 弹出面板 + 三个分页。
 *
 * 为什么不用酒馆的扩展抽屉(道长 2026-09-12):"太不方便了",一堆按钮和红字堆在抽屉里,
 * 要用还得先展开扩展栏、再找到它、再展开。改成跟织梦者那只蝴蝶一样的悬浮球:
 * 随便拖、停在边上会半隐藏、点开是正经面板。
 *
 * 配色照梦游助手那一套(它面板里的 CSS 段),
 * 夜间是蓝紫塔罗、白天是羊皮纸,`🌗` 手动切,固定色值不跟酒馆主题跑。
 * 类名前缀用 ihf- 不用 wx-,免得跟梦游助手的面板撞车。
 *
 * 这个文件只管壳:球、遮罩、分页、拖动、日夜。每一页里塞什么由 index.js 渲染。
 */

export const TABS = [
    // 道长 9/23:人类和无限对调。人类是她每层都看的,排第一页,面板打开就停在这儿
    { key: 'renlei', icon: '👥', name: '人类', hint: '好感 · 性格弧 · 情绪 · 约定 · 物品' },
    { key: 'wuxian', icon: '♾️', name: '无限', hint: '摘要 · 时间线 · 召回' },
    { key: 'mingyun', icon: '🎲', name: '命运', hint: 'NPC 与世界的幕后' },
];

/** 设置和帮助不占分页,挂在标题栏右上角,小一点(道长要的) */
export const PAGES = [
    { key: 'shezhi', icon: '⚙️', name: '设置' },
    { key: 'bangzhu', icon: '❓', name: '帮助' },
];

const CSS = `
/* ── 悬浮球 ── */
#ihf-ball {
  position: fixed; right: 12px; top: 40vh;
  z-index: 9998;
  width: 38px; height: 38px;
  display: flex; align-items: center; justify-content: center;
  font-size: 20px; line-height: 1;
  border-radius: 50%;
  background: var(--ihf-bg, #161225);
  border: 1px solid var(--ihf-border, rgba(140,130,200,.25));
  box-shadow: 0 4px 14px rgba(0,0,0,.35);
  cursor: grab; user-select: none; touch-action: none;
  transition: opacity .25s, transform .25s;
}
#ihf-ball:active { cursor: grabbing; }
#ihf-ball.ihf-busy .ihf-ball-icon { animation: ihf-spin 1.4s linear infinite; }
@keyframes ihf-spin { to { transform: rotate(360deg); } }
/* 停在边上就缩进去一半,不挡正文(道长要的) */
#ihf-ball.ihf-tuck-right { transform: translateX(45%); opacity: .45; }
#ihf-ball.ihf-tuck-left  { transform: translateX(-45%); opacity: .45; }
#ihf-ball:hover { transform: none !important; opacity: 1; }
#ihf-ball .ihf-ball-dot {
  position: absolute; top: 1px; right: 1px;
  width: 8px; height: 8px; border-radius: 50%;
  background: #e0a040; display: none;
}
#ihf-ball.ihf-warn .ihf-ball-dot { display: block; }

/* ── 遮罩与面板 ── */
#ihf-overlay {
  /* 酒馆 html 带 transform 时 fixed 的 inset/百分比会塌成 0(iPad 飞顶),一律用视口单位 */
  position: fixed; top: 0; left: 0; z-index: 99998;
  width: 100vw; height: 100vh; height: 100dvh;
  display: flex; overflow-y: auto; box-sizing: border-box; padding: 12px 0;
  background: rgba(0,0,0,.55);
  opacity: 0; pointer-events: none; transition: opacity .25s ease;
}
#ihf-overlay.ihf-visible { opacity: 1; pointer-events: auto; }
#ihf-panel {
  --ihf-bg: #161225;
  --ihf-bg2: rgba(130,120,200,.08);
  --ihf-bg3: rgba(130,120,200,.15);
  --ihf-text: #e6e2f4;
  --ihf-text2: #b6b0cf;
  --ihf-border: rgba(140,130,200,.2);
  --ihf-accent: #a78bfa;
  --ihf-input-bg: rgba(0,0,0,.3);
  position: relative; margin: auto;
  transform: scale(.95);
  transition: transform .2s;
  width: 92vw; max-width: 560px; max-height: 88vh; max-height: 88dvh;
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--ihf-bg); color: var(--ihf-text);
  border: 1px solid var(--ihf-border); border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0,0,0,.5);
}
#ihf-overlay.ihf-visible #ihf-panel { transform: scale(1); }
#ihf-panel.ihf-day {
  --ihf-bg: #f0e6d2;
  --ihf-bg2: rgba(120,90,50,.08);
  --ihf-bg3: rgba(120,90,50,.14);
  --ihf-text: #3d3427;
  --ihf-text2: #5f5444;
  --ihf-border: rgba(120,90,50,.2);
  --ihf-accent: #8b6914;
  --ihf-input-bg: rgba(255,255,255,.5);
  box-shadow: 0 16px 48px rgba(80,60,20,.25);
}

.ihf-head {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--ihf-border);
  background: var(--ihf-bg2);
  flex-shrink: 0;
}
.ihf-head-title { font-size: .95em; font-weight: 600; letter-spacing: .02em; }
.ihf-head-ver { font-size: .72em; color: var(--ihf-text2); font-weight: 400; margin-left: 6px; }
.ihf-head-spacer { flex: 1 1 auto; }
.ihf-icon-btn {
  background: none; border: none; color: var(--ihf-text2);
  cursor: pointer; font-size: .95em; opacity: .65;
  padding: 3px 6px; border-radius: 6px; line-height: 1;
  transition: opacity .15s, background .15s, color .15s;
}
.ihf-icon-btn:hover { opacity: 1; background: var(--ihf-bg3); color: var(--ihf-text); }
.ihf-icon-btn.ihf-on { opacity: 1; color: var(--ihf-accent); background: var(--ihf-bg3); }

.ihf-tabs {
  display: flex; gap: 4px; padding: 9px 12px 0;
  border-bottom: 1px solid var(--ihf-border); flex-shrink: 0;
}
.ihf-tab {
  padding: 6px 12px; border-radius: 8px 8px 0 0;
  background: none; border: none; border-bottom: 2px solid transparent;
  color: var(--ihf-text2); font-size: .82em; font-weight: 500;
  cursor: pointer; transition: all .15s; margin-bottom: -1px;
  white-space: nowrap;
}
.ihf-tab:hover { color: var(--ihf-text); background: var(--ihf-bg2); }
.ihf-tab.ihf-on { color: var(--ihf-accent); border-bottom-color: var(--ihf-accent); background: var(--ihf-bg3); }

.ihf-body { flex: 1 1 auto; overflow-y: auto; padding: 13px 15px; min-height: 0; }
.ihf-body::-webkit-scrollbar { width: 4px; }
.ihf-body::-webkit-scrollbar-thumb { background: var(--ihf-bg3); border-radius: 2px; }
.ihf-page { display: none; }
.ihf-page.ihf-on { display: block; }

/* ── 页内零件 ── */
.ihf-body .ihf-muted { color: var(--ihf-text2); font-size: .84em; line-height: 1.65; }
.ihf-body .ihf-error { color: #d08a2a; font-size: .88em; line-height: 1.7; }
#ihf-panel.ihf-day .ihf-error { color: #a8621a; }
/* 物品行后面那两个 [不记] [只在出事时记] */
.ihf-body .ihf-block { cursor: pointer; opacity: .6; font-size: .88em; white-space: nowrap; }
.ihf-body .ihf-block:hover { opacity: 1; text-decoration: underline; color: var(--ihf-accent); }
.ihf-body input[type="number"].ihf-start { width: 4.2em; margin: 0 2px; }
.ihf-card {
  border: 1px solid var(--ihf-border); border-radius: 10px;
  background: var(--ihf-bg2); padding: 10px 12px; margin-bottom: 10px;
}
.ihf-card > h4 { margin: 0 0 6px; font-size: .86em; font-weight: 600; color: var(--ihf-text); }
.ihf-rows { font-size: .86em; line-height: 1.75; }
.ihf-acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.ihf-btn {
  white-space: nowrap; flex: 0 0 auto;
  padding: 5px 11px; border-radius: 7px; font-size: .82em;
  border: 1px solid var(--ihf-border); background: var(--ihf-bg2);
  color: var(--ihf-text); cursor: pointer; transition: background .15s;
}
.ihf-btn:hover { background: var(--ihf-bg3); }
.ihf-btn.ihf-primary { background: var(--ihf-accent); border-color: var(--ihf-accent); color: #fff; }
#ihf-panel.ihf-day .ihf-btn.ihf-primary { color: #fff; }
.ihf-form label {
  display: flex; align-items: center; gap: 7px;
  margin: 6px 0; font-size: .85em; flex-wrap: wrap;
}
.ihf-form label > span.ihf-lab { min-width: 5.5em; }
.ihf-form select, .ihf-form input[type="number"], .ihf-form input[type="text"], .ihf-form input[type="password"], .ihf-form textarea {
  background: var(--ihf-input-bg); color: var(--ihf-text);
  border: 1px solid var(--ihf-border); border-radius: 7px;
  padding: 4px 7px; font-size: 1em; font-family: inherit;
}
.ihf-form select { flex: 1 1 9em; min-width: 8em; }
.ihf-form input[type="number"] { width: 4.5em; }
.ihf-form textarea { width: 100%; resize: vertical; }
/* 输入框的字:酒馆自己的样式会把字压暗,这里钉死(9/18 物品禁词表看不清) */
#ihf-panel textarea, #ihf-panel input[type="text"], #ihf-panel input[type="number"], #ihf-panel input[type="password"], #ihf-panel select {
  color: var(--ihf-text) !important; opacity: 1 !important; line-height: 1.6;
}
#ihf-panel textarea::placeholder, #ihf-panel input::placeholder { color: var(--ihf-text2); opacity: .8; }
/* 命运页:一人一张卡片,标签和内容分两列(9/18 道长:这些字看得好费劲) */
.ihf-thread { background: var(--ihf-bg2); border: 1px solid var(--ihf-border); border-radius: 10px; padding: 10px 12px; margin: 10px 0; font-size: .92em; line-height: 1.7; }
.ihf-thread-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 1.08em; }
.ihf-thread-head .ihf-btn { margin-left: auto; }
/* char / NPC 角标,点一下切换(道长 9/18) */
.ihf-role { cursor: pointer; border: 1px solid var(--ihf-border); }
.ihf-role:hover { color: var(--ihf-text); }
.ihf-role-char { background: var(--ihf-accent); color: #fff; border-color: var(--ihf-accent); }
.ihf-chip { display: inline-block; font-size: .78em; padding: 0 7px; border-radius: 9px; background: var(--ihf-bg3); color: var(--ihf-text2); margin-right: 6px; white-space: nowrap; vertical-align: 1px; }
.ihf-idea { border-top: 1px dashed var(--ihf-border); padding-top: 7px; margin-top: 7px; }
.ihf-idea-title { font-weight: bold; margin-bottom: 4px; }
.ihf-kv { display: grid; grid-template-columns: 6.2em 1fr; gap: 8px; margin: 3px 0; }
.ihf-k { color: var(--ihf-text2); white-space: nowrap; }
.ihf-v { min-width: 0; }
.ihf-list { margin: 0; padding-left: 1.1em; }
.ihf-list li { margin: 2px 0; }
.ihf-list li.ihf-now { color: var(--ihf-accent); }
.ihf-note { background: var(--ihf-bg3); border-radius: 8px; padding: 6px 10px; margin: 6px 0; }
/* 全景表 */
.ihf-scroll { max-height: 40vh; overflow: auto; border: 1px solid var(--ihf-border); border-radius: 8px; }
.ihf-table { width: 100%; border-collapse: collapse; font-size: .86em; line-height: 1.5; }
.ihf-table th, .ihf-table td { padding: 4px 6px; border-bottom: 1px solid var(--ihf-border); vertical-align: top; text-align: left; }
.ihf-table th { position: sticky; top: 0; background: var(--ihf-bg2); color: var(--ihf-text2); font-weight: normal; }
.ihf-table td:nth-child(4) { min-width: 14em; }
/* 手动重跑那一格,默认收起 */
.ihf-manual { margin: 8px 0; border: 1px dashed var(--ihf-border); border-radius: 8px; padding: 4px 8px; }
.ihf-manual > summary { cursor: pointer; color: var(--ihf-text2); font-size: .85em; }
.ihf-manual[open] > summary { margin-bottom: 4px; }
/* 层号、时间、地点别被挤成一个字一行(道长 9/18 截图) */
.ihf-table th, .ihf-table td:nth-child(1) { white-space: nowrap; }
.ihf-table td.ihf-nowrap { white-space: nowrap; }
.ihf-table td:nth-child(3) { min-width: 5em; }
.ihf-table tr.ihf-dim { opacity: .45; }
/* 横条:好感、性格弧、事件影响力 */
.ihf-bar { position: relative; height: 8px; background: var(--ihf-bg3); border-radius: 4px; overflow: hidden; margin: 4px 0; }
.ihf-barfill { height: 100%; background: var(--ihf-accent); border-radius: 4px; transition: width .3s; }
.ihf-barfill.ihf-barwait { background: repeating-linear-gradient(45deg, var(--ihf-accent) 0 6px, transparent 6px 12px); }
.ihf-barmid { position: absolute; left: 50%; top: 0; width: 1px; height: 100%; background: var(--ihf-text2); opacity: .5; }
.ihf-affbar { height: 12px; }
.ihf-arcbar { margin-left: 1.2em; }
.ihf-barrow { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; align-items: center; margin: 4px 0; }
.ihf-barrow .ihf-barlab { grid-column: 1 / -1; font-size: .9em; }
.ihf-barrow .ihf-barval { font-size: .85em; color: var(--ihf-text2); min-width: 4em; text-align: right; }
.ihf-hist { display: flex; align-items: flex-end; gap: 4px; height: 60px; padding: 4px 0; }
.ihf-histcol { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
.ihf-histbar { width: 100%; background: var(--ihf-accent); border-radius: 3px 3px 0 0; min-height: 2px; }
.ihf-histlab { font-size: .7em; color: var(--ihf-text2); margin-top: 2px; }
/* 人物卡左右切换 */
.ihf-carousel { display: flex; align-items: stretch; gap: 6px; }
.ihf-carousel .ihf-icon-btn { align-self: center; flex: 0 0 auto; }
.ihf-person { flex: 1; background: var(--ihf-bg2); border: 1px solid var(--ihf-border); border-radius: 10px; padding: 8px 10px; min-width: 0; }
.ihf-person-head { font-size: 1.05em; margin-bottom: 4px; }
.ihf-aff { display: flex; align-items: baseline; gap: 8px; }
.ihf-affnum { font-size: 1.8em; font-weight: bold; color: var(--ihf-accent); }
.ihf-afftier { font-size: 1em; }
.ihf-dots { display: flex; justify-content: center; gap: 6px; margin: 4px 0 8px; }
.ihf-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ihf-bg3); border: 1px solid var(--ihf-border); cursor: pointer; }
.ihf-dot.ihf-on { background: var(--ihf-accent); }
.ihf-sep { border: none; border-top: 1px solid var(--ihf-border); margin: 12px 0; }
`;

function injectStyle() {
    if (document.getElementById('ihf-style')) return;
    const el = document.createElement('style');
    el.id = 'ihf-style';
    el.textContent = CSS;
    document.head.appendChild(el);
}

/**
 * 建好壳。返回几个钩子给 index.js 用。
 * @param {object} o
 * @param {string} o.version 显示在标题旁边的版本号(自己编的号,不是 commit 哈希)
 * @param {string} o.emoji 球上那个字
 * @param {{left:number,top:number}|null} o.pos 上次拖到哪
 * @param {'day'|'night'} o.theme
 * @param {(pos:{left:number,top:number})=>void} o.onMove 拖完了存位置
 * @param {(theme:string)=>void} o.onTheme 切了日夜
 * @param {(key:string)=>void} o.onShow 换页了,让 index.js 现渲染那一页
 */
export function mountShell({ version, emoji = '♾️', pos = null, theme = 'night', onMove, onTheme, onShow }) {
    injectStyle();
    document.getElementById('ihf-ball')?.remove();
    document.getElementById('ihf-overlay')?.remove();

    const ball = document.createElement('div');
    ball.id = 'ihf-ball';
    ball.title = '模拟人生,点开看;可以拖';
    ball.innerHTML = '<span class="ihf-ball-icon"></span><span class="ihf-ball-dot"></span>';
    ball.querySelector('.ihf-ball-icon').textContent = emoji;
    document.body.appendChild(ball);

    const overlay = document.createElement('div');
    overlay.id = 'ihf-overlay';
    const tabsHtml = TABS.map(t => `<button class="ihf-tab" data-tab="${t.key}" title="${t.hint}">${t.icon} ${t.name}</button>`).join('');
    const pagesHtml = [...TABS, ...PAGES].map(t => `<div class="ihf-page" data-page="${t.key}"></div>`).join('');
    overlay.innerHTML = `
<div id="ihf-panel">
  <div class="ihf-head">
    <span class="ihf-head-title">模拟人生<span class="ihf-head-ver">v${version}</span></span>
    <span class="ihf-head-spacer"></span>
    <button class="ihf-icon-btn" data-page-btn="shezhi" title="设置">⚙️</button>
    <button class="ihf-icon-btn" data-page-btn="bangzhu" title="帮助">❓</button>
    <button class="ihf-icon-btn" id="ihf-theme" title="切换日夜">🌗</button>
    <button class="ihf-icon-btn" id="ihf-close" title="关闭">✕</button>
  </div>
  <div class="ihf-tabs">${tabsHtml}</div>
  <div class="ihf-body">${pagesHtml}</div>
</div>`;
    document.body.appendChild(overlay);

    const panel = overlay.querySelector('#ihf-panel');
    const applyTheme = t => panel.classList.toggle('ihf-day', t === 'day');
    applyTheme(theme);

    let current = TABS[0].key;
    const show = key => {
        current = key;
        overlay.querySelectorAll('.ihf-page').forEach(p => p.classList.toggle('ihf-on', p.dataset.page === key));
        overlay.querySelectorAll('.ihf-tab').forEach(b => b.classList.toggle('ihf-on', b.dataset.tab === key));
        overlay.querySelectorAll('[data-page-btn]').forEach(b => b.classList.toggle('ihf-on', b.dataset.pageBtn === key));
        overlay.querySelector('.ihf-body').scrollTop = 0;
        onShow?.(key);
    };

    overlay.querySelectorAll('.ihf-tab').forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));
    overlay.querySelectorAll('[data-page-btn]').forEach(b => b.addEventListener('click', () => show(b.dataset.pageBtn)));
    overlay.querySelector('#ihf-close').addEventListener('click', () => close());
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    overlay.querySelector('#ihf-theme').addEventListener('click', () => {
        const next = panel.classList.contains('ihf-day') ? 'night' : 'day';
        applyTheme(next);
        onTheme?.(next);
    });
    const onEsc = e => { if (e.key === 'Escape' && overlay.classList.contains('ihf-visible')) close(); };
    document.addEventListener('keydown', onEsc);

    function open() {
        overlay.classList.add('ihf-visible');
        show(current);
    }
    function close() {
        overlay.classList.remove('ihf-visible');
    }

    // ── 球的位置与拖动 ──
    const clamp = () => {
        const w = ball.offsetWidth || 38;
        const h = ball.offsetHeight || 38;
        const l = Math.min(Math.max(ball.offsetLeft, 0), window.innerWidth - w);
        const t = Math.min(Math.max(ball.offsetTop, 0), window.innerHeight - h);
        ball.style.left = `${l}px`;
        ball.style.top = `${t}px`;
        ball.style.right = 'auto';
        // 贴着哪边就往哪边缩一半
        ball.classList.toggle('ihf-tuck-left', l <= 2);
        ball.classList.toggle('ihf-tuck-right', l >= window.innerWidth - w - 2);
    };
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
        ball.style.left = `${pos.left}px`;
        ball.style.top = `${pos.top}px`;
        ball.style.right = 'auto';
    }
    requestAnimationFrame(clamp);
    window.addEventListener('resize', clamp);

    // 拖和点要分开:动过 4 像素才算拖,不然一点就被判成拖动(织梦者那只蝴蝶踩过)
    let dragging = false;
    let moved = false;
    let dx = 0;
    let dy = 0;
    ball.addEventListener('pointerdown', e => {
        dragging = true; moved = false;
        const r = ball.getBoundingClientRect();
        dx = e.clientX - r.left;
        dy = e.clientY - r.top;
        // 触屏/合成事件上偶尔会抛 NotFoundError,抓住就行,不影响拖
        try { ball.setPointerCapture(e.pointerId); } catch { /* 没这个指针就算了 */ }
        e.preventDefault();
    });
    ball.addEventListener('pointermove', e => {
        if (!dragging) return;
        const l = e.clientX - dx;
        const t = e.clientY - dy;
        if (Math.abs(l - ball.offsetLeft) > 4 || Math.abs(t - ball.offsetTop) > 4) moved = true;
        ball.style.left = `${l}px`;
        ball.style.top = `${t}px`;
        ball.style.right = 'auto';
    });
    const endDrag = e => {
        if (!dragging) return;
        dragging = false;
        try { ball.releasePointerCapture(e.pointerId); } catch { /* 指针没了就算了 */ }
        clamp();
        if (moved) onMove?.({ left: ball.offsetLeft, top: ball.offsetTop });
        else open();
    };
    ball.addEventListener('pointerup', endDrag);
    ball.addEventListener('pointercancel', endDrag);

    return {
        open,
        close,
        show,
        get current() { return current; },
        isOpen: () => overlay.classList.contains('ihf-visible'),
        /** 往某一页里塞 html */
        page: key => overlay.querySelector(`.ihf-page[data-page="${key}"]`),
        /** 球上转圈(后台在跑活) + 右上角小黄点(有事要她看) */
        setBusy: on => ball.classList.toggle('ihf-busy', !!on),
        setWarn: on => ball.classList.toggle('ihf-warn', !!on),
        setBallVisible: on => { ball.hidden = !on; },
        destroy: () => {
            document.removeEventListener('keydown', onEsc);
            ball.remove();
            overlay.remove();
        },
    };
}
