import { readFile, writeFile } from 'node:fs/promises';
const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
await writeFile(new URL('./generated-entry.js', import.meta.url), source.replaceAll("from './", "from '../")
    + '\nexport { state, render, renderPeople, renderTable, mountPanel, refresh, knownPeople, setRole, saveMemory, startAffinityInit, stopJob, runJob, callModel };\n');
await writeFile(new URL('./browser-fixture.html', import.meta.url), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>模拟人生 · 隔离验收</title><style>body{margin:0;background:#292633;color:#eee;font-family:system-ui}#fixture-controls{position:fixed;top:8px;left:8px;z-index:100000;background:#292633;padding:8px}button{cursor:pointer}#fixture-controls button{margin:3px}#fixture-result{font-size:12px}</style>
<div id="fixture-controls"><button id="fixture-phone">390 窄屏</button><button id="fixture-tablet">820 平板</button><button id="fixture-task">模拟运行任务</button><button id="fixture-open">打开人物</button><button id="fixture-swipe">模拟左滑</button><button id="fixture-hide">隐藏验收工具</button><span id="fixture-result">仅合成数据，所有文件请求已替换为内存存储</span></div>
<script type="module">
const files = new Map(); const notices = [];
globalThis.fetch = async (url, options) => {
 if (String(url).startsWith('/api/files/upload')) {const data=JSON.parse(options.body);files.set(data.name,JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(data.data),c=>c.charCodeAt(0)))));return {ok:true};}
 if (String(url).startsWith('/user/files/')) return {ok:true,status:200,json:async()=>files.get(String(url).split('/').at(-1).split('?')[0])||null};
 throw Error('Unexpected network request blocked: '+url);
};
const jq = new Proxy(function(selector){return new Proxy({}, {get:(_t,k)=> {
 if(k==='length')return document.querySelectorAll(typeof selector==='string'?selector:'no-match').length;
 if(k==='toggle')return on=>document.querySelectorAll(selector).forEach(el=>el.style.display=on?'':'none');
 if(k==='on')return (type,fn)=>{if(typeof selector==='string')document.querySelectorAll(selector).forEach(el=>el.addEventListener(type,fn));return jq();};
 return ()=>jq();
}});},{get:()=>()=>{}});
globalThis.$=jq;globalThis.jQuery=()=>{};
globalThis.toastr=Object.fromEntries(['info','success','warning','error'].map(k=>[k,(s)=>{notices.push(s);document.getElementById('fixture-result').textContent=s;}]));
const chat=[{mes:'Char1 好感度：43\\n<ihf-ledger>摘要: Char1和NPC在档案室整理旧物。\\n在场: Char1, NPC\\n性格: NPC +5 往更愿意信任别人 整理旧物时互相帮助</ihf-ledger>',is_user:false,send_date:'2026-01-01'},
{mes:'继续整理。',is_user:true},{mes:'<ihf-ledger>摘要: NPC将一封旧信交给User。\\n在场: NPC\\n好感: NPC +3 帮忙整理</ihf-ledger>',is_user:false}];
const context={chat,name1:'User',name2:'Char1',characterId:0,characters:[{name:'Char1',description:'Char1谨慎，NPC愿意助人。'}],groups:[],extensionSettings:{},chatMetadata:{},
getCurrentChatId:()=> 'fixture', getRequestHeaders:()=>({}),substituteParams:s=>s,setExtensionPrompt(){},
ConnectionManagerRequestService:{getSupportedProfiles:()=>[{id:'fixture',name:'fixture',model:'fixture'}],sendRequest:async()=> 'Char1 10 估计\\nNPC 12 估计'},generateRaw:async()=> 'Char1 10 估计\\nNPC 12 估计'};
globalThis.SillyTavern={getContext:()=>context};
const api=await import('./generated-entry.js');const {emptyMemory}=await import('../core/memory.js');const {DEFAULT_CONFIG}=await import('../store.js');
Object.assign(api.state,{config:structuredClone(DEFAULT_CONFIG),memory:emptyMemory('fixture'),chatId:'fixture',memId:'fixture',lastTier:'big'});
api.state.config.fate.world=false;api.state.config.jobs.subProfile='st:fixture';api.state.config.jobs.rpm=Infinity;
api.state.memory.affinityStart={NPC:{value:12}};api.state.memory.origins.NPC='愿意助人';
api.refresh();api.mountPanel();api.refresh();
document.getElementById('ihf-ball').querySelector('[data-tab="renlei"]').click();
document.getElementById('ihf-open')?.click();
// Controls use actual shell controls and real person/table handlers; all persistence remains mocked.
const panel=document.getElementById('ihf-overlay');panel.classList.add('ihf-visible');
document.getElementById('fixture-open').onclick=()=>{panel.classList.add('ihf-visible');document.querySelector('.ihf-tab[data-tab="renlei"]').click();};
document.getElementById('fixture-task').onclick=()=>{
 context.ConnectionManagerRequestService.sendRequest=(_id,_messages,_max,options)=>new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>resolve('fixture'),30000);options.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Stopped','AbortError'));},{once:true});
 });
 api.runJob('生成摘要',[1,2],async()=>api.callModel([],'st:fixture'));
};
document.getElementById('fixture-swipe').onclick=()=>{
 const target=document.querySelector('.ihf-deck');if(!target)return;
 const touch=x=>new Touch({identifier:1,target,clientX:x,clientY:300});
 target.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:[touch(300)]}));
 target.dispatchEvent(new TouchEvent('touchend',{bubbles:true,changedTouches:[touch(100)]}));
};
document.getElementById('fixture-hide').onclick=()=>{document.getElementById('fixture-controls').hidden=true;};
for(const [id,width] of [['fixture-phone',390],['fixture-tablet',820]])document.getElementById(id).onclick=()=>{
 const p=document.getElementById('ihf-panel');p.style.width=(width===390?'350':'560')+'px';document.getElementById('fixture-result').textContent='面板宽度 '+p.style.width;
};
globalThis.fixture={...api,context,files,notices};
</script></html>`);
console.log('Generated isolated browser fixture with real entry, shell, handlers and memory-only file storage.');
