/* ===== Reunion · 前端主逻辑（数据层：Store/Dav，无服务器依赖） ===== */
'use strict';

const PALETTE = ['#FF6B6B','#4ECDC4','#5B8FF9','#F6BD16','#9270CA','#73D13D','#FF9C6E','#36CFC9'];
const APP_VERSION = '0.6.0';
const VIEW_KEY = 'tm:view';
const WEEK_FIT_KEY = 'tm:weekFit'; // 周视图一屏四格（默认）还是收成一屏七格
const DAYVIEW_KEY = 'tm:dayView'; // 日视图开关，默认关（设置-外观里可打开）
const DEFVIEW_KEY = 'tm:defView'; // 进入空间时默认用哪个视图：last=跟随上次

/* 鸿蒙壳把状态栏/导航条避让区（物理像素）推进来，换算成 CSS px 写入 --sa-* */
window.__setSafeInsets = function (topPx, bottomPx) {
  const dpr = window.devicePixelRatio || 1;
  const s = document.documentElement.style;
  s.setProperty('--sa-top', (topPx / dpr) + 'px');
  s.setProperty('--sa-bottom', (bottomPx / dpr) + 'px');
};

function getClientId() {
  let id = localStorage.getItem('tm:clientId');
  if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : 'c' + Math.random().toString(36).slice(2) + Date.now()); localStorage.setItem('tm:clientId', id); }
  return id;
}

/* 本机资料一旦生成就固定写回：否则每次启动换一个「用户xxx」，看着像又建了个新账号 */
function getProfileKey(k, gen) {
  let v = localStorage.getItem(k);
  if (!v) { v = gen(); localStorage.setItem(k, v); }
  return v;
}

window.App = {
  clientId: getClientId(),
  me: {
    name: getProfileKey('tm:myName', () => '用户' + Math.floor(100 + Math.random() * 900)),
    color: getProfileKey('tm:myColor', () => PALETTE[Math.floor(Math.random() * PALETTE.length)]),
  },
};

/* 当前身份键：已登录=账户（跨设备一致），未登录=本机设备 */
function myId(){ return (window.Auth && Auth.memberKey()) || App.clientId; }

/* 日程归属的成员记录：身份键换过（登录/退出/换设备）时旧键已退休，
   顺着退休记录找到现在那条，避免日程显示成「未知」而其实就在某人标签下 */
function memberOf(data,id){
  const k=Store.resolve(data,id);
  return Object.assign({ name:'未知', color:'#999' }, (data&&data.members&&data.members[k]) || {}, { key:k });
}

function showDeviceId(){ const el=$('#deviceIdShow'); if(el) el.textContent=App.clientId.slice(0,8); }

/* 设备号以原生存储为准：网页 localStorage 被系统清掉时，不至于每次冷启动都变成一个新账号 */
async function adoptNativeDeviceId(tries){
  if (!window.Transport || !Transport.deviceId) return;
  let nid = null;
  try { nid = await Transport.deviceId(); } catch (e) { /* 旧壳无此方法 */ }
  if (!nid) {
    if (tries > 0) { await new Promise((r) => setTimeout(r, 250)); return adoptNativeDeviceId(tries - 1); }
    return;
  }
  const old = App.clientId;
  if (nid === old) { showDeviceId(); return; }
  App.clientId = nid;
  try { localStorage.setItem('tm:clientId', nid); } catch (e) { /* noop */ }
  if (!(window.Auth && Auth.loggedIn())) Store.migrateIdentity(old, nid); // 未登录：本机旧身份整体并到新号
  showDeviceId();
  if (!state.code) initStart();
}
const state = {
  code: null,
  day: todayStr(),
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  view: localStorage.getItem(VIEW_KEY) || 'month',
  dayView: localStorage.getItem(DAYVIEW_KEY) === '1',
  defView: localStorage.getItem(DEFVIEW_KEY) || 'last',
  weekFit: localStorage.getItem(WEEK_FIT_KEY) === '7' ? 7 : 4,
  visible: {},
  spaceMode: 'create',
  monthCollapsed: false,
  pollTimer: null,
};

const $ = (s) => document.querySelector(s);

/* 成员默认可见：只有被手动点掉（visible[id]===false）的人才隐藏。
   早先是"未定义即隐藏"，后来才同步进来的成员会因为 undefined 被整片藏掉——用户反馈"看不到房间里别人的日程" */
const memberOn = (id) => state.visible[id] !== false;

/* ---------- 主题（跟随系统/浅色/深色） ---------- */
const THEME_KEY = 'tm:theme';
const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme(){
  const t = localStorage.getItem(THEME_KEY) || 'auto';
  const dark = t === 'dark' || (t === 'auto' && darkMQ.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelectorAll('#themeSeg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.val === t));
  /* 鸿蒙壳：沉浸式下状态栏图标叠在页面之上，颜色要跟随主题 */
  if (window.Transport && Transport.hasHarmony && Transport.harmonyCall) {
    Transport.harmonyCall('uiStatusBar', [dark ? '1' : '0']).catch(() => {});
  }
}
$('#themeSeg').onclick = (e) => {
  const b = e.target.closest('.seg-btn');
  if (!b) return;
  localStorage.setItem(THEME_KEY, b.dataset.val);
  applyTheme();
};
if (darkMQ.addEventListener) darkMQ.addEventListener('change', () => { if ((localStorage.getItem(THEME_KEY) || 'auto') === 'auto') applyTheme(); });

/* 日视图默认收起：不常用的人不必在视图条上看见那一格 */
function syncDayView(){
  const on = state.dayView;
  ['#viewSeg [data-val="day"]', '#defViewSeg [data-val="day"]'].forEach((sel) => {
    const btn = $(sel);
    if (btn) btn.classList.toggle('hidden', !on);
  });
  const sw = $('#dayViewSw');
  if (sw) sw.checked = on;
  /* 「默认视图」和「日视图开关」要自洽：选了日又关掉日视图，就退回跟随上次 */
  if (!on && state.defView === 'day') { state.defView = 'last'; localStorage.setItem(DEFVIEW_KEY, 'last'); }
  if (!on && state.view === 'day') { state.view = 'week'; localStorage.setItem(VIEW_KEY, 'week'); }
  document.querySelectorAll('#defViewSeg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.val === state.defView));
}
$('#dayViewSw').onchange = (e) => {
  state.dayView = e.target.checked;
  localStorage.setItem(DAYVIEW_KEY, e.target.checked ? '1' : '0');
  syncDayView();
  renderCalendar(true);
};
$('#defViewSeg').onclick = (e) => {
  const b = e.target.closest('.seg-btn');
  if (!b) return;
  state.defView = b.dataset.val;
  localStorage.setItem(DEFVIEW_KEY, b.dataset.val);
  syncDayView();
  if (b.dataset.val !== 'last') setView(b.dataset.val); // 立刻给个反馈，不用等下次进入空间
};
/* 鸿蒙 ArkWeb 里系统深色模式在应用切回前台时才保证同步过来，媒体查询事件不一定触发 */
document.addEventListener('visibilitychange', () => { if (!document.hidden) applyTheme(); });

function pad(n){ return String(n).padStart(2,'0'); }
function dateStr(y,m,d){ return `${y}-${pad(m)}-${pad(d)}`; }
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),1800); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function shade(hex,p){ const n=parseInt(hex.slice(1),16); let r=(n>>16)&255,g=(n>>8)&255,b=n&255; r=Math.max(0,Math.min(255,r+p)); g=Math.max(0,Math.min(255,g+p)); b=Math.max(0,Math.min(255,b+p)); return '#'+((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1); }
function genCode() { const b = new Uint8Array(4); crypto.getRandomValues(b); return Array.from(b, x=>x.toString(16).padStart(2,'0')).join('').toUpperCase(); }
/* 网盘账号是按空间绑定的：进某个空间只看它自己那份绑定，不被本机默认账号挡住 */
function needDav(code){
  const c = code ? Dav.spaceCfg(code) : Dav.cfg();
  if(!Dav.usable(c)){
    toast(code ? '这个空间的网盘账号还没配好（设置 → 配置码 / 网盘同步）' : '请先在设置中配置网盘');
    openSettings();
    return false;
  }
  return true;
}

/* noCancel=true：只有一顆「知道了」的告知型弹层（被移出空间这种没有回头路可问的事） */
function uiConfirm(title, text, yesText, noCancel){
  return new Promise((res)=>{
    $('#confirmTitle').textContent=title; $('#confirmText').textContent=text; $('#confirmYes').textContent=yesText||'确认';
    $('#confirmNo').classList.toggle('hidden', !!noCancel);
    $('#confirmModal').hidden=false;
    $('#confirmYes').onclick=()=>{ $('#confirmModal').hidden=true; res(true); };
    $('#confirmNo').onclick=()=>{ $('#confirmModal').hidden=true; res(false); };
  });
}

/* 需要用户拍板的选择（单选，可带自由输入）：换绑网盘、邮箱合并成一个用户时保留哪个昵称。
   返回选中的 option.v，或 {text:输入内容}，取消返回 'cancel' */
function ask({title,text,options,input}){
  return new Promise((res)=>{
    const box=$('#askOpts'); box.innerHTML='';
    $('#askTitle').textContent=title; $('#askText').textContent=text||'';
    const done=(v)=>{ $('#askModal').hidden=true; res(v); };
    options.forEach((o)=>{
      const b=el('button','big-btn ghost ask-opt'); b.type='button';
      b.innerHTML=`<span class="ask-t">${escapeHtml(o.t)}</span>`+(o.sub?`<span class="ask-sub">${escapeHtml(o.sub)}</span>`:'');
      b.onclick=()=>done(o.v); box.appendChild(b);
    });
    const wrap=$('#askInputWrap'), inp=$('#askInput');
    wrap.classList.toggle('hidden', !input);
    $('#askOk').classList.toggle('hidden', !input);
    if(input){ inp.value=input.value||''; inp.placeholder=input.placeholder||''; }
    $('#askOk').onclick=()=>{ const v=inp.value.trim(); if(!v) return toast('请先填写'); res({text:v}); $('#askModal').hidden=true; };
    $('#askCancel').onclick=()=>done('cancel');
    $('#askModal').hidden=false;
  });
}

const SCREENS=['startScreen','calendarScreen','settingsScreen'];
/* 屏幕切换原本只是 hidden 一来一回，硬跳；补一段方向感知的进场。
   只做平移+淡入，别用缩放：周视图进场时要按 getBoundingClientRect 量列宽，缩放会把量测带偏 */
function showScreen(name){
  const cur=document.querySelector('.screen:not(.hidden)');
  SCREENS.forEach(s=>$('#'+s).classList.add('hidden'));
  const next=$('#'+name);
  next.classList.remove('hidden');
  if(next!==cur){
    const anim = !cur || cur.id==='startScreen' || name==='startScreen' ? 'fade'
      : (SCREENS.indexOf(name)>SCREENS.indexOf(cur.id) ? 'from-right' : 'from-left');
    next.classList.remove('anim-fade','anim-from-right','anim-from-left');
    void next.offsetWidth; // 重开同一块屏时动画要能重放
    next.classList.add('anim-'+anim);
  }
  $('#tabbar').classList.toggle('hidden', name==='startScreen');
  $('#tabRoom').classList.toggle('active', name==='calendarScreen');
  $('#tabSettings').classList.toggle('active', name==='settingsScreen');
  /* 桌面端左侧栏：开屏页不收栏，日历/设置按钮跟随高亮；空间列表随时重画（成本只是本地数据） */
  document.body.classList.toggle('on-start', name==='startScreen');
  $('#railCalendar').classList.toggle('active', name==='calendarScreen');
  $('#railSettings').classList.toggle('active', name==='settingsScreen');
  renderRail();
}
$('#tabRoom').onclick=()=>{ if(state.code && Store.get(state.code)) showScreen('calendarScreen'); else initStart(); };
$('#tabSettings').onclick=openSettings;

/* ---------- 返回手势（鸿蒙侧滑 / Android 实体键）：逐层回退，只在首页退出 ---------- */
function closeTopModal(){
  const masks=[...document.querySelectorAll('.modal-mask')].filter((m)=>!m.hidden);
  if(!masks.length) return false;
  const m=masks[masks.length-1]; // 后面的 mask 盖在上面
  /* 优先点「取消/关闭」，让各自的清理逻辑走到（例如 eventCancel 要清 editingEvent）。
     切换空间面板的「返回」是回上一个空间，不是关面板，所以不能点它 */
  const btn=m.querySelector('#confirmNo,button[id$="Cancel"],button[id$="Close"]');
  if(btn) btn.click(); else m.hidden=true;
  return true;
}
/* 壳层调用：'stay' 已在应用内消化，'exit' 才交给系统退出应用 */
window.__tmBack=function(){
  if(closeTopModal()) return 'stay';
  if(!$('#settingsScreen').classList.contains('hidden')){
    showScreen(state.code && Store.get(state.code) ? 'calendarScreen' : 'startScreen');
    return 'stay';
  }
  return 'exit';
};

/* ---------- 桌面端键盘操作（仅 Tauri 壳注册；手机/浏览器键盘事件行为不同，宁可不给） ---------- */
if (window.Transport && Transport.isDesktop) {
  const anyModalOpen = () => [...document.querySelectorAll('.modal-mask')].some((m) => !m.hidden);
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (e.key === 'Escape') { if (!typing && closeTopModal()) e.preventDefault(); return; }
    if (typing) return;
    const onCal = !$('#calendarScreen').classList.contains('hidden');
    if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); if (onCal) $('#syncBtn').click(); return; }
    /* 桌面习惯：拿着配置码进来先按 Ctrl+V —— 直接弹「导入配置码」，再按一次就是往文本框粘贴 */
    if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V') && !onCal && !anyModalOpen()) { $('#cfgImportBtn').click(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!onCal || anyModalOpen() || !state.code) return;
    switch (e.key) {
      case 'ArrowLeft': navStep(-1); break;
      case 'ArrowRight': navStep(1); break;
      case 't': case 'T': state.day = todayStr(); syncYm(); renderCalendar(true); break;
      case 'n': case 'N': openEventModal(state.day); break;
      case 'm': case 'M': setView('month'); break;
      case 'w': case 'W': setView('week'); break;
      case 'd': case 'D': if (state.dayView) setView('day'); break;
    }
  });
}

/* 键盘弹出时收起底栏（fixed 定位会被顶到键盘上方）。
   鸿蒙收起输入法不一定触发 focusout，所以盯「可视视口有没有被压矮」，输入法一退底栏就回来 */
let kbBase={w:-1,h:0};
function kbUp(){
  const vv=window.visualViewport;
  const w=Math.round(vv?vv.width:window.innerWidth);
  const h=Math.round(Math.min(vv?vv.height:window.innerHeight, window.innerHeight));
  if(w!==kbBase.w){ kbBase={w,h}; return false; } // 转屏等宽度变化时重取基线，别把横屏当成键盘
  if(h>kbBase.h) kbBase.h=h;
  return kbBase.h-h>120;
}
function syncTabbarKb(){ $('#tabbar').classList.toggle('kb-hide', kbUp()); }
window.addEventListener('resize',syncTabbarKb);
let wasNarrow=window.innerWidth<600;
window.addEventListener('resize',()=>{ // 转屏后折叠开关该不该出现会变，重画一次
  const narrow=window.innerWidth<600;
  if(narrow!==wasNarrow){ wasNarrow=narrow; if(state.code) renderCalendar(); }
});
if(window.visualViewport){
  window.visualViewport.addEventListener('resize',syncTabbarKb);
  window.visualViewport.addEventListener('scroll',syncTabbarKb);
}
document.addEventListener('focusin',syncTabbarKb);
document.addEventListener('focusout',syncTabbarKb);

/* ---------- 资料（起始屏与设置页共用一份状态，双向刷新） ---------- */
function buildColorPicker(box){
  box.innerHTML='';
  PALETTE.forEach(c=>{
    const sw=document.createElement('div'); sw.className='color-swatch'+(c===App.me.color?' sel':'');
    sw.style.background=c;
    sw.onclick=()=>{ App.me.color=c; localStorage.setItem('tm:myColor',c); refreshProfile(); if(state.code && Store.get(state.code)) Store.setProfile(state.code); };
    box.appendChild(sw);
  });
}
function refreshProfile(){
  ['#myName','#setName'].forEach(s=>{ const el=$(s); if(el && el!==document.activeElement) el.value=App.me.name; });
  buildColorPicker($('#myColorPicker')); buildColorPicker($('#setColorPicker'));
}
function onNameInput(e){
  App.me.name = e.target.value.trim() || App.me.name;
  localStorage.setItem('tm:myName', App.me.name);
  const other = e.target.id==='myName' ? $('#setName') : $('#myName');
  if(other && other!==document.activeElement) other.value=App.me.name;
  if(state.code && Store.get(state.code)) Store.setProfile(state.code);
}

/* ---------- 起始屏 ---------- */
function initStart(){
  stopPolling();
  refreshProfile();
  renderAccountSection();
  const last = localStorage.getItem('tm:lastSpace');
  $('#lastSpaceBox').classList.toggle('hidden', !last);
  $('#startHint').textContent = (Dav.cfg() && Dav.cfg().user) ? '' : '第一步：进入设置，配置坚果云 WebDAV 或粘贴家人的配置码';
  showScreen('startScreen');
}

$('#createBtn').onclick=()=>{ if(needDav()) openSpaceModal('create'); };
$('#joinBtn').onclick=()=>{ if(needDav()) openSpaceModal('join'); };
$('#enterLastBtn').onclick=()=>{ const c=localStorage.getItem('tm:lastSpace'); if(c && needDav(c)) enterSpace(c); };
$('#davBtn').onclick=openSettings;

/* ---------- 设置页 ---------- */
function fillDavForm(){
  const c = Dav.cfg() || {};
  $('#davBase').value=c.baseUrl||'https://dav.jianguoyun.com/dav';
  $('#davUser').value=c.user||''; $('#davPass').value=c.pass||'';
}
function saveDavFromForm(){
  Dav.saveConfig({ baseUrl:$('#davBase').value.trim(), user:$('#davUser').value.trim(), pass:$('#davPass').value });
}
function openSettings(){
  fillDavForm(); refreshProfile(); renderSpaceMgmt(); renderAccountSection();
  showDeviceId();
  renderUpdate();
  syncSnapUI();
  syncNotifySw();
  syncHolidayUI();
  $('#appVersion').textContent='v'+APP_VERSION;
  showScreen('settingsScreen');
}
$('#settingsBack').onclick=()=>{ if(state.code && Store.get(state.code)) showScreen('calendarScreen'); else initStart(); };
['#davBase','#davUser','#davPass'].forEach(s=>$(s).onchange=saveDavFromForm);
$('#setName').oninput=onNameInput;
$('#davTest').onclick=async()=>{
  if(!$('#davUser').value.trim()||!$('#davPass').value) return toast('请填写账号和应用密码');
  saveDavFromForm();
  try{ await Dav.test(); toast('网盘连接成功 ✔'); }
  catch(e){ toast(e.message); }
};

/* ---------- 账户（登录即用，Supabase 配置已内置） ----------
   绑定邮箱有两个入口：起始屏的「绑定邮箱」组框、设置-账户。控件一模一样但 id 不能重复，
   所以做成一个工厂、各传自己那组元素；绑定后的收尾（并身份、扫网盘找回空间、问账户名称）
   两条路走同一份代码，免得改一处漏一处 */
const OTP_RESEND_SEC=90;
const OTP_SEND_LABEL='📧 发送验证码';
const bindFlows=[];
function mountBindFlow(ids){
  const el=(k)=>document.getElementById(ids[k]);
  let timer=null;
  const flow={ render(){
    const s=Auth.session();
    el('out').classList.toggle('hidden', !!s);
    el('in').classList.toggle('hidden', !s);
    if(s) el('shown').textContent=s.email||'已登录';
    else { el('codeWrap').classList.add('hidden'); el('verify').classList.add('hidden'); el('code').value=''; }
    /* 组框收起时也要一眼看得出绑没绑，别让人为了确认状态去点开它 */
    const head=el('head');
    if(head) head.textContent = s ? `✉️ 已绑定 ${s.email||''}` : '📧 绑定邮箱（可选）';
  }};
  el('send').onclick=async()=>{
    const btn=el('send');
    if(btn.disabled) return;
    const email=el('email').value.trim();
    btn.disabled=true;
    try{
      await Auth.sendOtp(email);
      el('codeWrap').classList.remove('hidden'); el('verify').classList.remove('hidden');
      el('code').focus();
      toast('验证码已发到邮箱，请查收');
      clearInterval(timer);
      let left=OTP_RESEND_SEC;
      btn.textContent=`📧 重新发送（${left}s）`;
      timer=setInterval(()=>{
        left--;
        if(left<=0){ clearInterval(timer); timer=null; btn.disabled=false; btn.textContent=OTP_SEND_LABEL; }
        else btn.textContent=`📧 重新发送（${left}s）`;
      },1000);
    }catch(e){ toast(e.message); btn.disabled=false; }
  };
  el('verify').onclick=async()=>{
    const btn=el('verify'); btn.disabled=true;
    try{
      await finishBind(myId(), el('email').value, el('code').value);
      flow.render();
      const box=el('box'); if(box) box.open=false; // 绑完收回一行，状态写在标题上
    }
    catch(e){ toast(e.message); }
    finally{ btn.disabled=false; }
  };
  /* 退出登录只改本机身份，不动云端成员记录：
     别的设备可能正用这个邮箱写日程，把 u:邮箱 改名回本机设备号等于把别人的成员条目抢过来，
     表现就是「同一个账号又显示成两个」。已写下的日程靠本机历史身份键照样认作自己的。 */
  el('logout').onclick=()=>{
    Auth.clear();
    flow.render();
    toast('已退出，回到本机身份（此前的日程仍归在这个邮箱名下）');
    if(state.code && Store.get(state.code)){ renderPeopleTags(); renderCalendar(); }
  };
  bindFlows.push(flow);
  return flow;
}
function renderAccountSection(){ bindFlows.forEach((f)=>f.render()); }
/* 绑定成功之后顺手把网盘扫一遍：这个邮箱在别的设备上加入过的空间要自动补回来，
   而不是等用户再去设置页手动点「扫描网盘」（补回来的结果必须说一句，不然看不出扫过了） */
async function finishBind(oldKey, email, code){
  await Auth.verifyOtp(email, code);
  const newKey=myId();
  const localName=App.me.name;
  const mig = newKey!==oldKey ? Store.migrateIdentity(oldKey,newKey) : { conflicts:[] }; // 邮箱绑定到当前本地身份，而不是另建账户
  let found={added:[],nick:'',scanned:0};
  try{ found = await Store.followAccount(newKey); }catch(e){ console.warn('follow account:',e.message); }
  /* 两边昵称不一样时不自动挑：合并成一个用户要问账户名称 */
  const theirs = found.nick || (mig.conflicts[0]||{}).theirs;
  if(theirs && theirs!==localName){
    const pick=await ask({
      title:'这个邮箱在别的设备上叫「'+theirs+'」',
      text:'本机身份要和它合并成一个用户（同一个人的日程归到一条）。选一个显示名称，成员标签和日程归属都会用它。',
      options:[{v:'mine',t:'用本机现在的：'+localName},{v:'theirs',t:'用账户已有的：'+theirs}],
      input:{placeholder:'或输入一个新的账户名称'},
    });
    const name = pick==='mine' ? localName : pick==='theirs' ? theirs : ((pick&&pick.text)||localName);
    if(name && name!==App.me.name) Store.setMyName(name);
  }
  renderAccountSection(); renderSpaceMgmt();
  toast(found.added.length ? '绑定成功，已自动补回该邮箱加入的 '+found.added.length+' 个空间'
    : '绑定成功'+(found.scanned ? '：网盘里翻了 '+found.scanned+' 份文件，这个邮箱还没加入过别的空间' : ''));
  if(state.code && Store.get(state.code)){ Store.setProfile(state.code); renderPeopleTags(); renderCalendar(); }
  Store.scheduleSync();
}
mountBindFlow({ out:'acctLoggedOut', in:'acctLoggedIn', email:'loginEmail', send:'otpSendBtn',
  codeWrap:'otpCodeWrap', code:'otpCode', verify:'otpVerifyBtn', shown:'acctEmail', logout:'logoutBtn' });
mountBindFlow({ out:'bindLoggedOut', in:'bindLoggedIn', email:'bindEmail', send:'bindSendBtn',
  codeWrap:'bindCodeWrap', code:'bindCode', verify:'bindVerifyBtn', shown:'bindEmailShow', logout:'bindLogoutBtn',
  head:'bindHead', box:'authBind' });
/* 空间列表丢了（换机、清数据、只用过配置码）：按成员表把网盘上属于我的空间找回来 */
$('#scanSpacesBtn').onclick=async()=>{
  const btn=$('#scanSpacesBtn');
  if(!Dav.usable(Dav.cfg()) && !Dav.knownAccounts().length){ toast('请先配置网盘'); openSettings(); return; }
  btn.disabled=true; const old=btn.textContent; btn.textContent='🔍 正在扫描…';
  try{
    const r=await Store.followAccount(myId());
    renderSpaceMgmt();
    toast(r.added.length ? '找回 '+r.added.length+' 个空间（扫了 '+r.scanned+' 份文件）'
      : '扫了 '+r.scanned+' 份文件，成员表里没有你现在的身份（'+myId().slice(0,10)+'）——换过邮箱登录的话，先登录再扫');
  }catch(e){ toast(e.message); }
  finally{ btn.disabled=false; btn.textContent=old; }
};

/* 配置码 B/C 共存：手动表单 = 方式B（本机默认账号）；配置码 = 方式C。
   方式C 只把它带到「它自己那个空间」上：本机已经配过网盘时绝不再覆盖默认账号，
   否则一粘家人的配置码，自己的空间立刻读不到、还在别人网盘里另建一份同名文档，
   两个人从此各写各的（用户反馈的「同步不上新加入的用户」）。 */
$('#cfgImportBtn').onclick=()=>{ $('#cfgImportText').value=''; $('#cfgImportModal').hidden=false; };
$('#cfgImportCancel').onclick=()=>{ $('#cfgImportModal').hidden=true; };
$('#cfgImportSave').onclick=async()=>{
  const btn=$('#cfgImportSave'); btn.disabled=true;
  try{
    const r = Dav.parseCode($('#cfgImportText').value);
    const code = r.spaceCode;
    const hadAcct = Dav.usable(Dav.cfg());
    if(!hadAcct) Dav.saveConfig(r.cfg);        // 本机还没配网盘：配置码就当默认账号，首次体验不变
    else if(!code) Dav.rememberAccount(r.cfg); // 没带房间：只记住这个账号，不动默认
    if(code){
      const cur = Dav.spaceCfg(code);
      if(Store.get(code) && Dav.usable(cur)){
        /* 先用邀请码进来、事后才粘配置码：本机这个账号已经读得到那份文档，
           就继续用本地已登录的网盘同步，不再问一遍改绑，也不会多出第二个同名空间 */
        Store.claimAdmin(code)
          ? toast('这个空间本机已在同步：继续用原来的网盘账号，并已按配置码把你认作管理员')
          : toast('这个空间本机已在同步：继续用原来的网盘账号（管理员资格由创建者给收，本次没有改动）');
      } else if(Dav.usable(cur) && !Dav.sameAccount(cur, r.cfg)){
        const name=(Store.get(code)||{}).name||code;
        const pick=await ask({
          title:'「'+name+'」已经存在另一个网盘上',
          text:'本机原来用配置码进过这个空间，它存放在 '+Dav.acctLabel(code)+'；这次导入的配置码指向 '+Dav.acctLabelOf(r.cfg)+'。保持原样才不会读错文件、也不会把数据写到两个网盘上。',
          options:[
            { v:'keep', t:'保持原有绑定（推荐）', sub:'继续读 '+Dav.acctLabel(code)+' 上的那份数据' },
            { v:'new', t:'改用配置码里的账号', sub:'仅在家人已经把空间搬到 '+Dav.acctLabelOf(r.cfg)+' 时选' },
          ],
        });
        if(pick==='cancel') return;
        if(pick==='new') Dav.bindSpace(code, r.cfg);
        else Store.claimAdmin(code);
      } else {
        Dav.bindSpace(code, r.cfg);
      }
    }
    $('#cfgImportModal').hidden=true;
    toast(code ? '配置码已导入，正在测试该空间的连接…' : '已记住这个网盘账号');
    try{
      await Dav.test(code || null);
      if(code){ await joinSpace(code); }
      else if(!hadAcct){ toast('该配置码没带房间，请在首页创建或用邀请码加入'); $('#settingsBack').onclick(); }
      else toast('该配置码没带房间：新建空间会用本机默认账号 '+Dav.acctLabel()+'，若要用它请先把默认账号改成这个');
    }catch(e){ toast(e.message); }
  }catch(e){ toast(e.message); }
  finally{ btn.disabled=false; }
};
$('#cfgExportBtn').onclick=()=>{
  try{
    const sc = state.code || localStorage.getItem('tm:lastSpace') || '';
    $('#cfgExportText').value = Dav.exportCode(sc);
    $('#cfgExportAcct').textContent = '这份配置码里的网盘账号：' + Dav.acctLabel(sc) + (sc ? '' : '（本机默认账号，还没带上某个空间）');
    $('#cfgExportModal').hidden=false;
    if(!sc) toast('本机还没有可用房间，对方导入后需自行创建/加入');
  }catch(e){ toast(e.message); }
};
$('#cfgExportClose').onclick=()=>{ $('#cfgExportModal').hidden=true; };
$('#cfgExportCopy').onclick=()=>{
  const t=$('#cfgExportText');
  if(navigator.clipboard) navigator.clipboard.writeText(t.value).then(()=>toast('已复制，请仅发给信任的人')).catch(()=>{ t.select(); toast('长按手动复制'); });
  else { t.select(); toast('长按手动复制'); }
};

/* ---------- 创建 / 加入空间 ---------- */
function openSpaceModal(mode){
  state.spaceMode=mode;
  $('#spaceModalTitle').textContent = mode==='create' ? '创建共享空间' : '用邀请码加入';
  $('#spaceNameLabel').classList.toggle('hidden', mode!=='create');
  $('#spaceCodeLabel').classList.toggle('hidden', mode!=='join');
  $('#spaceNameInput').value=''; $('#spaceCodeInput').value='';
  $('#switchModal').hidden=true;
  $('#spaceModal').hidden=false;
}
$('#spaceCancel').onclick=()=>{ $('#spaceModal').hidden=true; };
$('#spaceSave').onclick=async()=>{
  const btn=$('#spaceSave'); btn.disabled=true;
  try{
    if(state.spaceMode==='create'){
      const name=$('#spaceNameInput').value.trim()||'共享日程';
      const code=genCode();
      const data=Store.createSpace(code,name);
      Dav.bindSpace(code, Dav.cfg()); /* 新建的空间钉在本机默认账号上：之后改默认账号也不会把它带走 */
      const p=await Dav.put(code, JSON.stringify(data), null); /* 仅新建：已存在就是撞码，不能覆盖别人的空间 */
      if(p.status===412){ toast('邀请码刚好撞车了，请再点一次创建'); return; }
      Store.upsertSpaceMeta(code,name);
      $('#spaceModal').hidden=true;
      await enterSpace(code);
    }else{
      const code=$('#spaceCodeInput').value.trim().toUpperCase();
      if(!code) return toast('请输入邀请码');
      $('#spaceModal').hidden=true;
      await joinSpace(code);
    }
  }catch(e){ toast(e.message); }
  finally{ btn.disabled=false; }
};
async function joinSpace(code){
  if(!needDav(code)) return;
  /* 加入不再自己 PUT 整篇文档：先合并进本机缓存，写回交给 syncCode（它在覆盖前会重新拉全量合并），
     否则后来的人会把前一个人刚写进去的成员/日程一起盖掉 */
  const { data, etag } = await Store.openRemote(code);
  /* 已经解散的空间不该再往里补人：它只是在等最后一个成员把文档删掉 */
  if (data.dissolved) throw new Error('这个空间已经被创建者解散了，请让对方新建空间后再发邀请码');
  await Store.attach(code, data, etag);
  const isNew = Store.ensureMember(code); // 已在成员表里就不产生额外写入
  Store.upsertSpaceMeta(code, (Store.get(code) || data).name || '共享空间');
  if(!isNew) toast('你已在该空间');
  await enterSpace(code);
}

/* ---------- 空间切换 / 管理 ---------- */
function spaceItems(listEl, onClick){
  listEl.innerHTML='';
  const spaces = Store.listSpaces();
  if(!spaces.length){ listEl.innerHTML='<p class="set-note">还没有空间，点下方按钮创建或加入。</p>'; return; }
  spaces.forEach(s=>{
    const data = Store.get(s.code);
    const st = Store.status(s.code);
    const item=document.createElement('div');
    item.className='space-item'+(s.code===state.code?' current':'');
    /* 空间存在哪个网盘上必须显示出来：多人混合「自己的账号 + 家人的配置码」时，
       这就是「为什么看不见新加进来的人」的第一线索 */
    const acctNote = Dav.isDefaultAcct(s.code) ? '' : ' · 网盘 '+Dav.acctLabel(s.code);
    const errNote = st.missing && st.exists ? ' · ⚠ '+escapeHtml(st.lastError||'网盘上找不到该空间文件') : '';
    /* 已退出/已被移出的成员不计进人数：名片留着是为了让历史日程还认得出人 */
    const liveN = data ? Object.keys(data.members).filter((id)=>!data.members[id].out).length : 0;
    item.innerHTML=`<div class="si-top">
        <div class="si-name">${escapeHtml(s.name||'共享空间')}</div>
        ${s.code===state.code?'<span class="si-now">使用中</span>':''}
      </div>
      <div class="si-meta">${s.code} · ${liveN} 人${st.lastSync?' · '+new Date(st.lastSync).toLocaleTimeString():''}${acctNote}${errNote}</div>`;
    if(onClick) item.onclick=()=>onClick(s);
    else item.onclick=()=>{ if(s.code!==state.code && needDav(s.code)) enterSpace(s.code); };
    /* 首页与设置页都给出「成员」入口：看名单不是管理权限，不该只有设置页才有 */
    const btns=document.createElement('div'); btns.className='si-btns'; item.appendChild(btns);
    const mb=document.createElement('button'); mb.className='si-btn'; mb.textContent='成员'; mb.title='查看成员与管理员';
    mb.onclick=(ev2)=>{ ev2.stopPropagation(); openMemberModal(s.code); };
    btns.appendChild(mb);
    if(!onClick){
      /* 「清空」「移除」两个按钮合成一颗：普通成员点「退出」（云端打个已退出标记 + 清本机副本），
         创建者点「解散」（在云端写下解散标记，其他成员下次进入时看到告知后各自退出） */
      const btn=document.createElement('button');
      btn.className='si-btn danger';
      btn.onclick=(ev2)=>{
        ev2.stopPropagation();
        if(Store.role(s.code)==='creator') openDissolveModal(s.code); else openLeaveModal(s.code);
      };
      btn.textContent = Store.role(s.code)==='creator' ? '解散' : '退出';
      btn.title = Store.role(s.code)==='creator'
        ? '解散该空间：其他成员下次进入时会看到告知，并各自退出'
        : '退出该空间：本机副本一并清掉，重新输入邀请码还能回来';
      btns.appendChild(btn);
    }
    listEl.appendChild(item);
  });
}
function renderSpaceMgmt(){
  spaceItems($('#spaceMgmtList'), null);
  const data = state.code ? Store.get(state.code) : null;
  $('#curSpaceName').textContent = data ? (data.name||'共享日程') : '未进入空间';
  const can = !!state.code && Store.canRename(state.code);
  $('#renameBtn').classList.toggle('hidden', !can);
  $('#renameLockNote').classList.toggle('hidden', !(state.code && !can));
  renderRail();
}
/* ---------- 桌面端左侧空间栏：空间列表常驻（手机上的「切换空间」弹层在桌面上不必每次点开） ---------- */
function renderRail(){
  const box=$('#railSpaces');
  if(!box || !window.Transport || !Transport.isDesktop) return;
  spaceItems(box,(s)=>{ if(s.code!==state.code && needDav(s.code)) enterSpace(s.code); });
}
$('#railCalendar').onclick=()=>{ if(state.code && Store.get(state.code)) showScreen('calendarScreen'); else initStart(); };
$('#railSettings').onclick=openSettings;
$('#railCreate').onclick=()=>{ if(needDav()) openSpaceModal('create'); };
$('#railJoin').onclick=()=>{ if(needDav()) openSpaceModal('join'); };
$('#renameBtn').onclick=()=>{
  const data=Store.get(state.code); if(!data) return;
  $('#renameInput').value=data.name||'';
  $('#renameModal').hidden=false;
};
$('#renameCancel').onclick=()=>{ $('#renameModal').hidden=true; };
$('#renameSave').onclick=()=>{
  const name=$('#renameInput').value.trim();
  if(!name) return toast('请输入空间名称');
  if(Store.renameSpace(state.code, name)){
    $('#renameModal').hidden=true;
    $('#spaceName').textContent=name;
    renderSpaceMgmt();
    toast('空间已改名，稍后自动同步给成员');
  } else toast('只有创建者可以修改空间名称');
};
/* ---------- 快速切换空间（顶栏标题 ☰ 与标题栏点击共用） ---------- */
function openSwitchModal(){
  spaceItems($('#switchList'), (s)=>{ $('#switchModal').hidden=true; enterSpace(s.code); });
  $('#switchModal').hidden=false;
}
$('#switchSpaceBtn').onclick=openSwitchModal;
$('#spaceNameBtn').onclick=openSwitchModal;
$('#swSettings').onclick=()=>{ $('#switchModal').hidden=true; openSettings(); };
$('#swHome').onclick=()=>{ $('#switchModal').hidden=true; }; /* 直接返回就是留在当前空间，不做「跳到上一个空间」 */
$('#swCreate').onclick=()=>{ if(needDav()) openSpaceModal('create'); };
$('#swJoin').onclick=()=>{ if(needDav()) openSpaceModal('join'); };
$('#mgmtCreate').onclick=()=>{ if(needDav()) openSpaceModal('create'); };
$('#mgmtJoin').onclick=()=>{ if(needDav()) openSpaceModal('join'); };

/* ---------- 批量管理日程 ---------- */
let batchIds=[]; const batchSel=new Set();
let batchGroups=[];            // [[组名, [id]]]
const batchBox=new Map();      // 日程 id → 勾选框
let batchHeads=[];             // { box: 组头元素, ids: [...] }
$('#batchBtn').onclick=()=>{
  if(!state.code || !Store.get(state.code)) return toast('请先进入一个空间');
  renderBatch(); $('#batchModal').hidden=false;
};
/* 一组一组列：来自同一个系统日历的日程归成一组，组头那颗勾选框就是「整组一起删」。
   只有系统日历导入的日程带分组名，其余（手工新建 / .ics）统一归到「其他」一组 */
const BATCH_OTHER='本空间新建 / .ics 导入';
function eventGroup(e){ return e.calDisp || (e.calAcct ? e.calAcct+'（未命名日历）' : BATCH_OTHER); }
function renderBatch(){
  const data=Store.get(state.code);
  const mine=Object.keys(data.events).map(k=>data.events[k]).filter(e=>Store.owns(e.ownerId,data))
    .sort((a,b)=>a.date.localeCompare(b.date)||String(a.start||'').localeCompare(String(b.start||'')));
  batchIds=mine.map(e=>e.id); batchSel.clear();
  const byGroup=new Map();
  mine.forEach(e=>{ const g=eventGroup(e); if(!byGroup.has(g)) byGroup.set(g,[]); byGroup.get(g).push(e.id); });
  batchGroups=[...byGroup.entries()];
  const box=$('#batchList'); box.innerHTML=''; batchBox.clear(); batchHeads=[];
  if(!batchIds.length) box.innerHTML='<p class="set-note">这里还没有你自己创建的日程（导入的系统日程看归属标签）。</p>';
  /* 只有一组时分组纯属噪音（等于给整个列表加了个重复的全选），照常平铺 */
  const grouped=batchGroups.length>1;
  batchGroups.forEach(([g,ids])=>{
    if(grouped){
      const head=document.createElement('div'); head.className='batch-group';
      const gcb=document.createElement('input'); gcb.type='checkbox';
      gcb.onchange=()=>{ ids.forEach(id=>{ gcb.checked?batchSel.add(id):batchSel.delete(id); }); syncBatchChecks(); };
      head.appendChild(gcb);
      head.appendChild(el('span','batch-t',g));
      head.appendChild(el('span','ig-cnt',ids.length+' 条'));
      box.appendChild(head);
      batchHeads.push({ box:head, ids });
    }
    ids.forEach(id=>{
      const e=data.events[id];
      const row=document.createElement('label'); row.className='batch-row'+(grouped?' sub':'');
      const cb=document.createElement('input'); cb.type='checkbox';
      cb.onchange=()=>{ cb.checked?batchSel.add(id):batchSel.delete(id); syncBatchChecks(); };
      batchBox.set(id, cb);
      row.appendChild(cb); row.appendChild(el('span','batch-t',`${e.date}${e.start?' '+e.start:''} · ${e.title}`));
      box.appendChild(row);
    });
  });
  syncBatchChecks();
}
/* 勾选状态只有一个来源（batchSel），每次改动后统一回灌到各行与各组，
   避免组框和行框各改各的最后对不上 */
function syncBatchChecks(){
  batchIds.forEach(id=>{ const cb=batchBox.get(id); if(cb) cb.checked=batchSel.has(id); });
  batchHeads.forEach(({ box, ids })=>{
    const cb=box.querySelector('input[type=checkbox]');
    const hit=ids.filter(id=>batchSel.has(id)).length;
    cb.checked = hit>0 && hit===ids.length;
    cb.indeterminate = hit>0 && hit<ids.length;
  });
  const total=batchIds.length;
  $('#batchAll').checked = total>0 && batchSel.size===total;
  $('#batchDel').textContent=`删除所选（${batchSel.size}）`;
  $('#batchDel').disabled=!batchSel.size;
}
$('#batchAll').onchange=(ev)=>{
  batchSel.clear(); if(ev.target.checked) batchIds.forEach(id=>batchSel.add(id));
  syncBatchChecks();
};
$('#batchClose').onclick=()=>{ $('#batchModal').hidden=true; };
$('#batchDel').onclick=async()=>{
  if(!batchSel.size) return;
  if(!await uiConfirm('批量删除日程',`将删除所选 ${batchSel.size} 条日程，并同步给空间所有成员。`,'删除')) return;
  const n=Store.deleteEvents(state.code,[...batchSel]);
  $('#batchModal').hidden=true;
  toast(n?`已删除 ${n} 条日程`:'没有可删除的日程（仅能删除自己创建的）');
};

/* ---------- 成员管理 / 退出空间 ---------- */
const ROLE_ZH = { creator: '创建者', admin: '管理员', member: '成员' };
let memberCode = null;
function openMemberModal(code) {
  if (!Store.get(code)) return toast('这个空间还没有可读的数据，请先同步');
  memberCode = code; renderMembers(); $('#memberModal').hidden = false;
}
function renderMembers() {
  const box = $('#memberList'); box.innerHTML = '';
  const my = Store.role(memberCode);
  $('#memberHint').textContent = my === 'creator'
    ? '你是创建者：可以把某人设为管理员，也能撤销任何人的管理员资格（撤销后只有你能再给回去）；管理员和普通成员你都能移出。网盘上没有服务器，被移出的人再输一次邀请码仍然能回来。'
    : Store.isManager(memberCode)
      ? '你是管理员：可以移出普通成员，管理员资格由创建者给收。网盘上没有服务器，被移出的人再输一次邀请码仍然能回来。'
      : '管理员资格由创建者授予、也由创建者撤销：创建者本人、和创建者用同一个网盘账号的人（拿配置码进来的家人）、以及被创建者指定的人，可以移出普通成员。';
  const { rows, notices } = Store.lookMembers(memberCode);
  if (!rows.length) { box.innerHTML = '<p class="set-note">还没有成员记录。</p>'; return; }
  rows.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'member-row' + (m.out ? ' out' : '');
    /* 昵称/身份/条数/时间必须挤在同一行：昵称过长时自己横向滑，
       绝不能被右边的徽章和按钮压到 0 宽（真机上第二个人的名字就是这么消失的） */
    row.innerHTML = `<div class="mr-top"><span class="dot" style="background:${escapeHtml(m.color || '#999')}"></span>
      <span class="mr-name">${escapeHtml(m.name)}${m.mine ? '（我）' : ''}</span>
      <span class="badge${m.role !== 'member' ? ' mr-role' : ''}">${m.out ? (m.outBy && m.outBy !== m.id ? '已被移出' : '已退出') : ROLE_ZH[m.role]}</span>
      <span class="mr-meta">${m.events} 条 · ${m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : '加入时间未知'}</span></div>`;
    const act = Store.adminAction(memberCode, m.id);
    const btns = document.createElement('div');
    btns.className = 'mr-btns';
    if (act) {
      const btn = document.createElement('button');
      btn.className = 'si-btn'; btn.textContent = act === 'set' ? '设为管理员' : '取消管理员';
      btn.onclick = async () => {
        try {
          Store.setAdmin(memberCode, m.id, act === 'set');
          await Store.syncCode(memberCode);
          toast(act === 'set' ? '已把 ' + m.name + ' 设为管理员' : '已取消 ' + m.name + ' 的管理员');
          renderMembers();
        } catch (e) { toast(e.message); }
      };
      btns.appendChild(btn);
    }
    if (Store.canKick(memberCode, m.id)) {
      const btn = document.createElement('button');
      btn.className = 'si-btn danger'; btn.textContent = '移出';
      btn.onclick = () => openKickModal(m);
      btns.appendChild(btn);
    }
    if (btns.childNodes.length) row.appendChild(btns);
    box.appendChild(row);
  });
  /* 日程已经清空的退出者：第二次打开面板只提这一句，第三次起连这句也没有了 */
  if (notices.length) toast(notices.map((m) => m.name + ' ' + (m.outBy && m.outBy !== m.id ? '已被移出' : '已退出') + '，日程已清空').join('；'));
}
$('#memberClose').onclick = () => { $('#memberModal').hidden = true; };

let leaveCode = null;
let kickTarget = null;
let dissolveCode = null;
const LEAVE_TEXT_HTML = $('#leaveText').innerHTML;
function myEventCount(code) {
  const data = Store.get(code);
  if (!data) return 0;
  return Object.keys(data.events).filter((id) => Store.owns(data.events[id].ownerId, data)).length;
}
/* 空间里只剩自己一个活人时，退出/解散就等于这份云端数据再没人要了（会被一并删掉）。
   这句话必须写在确认弹层上：「自动删除空空间」不能偷偷发生 */
function lastOneNote(code) {
  const data = Store.get(code);
  if (!data) return '';
  const live = Object.keys(data.members).filter((id) => !data.members[id].out).length;
  if (live > 1) return '';
  const ev = Object.keys(data.events).length;
  return `<br><b>这里只剩你一个成员</b>：退出或解散之后，网盘上这份数据${ev ? `（含 ${ev} 条日程）` : ''}会被一并删除，无法恢复。`;
}
function openLeaveModal(code) {
  const data = Store.get(code);
  if (Store.role(code) === 'creator') return toast('你是创建者：要收掉这个空间请用「解散」');
  leaveCode = code; kickTarget = null; dissolveCode = null;
  $('#leaveTitle').textContent = '退出空间';
  $('#leaveOk').textContent = '确认退出';
  if (data) {
    $('#leaveText').innerHTML = LEAVE_TEXT_HTML + lastOneNote(code);
    $('#leaveSpaceName').textContent = data.name || code;
  } else {
    $('#leaveText').innerHTML = '本机没有这个空间可读到的数据（多半是网盘账号不对或没同步过），退出只是把它从本机列表里清掉，网盘上的数据不动。以后重新输入邀请码还能进来。';
  }
  const n = myEventCount(code);
  $('#leavePurgeWrap').classList.toggle('hidden', !n || !!lastOneNote(code));
  $('#leavePurge').checked = false;
  $('#leavePurgeText').textContent = `同时删除我在该空间创建的日程（${n} 条，其他成员也会同步看不到）`;
  $('#leaveModal').hidden = false;
}
/* 解散：创建者特有的「退出」，区别是在云端留下解散标记，让别人下次进入时被明确告知 */
function openDissolveModal(code) {
  const data = Store.get(code);
  if (!data) return openLeaveModal(code);
  if (Store.role(code) !== 'creator') return toast('只有创建者可以解散空间');
  dissolveCode = code; leaveCode = null; kickTarget = null;
  const peers = Math.max(0, Store.liveCount(code) - 1);
  $('#leaveTitle').textContent = '解散空间';
  $('#leaveOk').textContent = '确认解散';
  $('#leaveText').innerHTML = '解散「<b id="leaveSpaceName"></b>」？网盘上的这份数据会先留着，其他'
    + (peers ? peers + ' 位' : '') + '成员下次进入这个空间时会看到「空间已被创建者解散」，确认后各自退出；最后离开的人负责把它删掉。'
    + lastOneNote(code);
  $('#leaveSpaceName').textContent = data.name || code;
  const n = myEventCount(code);
  $('#leavePurgeWrap').classList.toggle('hidden', !n || !!lastOneNote(code));
  $('#leavePurge').checked = false;
  $('#leavePurgeText').textContent = `同时删除我在该空间创建的日程（${n} 条，其他成员也会同步看不到）`;
  $('#leaveModal').hidden = false;
}
/* 移出成员借用同一个弹层：只是把人换成 TA，勾选框换成「删不删 TA 的日程」 */
function openKickModal(m) {
  const data = Store.get(memberCode) || {};
  kickTarget = { code: memberCode, id: m.id };
  leaveCode = null; dissolveCode = null;
  $('#leaveTitle').textContent = '移出成员';
  $('#leaveOk').textContent = '确认移出';
  $('#leaveText').innerHTML = '把「<b>' + escapeHtml(m.name) + '</b>」移出「' + escapeHtml(data.name || memberCode)
    + '」？TA 的本机下次同步会收到移出通知。网盘上没有服务器，对方再输一次邀请码仍然能回来。';
  $('#leavePurgeWrap').classList.toggle('hidden', !m.events);
  $('#leavePurge').checked = false;
  $('#leavePurgeText').textContent = `同时删除 TA 在该空间创建的日程（${m.events} 条，其他成员也会同步看不到）`;
  $('#memberModal').hidden = true;
  $('#leaveModal').hidden = false;
}
$('#leaveCancel').onclick = () => { $('#leaveModal').hidden = true; };
$('#leaveOk').onclick = async () => {
  const btn = $('#leaveOk'); btn.disabled = true;
  const drop = $('#leavePurge').checked;
  try {
    if (kickTarget) {
      const t = kickTarget;
      if (!needDav(t.code)) return;
      if (!Store.kickMember(t.code, t.id, { dropMine: drop })) return toast('TA 已经不是可移出的普通成员了');
      await Store.syncCode(t.code);
      kickTarget = null;
      $('#leaveModal').hidden = true;
      toast('已移出，稍后同步给其他成员');
      memberCode = t.code; $('#memberModal').hidden = false;
      renderMembers(); renderSpaceMgmt();
      return;
    }
    const code = dissolveCode || leaveCode;
    const mode = dissolveCode ? 'dissolve' : 'leave';
    if (!code) return;
    /* 本机根本没有可读数据：没有云端可写，退出就只是把它从本机列表里拿掉 */
    if (!Store.get(code)) {
      Store.removeSpace(code);
      $('#leaveModal').hidden = true;
      toast('已从本机移除该空间');
      if (state.code === code) { state.code = null; stopPolling(); initStart(); } else renderSpaceMgmt();
      return;
    }
    if (!needDav(code)) return;
    const peers = Math.max(0, Store.liveCount(code) - (mode === 'dissolve' ? 1 : 0));
    /* 先把「退出 / 解散」写进云端，成功后才清本机副本：反过来做就等于没退过 */
    const r = mode === 'dissolve' ? await Store.dissolve(code, { dropMine: drop }) : await Store.leave(code, { dropMine: drop });
    if (!r) return toast(mode === 'dissolve' ? '只有创建者可以解散空间' : '你是创建者：要收掉这个空间请用「解散」');
    dissolveCode = null; leaveCode = null;
    Store.removeSpace(code);
    $('#leaveModal').hidden = true;
    toast(r.purged ? (mode === 'dissolve' ? '已解散；这个空间已经没有成员，网盘上的数据一并删除了' : '已退出；这是最后一个成员，网盘上的数据一并删除了')
      : mode === 'dissolve' ? `已解散，其他 ${peers} 位成员下次进入时会看到告知` : '已退出该空间');
    if (state.code === code) { state.code = null; stopPolling(); initStart(); } else renderSpaceMgmt();
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; }
};

/* 被移出的人只看这一条通知：看完就退出该空间、把本机副本交出去，设置与首页的空间列表同时少一条。
   网盘上别人那份数据一个字不动，想回来请对方重发邀请码——所以这里不问「要不要移除」，只告知 */
async function notifyKickedOut(code) {
  const data = Store.get(code);
  if (!data) { Store.removeSpace(code); renderSpaceMgmt(); return; }
  const st = Store.status(code);
  if (state.code === code) stopPolling();
  await uiConfirm('您已被移出',
    `「${data.name || code}」的管理员已经把您移出这个空间，现在退出该空间并清掉本机存的这份副本。`
    + (st.dirty ? '注意：本机还有没同步出去的改动，会一起丢掉。' : '网盘上其他成员那份数据不受影响。')
    + '如果是误操作，请让对方重新发一份邀请码给您。',
    '知道了，退出空间', true);
  Store.removeSpace(code);
  $('#switchModal').hidden = true;
  toast('已退出该空间');
  if (state.code === code) { state.code = null; initStart(); } else renderSpaceMgmt();
}

/* 同步时发现被移出：与「下次进入空间」是同一条路，复用上面那个告知 */
Store.onKicked(notifyKickedOut);

/* 创建者解散了空间：跟「被移出」同一条告知路子，只是主语换成创建者，并且明确说出这份数据随后会被删掉。
   确认后本机退出；同时把自己也记作已退出，最后离开的那台设备负责把网盘上这份文档删掉 */
let dissolvingNotice = false; // 「同步时发现」和「点进这个空间」可能同时到，别弹两次
async function notifyDissolved(code) {
  if (dissolvingNotice) return;
  dissolvingNotice = true;
  try {
    const data = Store.get(code);
    if (!data) { Store.removeSpace(code); renderSpaceMgmt(); return; }
    const st = Store.status(code);
    if (state.code === code) stopPolling();
    await uiConfirm('空间已被创建者解散',
      `「${data.name || code}」的创建者已经解散了这个空间。点确定后本机退出该空间、清掉存的这份副本`
      + (st.dirty ? '（注意：本机还有没同步出去的改动，会一起丢掉）' : '')
      + '。网盘上的那份数据会在最后一个成员也退出之后删除。',
      '知道了，退出空间', true);
    await Store.acknowledgeDissolve(code);
    Store.removeSpace(code);
    $('#switchModal').hidden = true;
    toast('已退出被解散的空间');
    if (state.code === code) { state.code = null; initStart(); } else renderSpaceMgmt();
  } catch (e) { toast(e.message); }
  finally { dissolvingNotice = false; }
}

/* 同步时发现空间被解散：与「下次进入空间」共用上面那条告知 */
Store.onDissolved(notifyDissolved);

/* ---------- 变更通知 / 空间动态 / 小组件（吃同一份同步 diff） ----------
   diff 只报「别人带来的」变更（store.js 算好）：本机记一份动态日志，
   应用在后台时弹系统通知，日程变了顺手把桌面卡片刷一遍。 */
const NOTIFY_KEY = 'tm:notifyOn';
const notifyOn = () => localStorage.getItem(NOTIFY_KEY) !== '0';
function syncNotifySw(){ const sw = $('#notifySw'); if (sw) sw.checked = notifyOn(); }
$('#notifySw').onchange = (e) => { localStorage.setItem(NOTIFY_KEY, e.target.checked ? '1' : '0'); };

const FEED_KEY = 'tm:feed', FEED_MAX = 120;
function loadFeed(){ try { const a = JSON.parse(localStorage.getItem(FEED_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function saveFeed(a){ try { localStorage.setItem(FEED_KEY, JSON.stringify(a.slice(0, FEED_MAX))); } catch (e) { /* 动态不是关键数据，存不下就算了 */ } }
const RSVP_ZH = { yes: '应邀', no: '婉拒', maybe: '待定' };
function memberName(code, key){
  const d = Store.get(code); if (!d || !key) return '';
  const m = d.members[Store.resolve(d, key)] || d.members[key];
  return m && m.name ? m.name : '';
}
function diffText(d, code){
  const who = memberName(code, d.who);
  if (d.kind === 'add') return (who || '有人') + ' 新增了「' + d.title + '」';
  if (d.kind === 'edit') return (who || '有人') + ' 更新了「' + d.title + '」';
  if (d.kind === 'rsvp') return (who || '有人') + ' ' + (RSVP_ZH[d.st] || '更新了出勤') + ' ·「' + d.title + '」';
  return '删除了「' + d.title + '」';
}
Store.onDiff((code, diff) => {
  const feed = loadFeed();
  diff.forEach((d) => { feed.unshift({ code, kind: d.kind, id: d.id, title: d.title, who: d.who, st: d.st, t: d.t }); });
  saveFeed(feed);
  pushWidgetSoon(); // 日程变了，桌面卡片跟着换
  /* 只有应用在后台才弹系统通知：前台用户看得见界面，弹窗反而是打扰 */
  if (document.hidden && notifyOn()) {
    const sp = Store.listSpaces().find((s) => s.code === code);
    diff.slice(0, 3).forEach((d) => {
      Notify.notify({ title: (sp ? sp.name : code) + ' · 日程有更新', body: diffText(d, code), tag: 'reunion-' + code });
    });
  }
});

/* ---------- 小组件推送：今天的剩余日程交给原生壳 ---------- */
let widgetTimer = null;
function pushWidgetSoon(){ clearTimeout(widgetTimer); widgetTimer = setTimeout(pushWidgetNow, 1200); }
function pushWidgetNow(){
  if (!window.Widget) return;
  const out = { date: '', space: '', items: [] };
  const data = state.code ? Store.get(state.code) : null;
  if (data) {
    const t = todayStr(), now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
    out.date = `${now.getMonth() + 1}月${now.getDate()}日 ${WD_ZH[now.getDay()]}`;
    out.space = data.name || '共享日程';
    out.items = splitMarks(occurrences(data, t, t)[t] || []).evs
      .filter((e) => !isAllDay(e) && evEndMin(e) > nowMin)
      .sort(sortByTime).slice(0, 4)
      .map((e) => ({ time: e.start || '', title: e.title || '', color: (data.members[Store.resolve(data, e.ownerId)] || {}).color || '#888' }));
  }
  Widget.push(out);
}

/* ---------- 进入空间 ---------- */
async function enterSpace(code){
  /* 成员记录上已经写着「被别人移出」的人，先把这条通知看完，别把一个没位置的空间当成正常使用 */
  if (Store.kickedOut(code)) { await notifyKickedOut(code); return; }
  if (Store.isDissolved(code)) { await notifyDissolved(code); return; }
  state.code=code;
  if(state.defView!=='last'){ state.view=state.defView; localStorage.setItem(VIEW_KEY,state.view); } /* 设置里指定的默认视图 */
  localStorage.setItem('tm:lastSpace', code); // 下次冷启动直接回到这个空间
  state.day=todayStr(); syncYm();
  let data = Store.get(code), etag;
  if(!data){ const remote = await Store.openRemote(code); data = remote.data; etag = remote.etag; }
  await Store.attach(code, data, etag);
  /* 本机还没有这份数据时上面那道 isDissolved 关卡看不到标记（刚重发邀请码进来的人就是这样）：
     读到云端原文后补一次判定，别把人放进一个已经散掉的空间 */
  if (data.dissolved) { await notifyDissolved(code); return; }
  Store.ensureMember(code); /* 被别人用旧版本覆盖掉时，回到空间就先把自己补回成员表 */
  Store.dedupe(code);
  $('#spaceName').textContent=data.name||'共享日程';
  $('#codeText').textContent=code;
  renderPeopleTags();
  syncAllSegBtn();
  showScreen('calendarScreen'); /* 必须先显示：藏在 display:none 里量不到格子宽度，周视图的「今天置左」会算成 0 */
  renderCalendar(true); updateSyncChip();
  pushWidgetSoon(); // 桌面卡片显示当前空间的今天
  Store.syncCode(code);
  startPolling();
}
function startPolling(){
  stopPolling();
  /* 不在这里挡 visibilityState：后台通知（见 Store.onDiff 里的 document.hidden 分支）
     靠的就是这条轮询把 diff 带回来，挡掉等于永远弹不出来。页面隐藏时浏览器自己会把
     setInterval 限流到分钟级以上，回到前台还有下面那条 visibilitychange 立刻补一次。 */
  state.pollTimer=setInterval(()=>{ if(state.code) Store.syncCode(state.code).then(updateSyncChip); },60000);
}
function stopPolling(){ if(state.pollTimer){ clearInterval(state.pollTimer); state.pollTimer=null; } }
document.addEventListener('visibilitychange',()=>{ if(!document.hidden && state.code) Store.syncCode(state.code).then(updateSyncChip); });
Store.onChange((code)=>{ if(code===state.code){
  renderPeopleTags(); renderCalendar(); updateSyncChip(); renderRail();
  pushWidgetSoon(); // 数据变了，桌面卡片跟着换
  const d=Store.get(code); if(d) $('#spaceName').textContent=d.name||'共享日程';
  if(!$('#settingsScreen').classList.contains('hidden')) renderSpaceMgmt();
} });

/* 云端空间被创建者删掉：提示使用者，同意后连本机副本一起移除 */
Store.onSpaceGone(async (code)=>{
  const data=Store.get(code); if(!data) return;
  if(state.code===code) stopPolling();
  const ok=await uiConfirm('空间已被删除',
    `「${data.name||code}」已经被创建者删除，网盘上已经没有这份数据了。要把它从本机一并移除吗？`, '移除本机副本');
  if(!ok){ if(state.code===code) startPolling(); return; }
  Store.removeSpace(code);
  toast('已移除被删除的空间');
  if(state.code===code){ state.code=null; initStart(); } else renderSpaceMgmt();
});

function updateSyncChip(){
  const s=Store.status(state.code); const el=$('#syncState');
  const btn=$('#syncBtn'); if(btn) btn.classList.toggle('spinning', !!s.syncing);
  if(!s.exists){ el.textContent=''; return; }
  if(s.syncing) el.textContent='同步中…';
  /* 云端读不到这个文件（多半是网盘账号不对）：把账号摊开说，别让「待同步」一直挂着让人猜 */
  else if(s.missing && s.dirty) el.textContent='⚠ 待写入：'+(s.lastError||'网盘上找不到该空间文件');
  else if(s.missing) el.textContent='⚠ '+(s.lastError||'网盘上找不到该空间文件');
  else el.textContent = s.dirty? '待同步（离线可写）' : s.lastSync? '已同步 '+new Date(s.lastSync).toLocaleTimeString() : '';
}
$('#syncBtn').onclick=()=>{
  if(!state.code) return;
  updateSyncChip();
  Store.syncCode(state.code).then(updateSyncChip);
};
$('#copyCode').onclick=()=>{
  const code=$('#codeText').textContent;
  if(navigator.clipboard) navigator.clipboard.writeText(code).then(()=>toast('邀请码已复制：'+code)).catch(()=>toast('邀请码：'+code));
  else toast('邀请码：'+code);
};

/* ---------- 成员标签 ---------- */
function renderPeopleTags(){
  const wrap=$('#peopleTags'); wrap.innerHTML='';
  const data=Store.get(state.code); if(!data) return;
  Object.keys(data.members).forEach(id=>{
    const m=data.members[id];
    if(m.out) return; /* 已退出/已被移出的成员不再出现在标签行里，TA 名下的历史日程照旧显示 */
    const tag=document.createElement('span');
    const on=memberOn(id);
    tag.className='person-tag'+(on?'':' off');
    tag.style.borderColor=m.color; tag.style.background=on?m.color+'22':'transparent';
    tag.innerHTML=`<span class="dot" style="background:${m.color}"></span>${escapeHtml(m.name)}${Store.owns(id,data)?'（我）':''}`;
    tag.onclick=()=>{ state.visible[id]=!on; renderPeopleTags(); renderCalendar(); };
    wrap.appendChild(tag);
  });
}

/* ---------- 视图引擎：月（成员色块 + 当日日程卡列表）/ 周 / 日时间轴 ---------- */
const REPEAT_ZH = { DAILY:'每天', WEEKLY:'每周', MONTHLY:'每月', YEARLY:'每年' };
const WD_ZH = ['周日','周一','周二','周三','周四','周五','周六'];
const REPEAT_UNIT = { DAILY:'天', WEEKLY:'周', MONTHLY:'个月', YEARLY:'年' };
const WD_CODES = ['SU','MO','TU','WE','TH','FR','SA']; /* 与 IcsParser.DAYMAP 同一套顺序 */

/* 重复说明：每 2 周 · 周三、周六 · 直到 2026-12-31。short 给卡片用，只到频率与星期 */
function repeatText(r, short){
  if(!r || !r.freq) return '';
  const f = String(r.freq).toUpperCase();
  const iv = Math.max(1, parseInt(r.interval || 1, 10) || 1);
  const parts = [ f==='YEARLY' && r.lunar
      ? (iv > 1 ? `每${iv}年（农历）` : '农历每年')
      : (iv > 1 ? `每${iv}${REPEAT_UNIT[f] || ''}` : (REPEAT_ZH[f] || f)) ];
  if(f === 'WEEKLY' && r.byDay && r.byDay.length){
    parts.push(r.byDay.slice().sort((a,b)=>IcsParser.DAYMAP[a]-IcsParser.DAYMAP[b])
      .map((c)=>WD_ZH[IcsParser.DAYMAP[c]] || c).join('、'));
  }
  if(f === 'MONTHLY' && r.byMonthDay && r.byMonthDay.length) parts.push(r.byMonthDay.join('、')+' 日');
  if(!short){
    if(r.count) parts.push(`共 ${r.count} 次`);
    else { const u = IcsParser.untilStr(r.until); if(u) parts.push(`直到 ${u}`); }
  }
  return parts.join(' · ');
}

function todayStr(){ const t=new Date(); return dateStr(t.getFullYear(),t.getMonth()+1,t.getDate()); }
function shiftDay(ds,n){ const d=IcsParser.parseDate(ds); d.setDate(d.getDate()+n); return IcsParser.dstr(d); }
function weekDays(ds){ /* 与月视图一致：周日为一周之始 */
  const d=IcsParser.parseDate(ds); d.setDate(d.getDate()-d.getDay());
  const list=[]; for(let i=0;i<7;i++){ list.push(IcsParser.dstr(d)); d.setDate(d.getDate()+1); }
  return list;
}
function toMin(hm){ const p=String(hm||'').split(':'); return (+p[0]||0)*60+(+p[1]||0); }
function isAllDay(e){ return !!e.allDay || !e.start; }
function evStartMin(e){ return isAllDay(e)?0:toMin(e.start); }
function evEndMin(e){
  if(isAllDay(e)) return 1440;
  const s=toMin(e.start);
  if(!e.end) return Math.min(s+60,1440);
  const en=toMin(e.end);
  if(en>s) return Math.max(en,s+15);
  return en<60 ? 1440 : Math.min(s+60,1440); // 跨零点的夜间日程画到当天末尾
}
function el(tag, cls, text){ const n=document.createElement(tag); if(cls) n.className=cls; if(text!=null) n.textContent=text; return n; }
function sortByTime(a,b){ return (isAllDay(b)-isAllDay(a)) || String(a.start||'').localeCompare(String(b.start||'')) || String(a.title||'').localeCompare(String(b.title||'')); }

/* 渲染期按 RRULE 展开，只统计可见成员 */
function occurrences(data, fromStr, toStr){
  const byDay={};
  Object.keys(data.events).forEach(id=>{
    const ev=data.events[id];
    const owner=Store.resolve(data, ev.ownerId);
    if(!memberOn(owner) || !data.members[owner]) return;
    IcsParser.expandOccurrences(ev, fromStr, toStr).forEach(ds=>{ (byDay[ds]=byDay[ds]||[]).push(ev); });
  });
  return byDay;
}
function splitMarks(list){
  return { marks:list.filter(e=>e.type==='work'||e.type==='rest'),
           evs:list.filter(e=>e.type!=='work'&&e.type!=='rest').sort(sortByTime) };
}

function renderCalendar(fresh){
  const data = state.view === 'all' ? null : Store.get(state.code);
  if (state.view !== 'all' && !data) return;
  const cal=$('#calendar'), ag=$('#agenda');
  cal.style.height=''; cal.classList.remove('sizing'); // 折叠动画跑到一半时切视图：固定高度别留在时间轴身上
  document.querySelectorAll('#viewSeg .seg-btn').forEach((b)=>b.classList.toggle('active', b.dataset.val===state.view));
  syncAllSegBtn();
  cal.innerHTML=''; ag.innerHTML='';
  $('#calMain').classList.toggle('with-agenda', state.view==='month' || state.view==='all');
  $('#calMain').classList.toggle('tgrid-mode', state.view!=='month' && state.view!=='all');
  $('#addBtn').hidden = state.view==='month' || state.view==='all'; // 月/聚合视图用列表底部的「新建日程」，悬浮按钮不再压住内容
  $('#monthToggle').classList.toggle('hidden', state.view!=='month' || window.innerWidth>=600);
  $('#peopleBar').classList.toggle('hidden', state.view==='all');
  if(fresh===true) state.monthCollapsed=false; // 切视图/换空间时回到展开态
  if(state.view==='month'){
    $('#weekHeader').hidden=false;
    cal.className='calendar month'+(state.monthCollapsed?' collapsed':'');
    renderMonth(data, cal);
    renderAgenda(data, ag);
  }else if(state.view==='all'){
    $('#weekHeader').hidden=false;
    cal.className='calendar month';
    renderAllMonth(cal);
    renderAllAgenda(ag);
  }else{
    $('#weekHeader').hidden=true;
    renderTimeGrid(data, cal, state.view==='week'?weekDays(state.day):[state.day], fresh);
  }
  $('#monthToggle').classList.toggle('down', state.monthCollapsed); // 图标本身不换字，转 180° 才有连续感
  $('#monthTitle').innerHTML = state.view==='all'
    ? '全部日程'
    : (state.view==='month'
    ? escapeHtml(`${state.year}年${state.month}月`)
    : (state.view==='week'
        /* 区间太长会被顶栏挤断行，干脆自己拆：第一个日期和 – 一行，第二个日期一行 */
        ? (()=>{ const a=IcsParser.parseDate(weekDays(state.day)[0]), b=IcsParser.parseDate(weekDays(state.day)[6]);
                 return `${escapeHtml(`${a.getMonth()+1}月${a.getDate()}日 –`)}<span class="l2">${escapeHtml(`${b.getMonth()+1}月${b.getDate()}日`)}</span>`; })()
        : (()=>{ const d=IcsParser.parseDate(state.day); return escapeHtml(`${d.getMonth()+1}月${d.getDate()}日 ${WD_ZH[d.getDay()]}`); })()));
}

/* ---------- 月视图：格子只放日期与成员色块，整月一屏 ---------- */
/* 格子的农历与自动节假日标注：法定假日显示节日名，平日显示农历日；
   自动「休/班」角标用虚线框，跟成员手工标记的实心块区分开 */
function cellDecorate(cell, cd, ds, hasManualMark){
  const hol = Holidays.get(ds);
  if (hol && !hasManualMark) {
    const dm = el('div', 'daymark auto ' + (hol.off ? 'rest' : 'work'), hol.off ? '休' : '班');
    dm.title = hol.name + (hol.off ? '，放假' : '，调休上班');
    cell.appendChild(dm);
    if (hol.off) cell.classList.add('offday');
  }
  const lun = Lunar.solar2lunar(cd.getFullYear(), cd.getMonth() + 1, cd.getDate());
  const label = hol && hol.off ? hol.name : (lun ? (lun.festival || lun.dayText) : '');
  if (label) cell.appendChild(el('div', 'cell-lunar', label));
}
function renderMonth(data, cal){
  const first=new Date(state.year,state.month-1,1);
  const winFrom=new Date(first); winFrom.setDate(winFrom.getDate()-winFrom.getDay());
  const winTo=new Date(winFrom); winTo.setDate(winTo.getDate()+41);
  const byDay=occurrences(data, IcsParser.dstr(winFrom), IcsParser.dstr(winTo));
  const tStr=todayStr();
  /* 折叠时只留选中日所在那一行 */
  const selIdx=Math.round((IcsParser.parseDate(state.day)-winFrom)/86400000);
  const selRow=Math.max(0,Math.min(5,Math.floor(selIdx/7)));
  for(let i=0;i<42;i++){
    const cd=new Date(winFrom); cd.setDate(winFrom.getDate()+i);
    const ds=IcsParser.dstr(cd);
    const cell=el('div','cell'+(cd.getMonth()!==state.month-1?' other':'')+(ds===tStr?' today':'')+(ds===state.day?' sel':''));
    if(Math.floor(i/7)===selRow) cell.classList.add('keep');
    cell.appendChild(el('div','date-num',String(cd.getDate())));
    const {marks,evs}=splitMarks(byDay[ds]||[]);
    cellDecorate(cell, cd, ds, !!marks.length);
    if(marks.length){ const dm=el('div','daymark '+marks[0].type, marks[0].type==='work'?'班':'休'); cell.appendChild(dm); }
    if(evs.length){
      /* 色块=「人」（一人一块，同一人当天几条只占一块），右上角数字=「条」，
         +N=还有几个人没画下。以前点按人去重、+N 却按事件条数算，
         两个人写 6 条就显示成「2 个点 +4」，两个数都对不上实际日程 */
      const people=[]; const byId={};
      evs.forEach((e)=>{
        const oid=Store.resolve(data,e.ownerId);
        if(byId[oid]){ byId[oid].n++; return; }
        byId[oid]={ id:oid, n:1, color:(data.members[oid]||{}).color||'var(--weak2)' };
        people.push(byId[oid]);
      });
      const dots=el('div','dots');
      people.slice(0,4).forEach((p)=>{
        const d=el('span','mdot'+(p.n>1?' many':'')); d.style.background=p.color; dots.appendChild(d);
      });
      if(people.length>4) dots.appendChild(el('span','mdot more','+'+(people.length-4)));
      cell.appendChild(dots);
      if(evs.length>1) cell.appendChild(el('div','cell-cnt',evs.length+'条'));
      cell.title=people.map((p)=>((data.members[p.id]||{}).name||'未知')+' '+p.n+' 条').join(' · ');
    }
    cell.onclick=()=>{ state.day=ds; syncYm(); renderCalendar(); };
    cal.appendChild(cell);
  }
}

/* ---------- 月视图下方：当日日程卡列表（进度条 + 按时间排列的详情） ---------- */
function renderAgenda(data, box){
  const ds=state.day, d=IcsParser.parseDate(ds);
  const {marks,evs}=splitMarks(occurrences(data, ds, ds)[ds]||[]);
  box.className='agenda';
  const head=el('div','ag-head');
  head.appendChild(el('div','ag-date',`${d.getMonth()+1}月${d.getDate()}日 ${WD_ZH[d.getDay()]}`));
  head.appendChild(el('div','ag-sub', (marks.length?marks.length+' 个假勤 · ':'') + evs.length + ' 条日程'));
  box.appendChild(head);

  const tl=renderSpanBars(data, evs);
  if(tl) box.appendChild(tl);

  if(!marks.length && !evs.length) box.appendChild(el('p','ag-empty','这一天还没有日程。'));
  marks.forEach((e)=>box.appendChild(evCard(data,e,ds)));
  evs.forEach((e)=>box.appendChild(evCard(data,e,ds)));

  const btn=el('button','big-btn ghost ag-new','＋ 新建日程');
  btn.onclick=()=>openEventModal(ds);
  box.appendChild(btn);
}

/* 每人一条时间跨度轨，上面叠当天各日程的小段：一眼看出谁排到几点 */
function renderSpanBars(data, evs){
  const byOwner={};
  evs.forEach((e)=>{ if(isAllDay(e)) return; (byOwner[e.ownerId]=byOwner[e.ownerId]||[]).push(e); });
  const ids=Object.keys(byOwner); if(!ids.length) return null;
  const tl=el('div','tl');
  ids.forEach((id)=>{
    const m=memberOf(data,id);
    const row=el('div','tl-row');
    row.appendChild(el('span','tl-name',m.name+(Store.owns(id,data)?'（我）':'')));
    const track=el('span','tl-track');
    const spans=byOwner[id].map((e)=>[evStartMin(e),evEndMin(e)]);
    const lo=Math.min.apply(null,spans.map((s)=>s[0])), hi=Math.max.apply(null,spans.map((s)=>s[1]));
    const base=el('span','tl-bar');
    base.style.cssText=`left:${lo/1440*100}%;width:${(hi-lo)/1440*100}%;top:4px;bottom:4px;opacity:.4;background:${m.color}`;
    track.appendChild(base);
    byOwner[id].forEach((e)=>{
      const s=evStartMin(e), en=evEndMin(e);
      const b=el('span','tl-bar');
      b.style.cssText=`left:${s/1440*100}%;width:${Math.max((en-s)/1440*100,1)}%;background:${m.color}`;
      b.title=e.title;
      track.appendChild(b);
    });
    row.appendChild(track); tl.appendChild(row);
  });
  const axis=el('div','tl-axis');
  ['0 点','6','12','18','24 点'].forEach((t)=>axis.appendChild(el('span',null,t)));
  tl.appendChild(axis);
  return tl;
}

function evCard(data, e, ds){
  const owner=memberOf(data,e.ownerId);
  const card=el('div','ev-card');
  card.style.borderLeftColor=owner.color;
  const time=e.type!=='normal' ? (e.type==='work'?'上班':'休息') : (isAllDay(e)?'全天':`${e.start}${e.end?'–'+e.end:''}`);
  card.appendChild(el('span','ec-time',time));
  const main=el('div','ec-main');
  main.appendChild(el('div','ec-title', e.type==='normal'?e.title:(e.title+'（'+(e.type==='work'?'班':'休')+'）')));
  const meta=[];
  meta.push(owner.name+(Store.owns(e.ownerId,data)?'（我）':''));
  if(e.rrule) meta.push(repeatText(e.rrule, true));
  if(e.location) meta.push(e.location);
  if(e.desc) meta.push(e.desc);
  main.appendChild(el('div','ec-meta',meta.join(' · ')));
  card.appendChild(main);
  card.onclick=()=>openDetail(e, data, ds);
  return card;
}

/* ---------- 日 / 周视图：时间轴网格，重叠日程分栏，当前时间红线 ---------- */
/* 表头的农历/节假日小字：法定假日的名字替换农历日，调休上班日整格挂黄 */
function decorateHead(cellEl, d, ds){
  const hol = Holidays.get(ds);
  const lun = Lunar.solar2lunar(d.getFullYear(), d.getMonth() + 1, d.getDate());
  const label = hol && hol.off ? hol.name : (lun ? (lun.festival || lun.dayText) : '');
  if (label) cellEl.appendChild(el('div', 'tg-lunar', label));
  if (hol) cellEl.classList.add(hol.off ? 'hol-off' : 'hol-work');
}
function renderTimeGrid(data, cal, days, fresh){
  cal.className='calendar tgrid';
  /* 列宽走 --tg-colw：手机上算成「一屏五格」，多出的两格横向滑出来。
     --tg-n 同时喂给 CSS 的总宽 calc()，三层（表头/全天/正文）才不会滑着滑着错开 */
  cal.style.setProperty('--tg-n', String(days.length));
  document.documentElement.style.setProperty('--tg-cols', String(state.weekFit));
  cal.style.removeProperty('--tg-colw');
  /* 收成整周一屏时列宽要「刚好塞下」：CSS 的 100vw 算不出竖向滚动条占掉的那十几像素，改成量出来的宽度 */
  if(days.length===7 && state.weekFit===7 && window.innerWidth<600){
    const avail=cal.clientWidth-40-7-2; /* 每格还有 1px 分隔线，一起扣掉才真的一屏放得下 */
    if(avail>0) cal.style.setProperty('--tg-colw', Math.floor(avail/7)+'px');
  }
  const colw=`minmax(var(--tg-colw,0px),1fr)`;
  const tpl=`var(--tg-gutter,40px) repeat(${days.length},${colw})`;
  const tStr=todayStr();

  const pin=el('div','tg-pin'); cal.appendChild(pin);
  const head=el('div','tg-head'); head.style.gridTemplateColumns=tpl;
  const corner=el('div','tg-corner');
  corner.appendChild(el('span','tg-hlbl','时'));
  if(days.length>1){
    /* 角格上换掉「时」：点一下把整周收成七格，再点恢复一屏四格（选择记在本地） */
    corner.classList.add('has-fit');
    const fit=el('button','tg-fit', state.weekFit===7?'⤢':'⤡');
    fit.type='button';
    fit.title=fit.ariaLabel=state.weekFit===7?'展开为一屏四格':'收起为一屏七格';
    fit.onclick=(ev)=>{
      ev.stopPropagation();
      state.weekFit = state.weekFit===7 ? 4 : 7;
      localStorage.setItem(WEEK_FIT_KEY, String(state.weekFit));
      renderCalendar();
    };
    corner.appendChild(fit);
  }
  head.appendChild(corner);
  days.forEach((ds)=>{
    const d=IcsParser.parseDate(ds);
    const c=el('div','tg-hcell'+(ds===tStr?' today':'')+(d.getDay()===0?' sun':d.getDay()===6?' sat':''));
    if(days.length===1){
      /* 日视图：日期、星期尽量挤在一行，列宽不够时靠 flex-wrap 自动折两行 */
      c.classList.add('wide');
      if(ds===tStr) c.appendChild(el('span','tdy','今天'));
      c.appendChild(el('span','dt',`${d.getMonth()+1}月${d.getDate()}日`));
      c.appendChild(el('span','wd',WD_ZH[d.getDay()]));
      decorateHead(c, d, ds);
    } else {
      c.appendChild(el('div',null,WD_ZH[d.getDay()]));
      c.appendChild(el('div','dnum',String(d.getDate())));
      decorateHead(c, d, ds);
    }
    c.onclick=()=>{ state.day=ds; if(state.dayView) setView('day'); };
    head.appendChild(c);
  });
  pin.appendChild(head);

  const byDay=occurrences(data, days[0], days[days.length-1]);
  const ad=el('div','tg-allday'); ad.style.gridTemplateColumns=tpl;
  ad.appendChild(el('div','tg-adlabel','全天'));
  days.forEach((ds)=>{
    const {marks,evs}=splitMarks(byDay[ds]||[]);
    const cell=el('div','tg-adcell');
    marks.forEach((m)=>{ const chip=el('span','ad-chip',(m.type==='work'?'班 ':'休 ')+m.title);
      chip.style.background=m.type==='work'?'var(--work-fg)':'var(--rest-fg)'; chip.onclick=()=>openDetail(m,data,ds); cell.appendChild(chip); });
    evs.filter(isAllDay).forEach((e)=>{
      const m=memberOf(data,e.ownerId);
      const chip=el('span','ad-chip',e.title); chip.style.background=m.color; chip.onclick=()=>openDetail(e,data,ds);
      cell.appendChild(chip);
    });
    ad.appendChild(cell);
  });
  pin.appendChild(ad); /* 表头 + 全天行一起吸顶，滚时间也不会滚丢 */

  const body=el('div','tg-body');
  const hours=el('div','tg-hours');
  for(let h=0;h<24;h++) hours.appendChild(el('div','tg-hour',pad(h)+':00'));
  if(days.indexOf(tStr)>=0){
    /* 标尺上给出精确到分钟的当前时间：小时列吸左，横向滑动时也不会滑丢 */
    const n0=new Date();
    const rn=el('div','tg-rnown',`${pad(n0.getHours())}:${pad(n0.getMinutes())}`);
    rn.style.top=(n0.getHours()*60+n0.getMinutes())/1440*100+'%';
    hours.appendChild(rn);
  }
  body.appendChild(hours);
  const cols=el('div','tg-cols'); cols.style.gridTemplateColumns=`repeat(${days.length},${colw})`;
  days.forEach((ds)=>{
    const {evs}=splitMarks(byDay[ds]||[]);
    const col=el('div','tg-col'+(ds===tStr?' today':''));
    layoutLanes(evs.filter((e)=>!isAllDay(e))).forEach((it)=>{
      col.appendChild(timedEvBlock(data,it,ds));
    });
    if(ds===tStr){
      const now=el('div','tg-now');
      const n=new Date();
      now.style.top=(n.getHours()*60+n.getMinutes())/1440*100+'%';
      col.appendChild(now);
    }
    cols.appendChild(col);
  });
  body.appendChild(cols);
  cal.appendChild(body);

  if(fresh){
    const hh=(cal.querySelector('.tg-hour')||{offsetHeight:46}).offsetHeight||46;
    const top=Math.max(0, (new Date().getHours()-1)*hh);
    /* 现在滚动条在时间轴自己身上。#calMain 在时间轴模式下是 overflow:hidden，
       一旦被程序滚走就再也滑不回来（表现为表头被吃掉一半、划不到顶），所以强制归零 */
    $('#calMain').scrollTop=0; cal.scrollTop=top;
    cal.scrollLeft=0;
    /* 周视图：把今天滑到小时列右边第一格（周日本来就是一周第一格，不用滑） */
    const ti=days.indexOf(tStr);
    if(ti>0 && days.length>1){
      const cell=head.children[ti+1]; /* 第 0 格是小时列的占位 */
      if(cell){
        const gutter=(cal.querySelector('.tg-hours')||{offsetWidth:40}).offsetWidth||40;
        cal.scrollLeft += cell.getBoundingClientRect().left - cal.getBoundingClientRect().left - gutter;
      }
    }
  }
}

/* 同一天的重叠日程切分成并排的栏：组内互不重叠的各自占满宽度 */
function layoutLanes(evs){
  const items=evs.map((e)=>({e,s:evStartMin(e),t:evEndMin(e)})).sort((a,b)=>a.s-b.s||b.t-a.t);
  const out=[]; let group=[], lanes=[], groupEnd=-1;
  const close=()=>{ const n=lanes.length; group.forEach((g)=>{ g.lanes=n; }); out.push.apply(out,group); group=[]; lanes=[]; };
  items.forEach((it)=>{
    if(group.length && it.s>=groupEnd){ close(); groupEnd=-1; }
    let li=lanes.findIndex((end)=>end<=it.s);
    if(li<0){ li=lanes.length; lanes.push(it.t); } else lanes[li]=it.t;
    it.lane=li; group.push(it); groupEnd=Math.max(groupEnd,it.t);
  });
  if(group.length) close();
  return out;
}

function timedEvBlock(data, it, ds){
  const e=it.e, m=memberOf(data,e.ownerId);
  const b=el('div','tg-ev');
  const raw=it.t-it.s, span=Math.max(raw,40); /* 一小时以内的块连一行字都放不下：先给个最小高度，剩下的靠块内滚动看全 */
  const tight=raw<=35;
  if(tight) b.classList.add('tight');
  b.style.cssText=`top:${it.s/1440*100}%;height:${Math.min(span/1440*100,100-it.s/1440*100)}%;left:${it.lane/it.lanes*100}%;width:${100/it.lanes-1.2}%;background:${m.color};border-left-color:${shade(m.color,-25)}`;
  b.appendChild(el('b',null,e.title));
  b.appendChild(el('span','tm',`${e.start||''}${e.end?'–'+e.end:''}${tight?'':' '+m.name}`));
  if(e.location) b.appendChild(el('span','loc','📍 '+e.location));
  b.onclick=(ev)=>{ ev.stopPropagation(); openDetail(e,data,ds); };
  return b;
}

/* 月视图的年/月始终跟随所选日期；翻月时保持"同一天"再夹到月末 */
function syncYm(){ const d=IcsParser.parseDate(state.day); state.year=d.getFullYear(); state.month=d.getMonth()+1; }
function setView(v){ if(v==='day' && !state.dayView) v='week'; state.view=v; localStorage.setItem(VIEW_KEY,v); renderCalendar(true); }
$('#viewSeg').onclick=(e)=>{ const b=e.target.closest('.seg-btn'); if(b && b.dataset.val!==state.view) setView(b.dataset.val); };

/* ---------- 月视图折叠：上滑收起整月（只留选中那一行），下划展开 ---------- */
function setMonthCollapsed(v){
  if(state.monthCollapsed===v) return;
  const cal=$('#calendar');
  const fromH=cal.offsetHeight;
  state.monthCollapsed=v;
  renderCalendar();
  unfoldHeight(cal, fromH);
}
/* 收起靠的是 .cell{display:none}，高度是瞬间跳的，看着像整块日历被抽掉；
   在旧高度和新自然高度之间补一段 transition，格子跟着容器一起长回来/压回去 */
function unfoldHeight(el, fromH){
  const toH=el.offsetHeight;
  if(!fromH || Math.abs(toH-fromH)<2) return;
  const end=()=>{
    el.classList.remove('sizing'); el.style.height='';
    el.removeEventListener('transitionend',end);
    clearTimeout(kick);
  };
  const kick=setTimeout(end,520); // 中途又被重绘时 transitionend 不一定来，别把内联高度留在身上
  el.style.height=fromH+'px';
  /* 起点要实在地画上一帧才开始过渡：同一帧里改高度的话，展开那个方向会先僵住再跳过去（实测） */
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    if(el.style.height!==fromH+'px') return; // 这期间已被别的渲染接管，就别再插手
    el.classList.add('sizing');
    el.style.height=toH+'px';
    el.addEventListener('transitionend',end);
  }));
}
$('#monthToggle').onclick=()=>setMonthCollapsed(!state.monthCollapsed);
/* 横滑切视图：月→周→日（反向亦然），不必每次去点顶栏的切换钮。
   周视图「一屏四格」时横向本来是时间轴自己在滚，这个手势让给它：
   只有滚动位置没变（内容不宽 / 已滑到边界）才当作切视图 */
function shiftView(dir){
  const order=['month','week','day'].filter((v)=> v!=='day' || state.dayView);
  const i=order.indexOf(state.view);
  if(i<0) return;
  const j=i+dir;
  if(j>=0 && j<order.length) setView(order[j]);
}
let mSwipe=null;
$('#calMain').addEventListener('touchstart',(e)=>{
  if(e.touches.length!==1){ mSwipe=null; return; }
  const t=e.touches[0];
  mSwipe={ y:t.clientY, x:t.clientX, sl:$('#calendar').scrollLeft };
},{passive:true});
$('#calMain').addEventListener('touchend',(e)=>{
  if(!mSwipe) return;
  const t=e.changedTouches[0], dy=t.clientY-mSwipe.y, dx=t.clientX-mSwipe.x;
  const ax=Math.abs(dx), ay=Math.abs(dy);
  const cal=$('#calendar');
  if(ax>70 && ax>ay*1.6){
    if(!cal || cal.scrollLeft===mSwipe.sl) shiftView(dx<0?1:-1);
  } else if(state.view==='month' && window.innerWidth<600 && ay>48 && ay>ax*1.5){
    setMonthCollapsed(dy<0);
  }
  mSwipe=null;
},{passive:true});

setInterval(()=>{ // 时间红线自己走，不必整页重绘
  const n=new Date(), hm=pad(n.getHours())+':'+pad(n.getMinutes());
  const pct=(n.getHours()*60+n.getMinutes())/1440*100;
  document.querySelectorAll('.tg-now').forEach((el2)=>{ el2.style.top=pct+'%'; });
  document.querySelectorAll('.tg-rnown').forEach((el2)=>{ el2.style.top=pct+'%'; el2.textContent=hm; });
},60000);

/* ---------- 日程详情 ---------- */
let detailEvent=null, detailDate=null, detailCode=null; // detailCode：日程所属空间（聚合视图里点开别人的日程时与 state.code 不同）
function openDetail(ev, data, ds){
  detailEvent=ev; detailDate=ds||ev.date; detailCode=data.code||state.code;
  const owner=memberOf(data,ev.ownerId);
  $('#detailDot').style.background=owner.color;
  $('#detailTitle').textContent=ev.title;
  const lines=[];
  const mine=Store.owns(ev.ownerId,data);
  lines.push(`成员：${owner.name}${mine?'（我）':''}`);
  lines.push(`日期：${detailDate}${detailDate!==ev.date?'（原起于 '+ev.date+'）':''}${ev.endDate?' → '+ev.endDate:''}`);
  if(!ev.allDay && ev.start) lines.push(`时间：${ev.start}${ev.end?' – '+ev.end:''}`);
  if(ev.allDay || !ev.start) lines.push('全天');
  if(ev.rrule) lines.push(`重复：${repeatText(ev.rrule)}`);
  if(ev.rem!=null) lines.push(`提醒：${remText(ev.rem)}`);
  if(ev.type==='work'||ev.type==='rest') lines.push(`类型：${ev.type==='work'?'班（调休上班）':'休（放假）'}`);
  if(ev.location) lines.push(`地点：${ev.location}`);
  if(ev.calDisp||ev.calAcct) lines.push(`来自日历：${ev.calDisp}${ev.calAcct?'（'+ev.calAcct+'）':''}`);
  const d=IcsParser.parseDate(detailDate);
  const lun=Lunar.solar2lunar(d.getFullYear(),d.getMonth()+1,d.getDate());
  /* monthText 自己就带「闰」前缀（Lunar.monthName 里加的），这里再补一次会变成「闰闰二月」 */
  if(lun) lines.push(`农历：${lun.monthText}${lun.dayText}（${lun.yearText}${lun.animal}年）`);
  const hol=Holidays.get(detailDate);
  if(hol) lines.push(`节假日：${hol.name}（${hol.off?'休':'调休上班'}）`);
  if(ev.desc) lines.push(`备注：${ev.desc}`);
  $('#detailMeta').innerHTML=lines.map(l=>`<div class="dm-row">${escapeHtml(l)}</div>`).join('');
  renderDetailRsvp(ev, data, detailCode||state.code);
  $('#detailDelete').classList.toggle('hidden', !mine);
  $('#detailEdit').classList.toggle('hidden', !mine);
  $('#detailLockNote').classList.toggle('hidden', mine);
  $('#detailModal').hidden=false;
}
function remText(min){
  min=Number(min)||0;
  if(min===0) return '准时';
  if(min>=1440) return '提前 '+Math.round(min/1440)+' 天';
  if(min>=60) return '提前 '+(min%60 ? (min/60).toFixed(min%60?1:0) : min/60)+' 小时';
  return '提前 '+min+' 分钟';
}
/* 出勤应答：任何人都能答自己那份（store 里按 clientId 逐键合并），正文编辑权照旧只归创建者 */
function renderDetailRsvp(ev, data, code){
  const box=$('#detailRsvp'); box.innerHTML='';
  if(!ev || ev.type==='work' || ev.type==='rest'){ box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const r=ev.rsvp||{};
  const meKey=Store.resolve(data,myId());
  const cur=(r[meKey]||{}).s||'';
  box.appendChild(el('div','rsvp-q','出个席：你能来吗？'));
  const btns=el('div','rsvp-btns');
  [['yes','🙋 来'],['maybe','🤔 待定'],['no','🙅 不去']].forEach(([v,t])=>{
    const b=el('button','rsvp-btn'+(cur===v?' on':''),t); b.type='button';
    b.onclick=()=>{
      Store.setRsvp(code, ev.id, cur===v?null:v);
      $('#detailModal').hidden=true;
      toast('已记录出勤，稍后同步给成员');
    };
    btns.appendChild(b);
  });
  box.appendChild(btns);
  const others=Object.keys(r).filter((k)=>k!==meKey);
  if(others.length){
    const txt=others.map((k)=>{
      const m=data.members[Store.resolve(data,k)]||data.members[k]||{};
      return (m.name||'成员')+' '+(RSVP_ZH[r[k].s]||r[k].s);
    }).join(' · ');
    box.appendChild(el('div','rsvp-list',txt));
  }
}
$('#detailClose').onclick=()=>{ $('#detailModal').hidden=true; };
$('#detailEdit').onclick=()=>{
  if(!detailEvent) return;
  const ev=detailEvent;
  $('#detailModal').hidden=true;
  openEventModal(null, ev);
};
$('#detailDelete').onclick=async()=>{
  if(!detailEvent) return;
  if(!await uiConfirm('删除日程',`删除「${detailEvent.title}」？删除会同步给空间内所有成员。`,'删除')) return;
  if(Store.deleteEvent(detailCode||state.code, detailEvent.id)){ $('#detailModal').hidden=true; toast('已删除'); }
  else toast('只有创建者可以删除这条日程');
};

/* ---------- 新建 / 编辑日程 ---------- */
let editingEvent=null;
let editingCode=null; // 编辑的是哪个空间的日程（聚合视图/详情里可能不是当前空间）
function openEventModal(presetDate,ev,pre){
  editingEvent=ev||null;
  editingCode=ev?(detailCode||state.code):state.code;
  $('#eventModalTitle').textContent=ev?'编辑日程':'新建日程（归属于我）';
  $('#evTitle').value=ev?ev.title:'';
  $('#evDate').value=(ev?ev.date:null)||presetDate||state.day||todayStr();
  $('#evAllDay').checked=ev?!!ev.allDay:false;
  $('#timeRow').style.display=$('#evAllDay').checked?'none':'flex';
  $('#evStart').value=(ev&&ev.start)||'09:00'; $('#evEnd').value=(ev&&ev.end)||'10:00';
  $('#evType').value=(ev&&ev.type)||'normal'; $('#evDesc').value=(ev&&ev.desc)||'';
  $('#evLocation').value=(ev&&ev.location)||'';
  $('#evRem').value=(ev&&ev.rem!=null)?String(ev.rem):'none';
  fillRepeatForm(ev?ev.rrule:null);
  /* 从共同空闲点进来：日期和时段都按选中的空档预填 */
  if(pre){
    $('#evAllDay').checked=false;
    $('#timeRow').style.display='flex';
    $('#evStart').value=pre.start||'09:00'; $('#evEnd').value=pre.end||'10:00';
  }
  $('#eventModal').hidden=false;
}
$('#eventCancel').onclick=()=>{ $('#eventModal').hidden=true; editingEvent=null; };
$('#evAllDay').onchange=(e)=>{ $('#timeRow').style.display=e.target.checked?'none':'flex'; };

/* ---------- 重复细节行：选了频率才展开，不重复的日程不必占四行空白 ---------- */
const REP_DAY_ORDER=['MO','TU','WE','TH','FR','SA','SU']; /* 周一排到周日，和月历表头一致 */
let keepRepByMonthDay=null;
function pickedWeekdays(){
  return [...document.querySelectorAll('#evWeekdays .wd.on')].map((b)=>b.dataset.day);
}
function setWeekdays(days){
  document.querySelectorAll('#evWeekdays .wd').forEach((b)=>b.classList.toggle('on',!!days&&days.indexOf(b.dataset.day)>-1));
}
function syncRepeatRows(){
  const f=$('#evRepeat').value, end=$('#evRepEnd').value;
  $('#evRepMore').classList.toggle('hidden',f==='none');
  $('#evRepDays').classList.toggle('hidden',f!=='weekly');
  $('#evLunarRow').classList.toggle('hidden',f!=='yearly');
  $('#evIntervalUnit').textContent=REPEAT_UNIT[f.toUpperCase()]||'';
  $('#evRepCountRow').classList.toggle('hidden',end!=='count');
  $('#evRepUntilRow').classList.toggle('hidden',end!=='until');
}
(function buildWeekdayChips(){
  const box=$('#evWeekdays');
  REP_DAY_ORDER.forEach((c)=>{
    const b=el('button','wd'); b.type='button'; b.dataset.day=c;
    b.textContent=WD_ZH[IcsParser.DAYMAP[c]].slice(1); /* 「周三」→「三」，格子只放得下一个字 */
    b.onclick=()=>b.classList.toggle('on');
    box.appendChild(b);
  });
})();
/* 刚切到「每周」时把开始日那天先亮起来：展开逻辑在无 BYDAY 时就是按开始日的星期走的，
   这里让界面显示的和高亮缺省的那条一致，免得看到一排空格以为没选 */
function defaultWeekdayChip(){
  const ds=$('#evDate').value; if(!ds) return;
  const p=ds.split('-');
  setWeekdays([WD_CODES[new Date(Number(p[0]),Number(p[1])-1,Number(p[2])).getDay()]]);
}
$('#evRepeat').onchange=()=>{
  if($('#evRepeat').value==='weekly'&&!pickedWeekdays().length) defaultWeekdayChip();
  syncRepeatRows();
};
$('#evRepEnd').onchange=syncRepeatRows;

function repeatFromForm(){
  const f=$('#evRepeat').value.toUpperCase();
  if(f==='NONE') return null;
  const r={ freq:f, interval:Math.min(30,Math.max(1,parseInt($('#evInterval').value,10)||1)),
    byDay:null, byMonthDay:keepRepByMonthDay, count:null, until:null, lunar:null };
  if(f!=='MONTHLY') r.byMonthDay=null;
  if(f==='WEEKLY'){ const d=pickedWeekdays(); if(d.length) r.byDay=d; }
  if(f==='YEARLY' && $('#evLunar').checked) r.lunar=true; else delete r.lunar;
  const end=$('#evRepEnd').value;
  if(end==='count') r.count=Math.min(999,Math.max(1,parseInt($('#evRepCount').value,10)||1));
  else if(end==='until') r.until=$('#evRepUntil').value||null;
  return r;
}
function fillRepeatForm(r){
  /* 弹层里没有「每月几号」的选择器，而导入的 .ics 常带 BYMONTHDAY；
     改动这条日程的别的字段时把它原样带着走，丢了就悄悄变成按开始日的号数出现 */
  keepRepByMonthDay=r&&r.byMonthDay?r.byMonthDay.slice():null;
  $('#evRepeat').value=r?String(r.freq||'none').toLowerCase():'none';
  $('#evInterval').value=(r&&r.interval)||1;
  $('#evRepEnd').value=r&&r.count?'count':(r&&r.until?'until':'never');
  $('#evRepCount').value=(r&&r.count)||10;
  $('#evRepUntil').value=r?IcsParser.untilStr(r.until)||'':'';
  $('#evLunar').checked=!!(r&&r.lunar);
  setWeekdays(r?r.byDay:null);
  syncRepeatRows();
}
$('#eventSave').onclick=async()=>{
  const date=$('#evDate').value; if(!date) return toast('请选择日期');
  const allDay=$('#evAllDay').checked;
  const rrule=repeatFromForm();
  if(rrule&&rrule.until&&rrule.until<date) return toast('「直到某天」要晚于开始日期');
  const remVal=$('#evRem').value;
  const ev={
    title:$('#evTitle').value.trim()||'未命名日程', date,
    allDay, start:allDay?'':$('#evStart').value,
    end:allDay?'':$('#evEnd').value, type:$('#evType').value, desc:$('#evDesc').value,
    location:$('#evLocation').value.trim(),
    rrule,
    rem: remVal==='none' ? null : Number(remVal),
  };
  if(allDay) ev.endDate=null;
  let ok=true;
  let sysBack=null;
  if(editingEvent){
    if(date!==editingEvent.date) ev.endDate=null; // 改了日期，原来的多天区间不再成立
    ok=Store.updateEvent(editingCode||state.code, editingEvent.id, ev);
    /* 从系统日历导入的日程：改动要回到它原来所在的那个日历，改前先逐条确认，且永不删除 */
    if(ok && CalBridge.sysHandle(editingEvent.sourceUid)){
      sysBack={ before:editingEvent, after:Object.assign({}, editingEvent, ev) };
    }
  } else {
    const ev2=Object.assign({}, ev); delete ev2.rem; // 新建时没选提醒就不落 rem 键，云端少一个字段
    if(ev.rem!=null) ev2.rem=ev.rem;
    Store.addEvent(editingCode||state.code, ev2);
  }
  state.day=date; syncYm();
  editingEvent=null; editingCode=null;
  $('#eventModal').hidden=true; toast(ok?'已保存，稍后自动同步':'只有创建者可以编辑这条日程');
  pushWidgetSoon();
  if(sysBack) await syncBackToSystemCalendar(sysBack.before, sysBack.after);
};

/* 事件开始时间的毫秒值：写回原日历时靠它框定原生侧的回查范围 */
function evStartMs(ev){
  if(!ev || !ev.date) return 0;
  const p=String(ev.date).split('-'), hm=String(ev.start||'00:00').split(':');
  const h=ev.allDay?0:Number(hm[0]), m=ev.allDay?0:(Number(hm[1])||0);
  return new Date(Number(p[0]),Number(p[1])-1,Number(p[2]),h,m).getTime();
}
function evTimeText(ev){
  return ev.allDay ? (ev.date+' 全天'+(ev.endDate?' ~ '+ev.endDate:'')) : (ev.date+' '+(ev.start||'')+'-'+(ev.end||''));
}
async function syncBackToSystemCalendar(before, after){
  const cal=after.calDisp||after.calAcct||'原日历';
  const changed=[];
  if(evStartMs(before)!==evStartMs(after)||String(before.endDate)!==String(after.endDate)) changed.push('时间：'+evTimeText(before)+' → '+evTimeText(after));
  if((before.title||'')!==(after.title||'')) changed.push('标题：'+before.title+' → '+after.title);
  if((before.desc||'')!==(after.desc||'')) changed.push('备注有改动');
  if((before.location||'')!==(after.location||'')) changed.push('地点：'+(before.location||'无')+' → '+(after.location||'无'));
  if(!changed.length) return; // 没改到系统日历里的字段，不必打扰
  const go=await uiConfirm('写回系统日历',
    '这条日程来自系统日历「'+cal+'」。\n\n'+changed.join('\n')+
    '\n\n要把改动写回该日历吗？只修改这一条，不会删除任何日程。', '写回');
  if(!go) return;
  try{
    await CalBridge.ensurePermission();
    await CalBridge.editSystemEvent(after, evStartMs(before));
    toast('已写回系统日历「'+cal+'」');
  }catch(e){ toast('写回原日历失败：'+e.message); }
}

/* ---------- 系统日历导入 / 回写 ---------- */
function fillImportOwner(){
  const sel=$('#importOwner'); sel.innerHTML='';
  const data=Store.get(state.code); if(!data) return;
  Object.keys(data.members).forEach(id=>{
    if(data.members[id].out) return; // 已退出的成员不再作为归属选项
    const o=document.createElement('option'); o.value=id;
    o.textContent=data.members[id].name+(Store.owns(id,data)?'（我）':''); sel.appendChild(o);
  });
  sel.value=Store.resolve(data,myId());
  if(sel.selectedIndex<0 && sel.options.length) sel.selectedIndex=0; // 自己还没进成员表时给个默认
}
$('#importBtn').onclick=()=>{ if(!state.code) return toast('请先进入一个空间'); fillImportOwner(); resetImportGroups(); $('#permBtn').hidden=true; $('#harCalTip').hidden=!CalBridge.isHarmony(); $('#importModal').hidden=false; };
$('#importCancel').onclick=()=>{ $('#importModal').hidden=true; };
$('#permBtn').onclick=()=>CalBridge.openSettings();
/* 读不到日程时，把原生侧报来的「扫了哪些日历、各读到几条、哪个报错」摊开说，省得猜真机现场 */
function importEmptyMsg(r){
  const cals=(r.debug?.calendars||[]).map((c)=> c.error ? `${c.name}：读取出错 ${c.error}` : `${c.name}：${c.events} 条`).join('；');
  const dbg = r.debug ? `（扫了 ${r.debug.scanned} 个日历：${cals||'一个都没有'}）` : '';
  const head = r.raw ? `读到的 ${r.raw} 条都是本应用回写出去的日程，已跳过` : '系统日历中近一年没有可读到的日程';
  return head + dbg + (r.debug ? '。鸿蒙上应用只能读到本应用自己写的日程，可用弹窗里的「从 .ics 文件导入」' : '');
}
/* ---------- 按日历分组导入 ----------
   原生侧读系统日程时把每条所在日历的显示名/账户名一起报回来（calDisp/calAcct）。
   一次读取先摊成「一个日历一组」让人挑，导入时把分组名随日程存进空间文档：
   以后批量管理能按日历整组删，详情里也看得出一条是从哪个日历搬来的 */
let pendingSys=[]; const sysGroupSel=new Set();
function sysGroupOf(e){ return e.calDisp || e.calAcct || '未命名日历'; }
function sysGroups(evs){
  const m=new Map();
  evs.forEach(e=>{ const k=sysGroupOf(e); if(!m.has(k)) m.set(k,[]); m.get(k).push(e); });
  return [...m.entries()].sort((a,b)=>b[1].length-a[1].length);
}
function resetImportGroups(){ pendingSys=[]; sysGroupSel.clear(); $('#importGroups').classList.add('hidden'); }
function updateIgBar(){
  const gs=sysGroups(pendingSys);
  $('#igAll').checked = gs.length>0 && sysGroupSel.size===gs.length;
  const n=pendingSys.filter(e=>sysGroupSel.has(sysGroupOf(e))).length;
  const btn=$('#importSysSave');
  btn.textContent=`📥 导入所选日历（${n} 条）`; btn.disabled=!n;
  $('#igNote').textContent=`读到 ${pendingSys.length} 条，分布在 ${gs.length} 个日历里。同一条重复导入会自动跳过，先勾一个试试也不会写重。`;
}
function renderImportGroups(){
  const box=$('#igList'); box.innerHTML='';
  sysGroups(pendingSys).forEach(([name,list])=>{
    const row=document.createElement('label'); row.className='batch-row';
    const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=sysGroupSel.has(name);
    cb.onchange=()=>{ cb.checked?sysGroupSel.add(name):sysGroupSel.delete(name); updateIgBar(); };
    row.appendChild(cb);
    row.appendChild(el('span','batch-t',name));
    row.appendChild(el('span','ig-cnt',list.length+' 条'));
    box.appendChild(row);
  });
  $('#importGroups').classList.remove('hidden');
  updateIgBar();
}
$('#igAll').onchange=(ev)=>{
  sysGroupSel.clear();
  if(ev.target.checked) sysGroups(pendingSys).forEach(([name])=>sysGroupSel.add(name));
  $('#igList').querySelectorAll('input[type=checkbox]').forEach(cb=>{ cb.checked=ev.target.checked; });
  updateIgBar();
};
$('#sysImportBtn').onclick=async()=>{
  if(!state.code) return;
  try{
    await CalBridge.ensurePermission();
    toast('正在读取系统日历…');
    const now=Date.now(), YEAR=365*86400000;
    const r=await CalBridge.fetchEvents(now-YEAR, now+YEAR);
    if(!r.events.length){ resetImportGroups(); return toast(importEmptyMsg(r)); }
    pendingSys=r.events;
    sysGroups(pendingSys).forEach(([name])=>sysGroupSel.add(name)); // 默认全勾，减一个是一组
    renderImportGroups();
  }catch(e){ toast(e.message); if(e.needSettings) $('#permBtn').hidden=false; }
};
$('#importSysSave').onclick=async()=>{
  const chosen=pendingSys.filter(e=>sysGroupSel.has(sysGroupOf(e)));
  if(!chosen.length) return;
  const n=Store.addEvents(state.code, chosen, $('#importOwner').value||myId());
  /* 早先导入的同日历日程只存了 sourceUid（cal:日历id:事件id）、没存名字：
     这次读到的 id→名字 顺手补上去，批量管理时它们才不会和手工新建的挤在一组 */
  const map={};
  chosen.forEach(e=>{ const m=/^cal:(\d+):/.exec(e.sourceUid||''); if(m&&e.calDisp) map[m[1]]=e.calDisp; });
  const back=Store.tagSourceGroups(state.code, map);
  resetImportGroups(); $('#importModal').hidden=true;
  toast(n ? `已导入 ${n} 条系统日程${back?`，另外 ${back} 条旧日程补上了日历分组`:''}（重复的已自动跳过）`
    : '这些日历的日程之前都已导入过（分组名已补齐）');
};
$('#writeBackBtn').onclick=async()=>{
  if(!state.code) return;
  const data=Store.get(state.code); if(!data) return;
  const list=Object.keys(data.events).map(k=>data.events[k])
    .filter(e=>memberOn(e.ownerId) && e.type!=='work' && e.type!=='rest')
    /* 来自系统日历的条目不参与全量回写：它们只按逐条确认改回原日历，
       否则会被复制进本应用自己的日历，变成同一件事的两份 */
    .filter(e=>!CalBridge.sysHandle(e.sourceUid))
    /* 写进系统日历时注明是谁的日程，回读再导入时也能靠这行标记跳过自己的条目 */
    .map(e=>Object.assign({}, e, { ownerName:memberOf(data,e.ownerId).name }));
  if(!list.length) return toast('没有可回写的日程');
  try{
    await CalBridge.ensurePermission();
    const r=await CalBridge.writeBack(list);
    if(r && r.failed) toast(`已回写 ${r.upserted} 条，清理 ${r.removed} 条；${r.failed} 条失败：${r.error}`);
    else toast(`已回写系统日历：更新 ${r.upserted} 条，清理 ${r.removed} 条`);
    $('#importModal').hidden=true;
  }catch(e){ toast(e.message); if(e.needSettings) $('#permBtn').hidden=false; }
};
$('#importSave').onclick=async()=>{
  const f=$('#icsFile'); if(!f.files.length) return toast('请选择 .ics 文件');
  let text='';
  for(const file of f.files){ text += '\n' + await file.text(); }
  const parsed=IcsParser.parseICS(text);
  if(!parsed.length) return toast('未解析到日程');
  Store.addEvents(state.code, parsed, $('#importOwner').value);
  $('#importModal').hidden=true; toast(`导入 ${parsed.length} 条（循环日程存规则，不炸开）`);
};

/* ---------- 备份与找回：导出 .ics + 写回前的本机快照 ---------- */
/* blob 下载只有浏览器和桌面端可靠；安卓/鸿蒙的 WebView 点了不给存文件，
   那里改成把全文摊出来让人复制走 */
const canSaveFile=()=>isDesktopShell()||!(window.Capacitor||(window.CalBridge&&CalBridge.isHarmony()));
function icsFileName(name){
  const base=String(name||'space').replace(/[\\/:*?"<>|\s]+/g,'-').slice(0,40);
  return 'reunion-'+base+'.ics';
}
function saveTextAsFile(text,fileName){
  const a=el('a'); a.href=URL.createObjectURL(new Blob([text],{type:'text/calendar;charset=utf-8'}));
  a.download=fileName; document.body.appendChild(a); a.click();
  /* 立刻 revoke 的话 Firefox 和部分内核还没取走数据；留两秒足够它开始下载 */
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },2000);
}
$('#exportIcsBtn').onclick=()=>{
  if(!state.code) return toast('请先进入一个空间');
  const d=Store.get(state.code)||{events:{}};
  const evs=Object.keys(d.events||{}).map((k)=>d.events[k]);
  if(!evs.length) return toast('这个空间还没有日程');
  const text=IcsParser.buildICS(evs,{name:d.name||state.code});
  const fn=icsFileName(d.name||state.code);
  if(canSaveFile()){ saveTextAsFile(text,fn); return toast('已导出 '+fn+'（'+evs.length+' 条）'); }
  $('#exportTitle').textContent='导出 '+evs.length+' 条日程';
  $('#exportTip').textContent='这台设备的网页内核不让应用直接存文件：全选下面内容，粘贴进备忘录存成 '+fn+'，就能在别的日历里导入。';
  $('#exportText').value=text;
  $('#exportModal').hidden=false;
};
$('#exportClose').onclick=()=>{ $('#exportModal').hidden=true; };
$('#exportCopy').onclick=async()=>{
  try{ await navigator.clipboard.writeText($('#exportText').value); }
  catch(e){ $('#exportText').select(); document.execCommand('copy'); } // WebView 里 clipboard API 常不给（非安全上下文）
  toast('已复制，去备忘录粘贴保存');
};

function syncSnapUI(){
  $('#snapSw').checked=Store.snaps.enabled();
  $('#snapMax').textContent=Store.snaps.max;
  const mb=(Store.snaps.bytes()/1024/1024).toFixed(2);
  $('#snapStat').textContent=state.code?('；当前空间有 '+Store.snaps.list(state.code).length+' 份，本机一共占 '+mb+' MB。'):'';
}
$('#snapSw').onchange=(e)=>{
  Store.snaps.setEnabled(e.target.checked);
  syncSnapUI();
  toast(e.target.checked?'以后写回前会留快照':'已停止留快照，已有的那些还留着');
};
function snapTimeText(t){
  const d=new Date(t), p=(n)=>(''+n).padStart(2,'0');
  return (d.getMonth()+1)+'月'+d.getDate()+'日 '+p(d.getHours())+':'+p(d.getMinutes());
}
function renderSnapList(){
  const box=$('#snapList'); box.innerHTML='';
  const list=Store.snaps.list(state.code);
  if(!list.length){
    box.appendChild(el('p','import-tip',Store.snaps.enabled()?'这个空间还没有快照——本机没有待写入的改动时不会生成，下次改完日程同步就有了。':'留快照的开关现在是关的，先在设置里打开。'));
    return;
  }
  list.forEach((s)=>{
    let n=0;
    try{ n=Object.keys(JSON.parse(Store.snaps.text(state.code,s.t)).events||{}).length; }catch(e){ /* 坏了一行不影响别的能恢复 */ }
    const row=el('div','batch-row');
    row.appendChild(el('div','batch-t',snapTimeText(s.t)+' · '+n+' 条 · '+Math.round(s.bytes/1024)+' KB'));
    const btn=el('button','action-btn','恢复');
    btn.onclick=async()=>{
      if(!await uiConfirm('恢复这一版？','把这份快照里有、而现在不在了的日程补回来，并同步给空间里所有人。现在还在的日程不会被改。','恢复')) return;
      const back=Store.snaps.restore(state.code,s.t);
      toast(back?('已找回 '+back+' 条，稍后自动同步'):'这一版没有可找回的日程，都还在');
      renderSnapList(); syncSnapUI();
    };
    row.appendChild(btn);
    box.appendChild(row);
  });
}
$('#snapBtn').onclick=()=>{
  if(!state.code) return toast('请先进入一个空间');
  renderSnapList(); $('#snapModal').hidden=false;
};
$('#snapClose').onclick=()=>{ $('#snapModal').hidden=true; syncSnapUI(); };
$('#snapClear').onclick=async()=>{
  if(!await uiConfirm('清空本机快照','清空之后就找不回这些版本了。','清空')) return;
  Store.snaps.clear(state.code); renderSnapList(); syncSnapUI(); toast('已清空');
};

/* ---------- 聚合视图：全部空间的日程叠在一张月历上（只读） ----------
   只读本机缓存（Store.get），不触发同步、不动 state.code——同步逻辑一行不改 */
function allSpacesData(){
  return Store.listSpaces().map((s)=>({ code:s.code, name:s.name||'共享空间', data:Store.get(s.code) }))
    .filter((x)=>x.data && !x.data.dissolved);
}
function syncAllSegBtn(){
  const b=document.querySelector('#viewSeg [data-val="all"]');
  if(!b) return;
  b.classList.toggle('hidden', allSpacesData().length<2);
  if(allSpacesData().length<2 && state.view==='all'){ state.view='month'; localStorage.setItem(VIEW_KEY,'month'); }
}
function allOccurrences(fromStr,toStr){
  const byDay={};
  allSpacesData().forEach((sp)=>{
    Object.keys(sp.data.events).forEach((id)=>{
      const ev=sp.data.events[id];
      IcsParser.expandOccurrences(ev, fromStr, toStr).forEach((ds)=>{ (byDay[ds]=byDay[ds]||[]).push({ ev, sp }); });
    });
  });
  return byDay;
}
function renderAllMonth(cal){
  const first=new Date(state.year,state.month-1,1);
  const winFrom=new Date(first); winFrom.setDate(winFrom.getDate()-winFrom.getDay());
  const winTo=new Date(winFrom); winTo.setDate(winTo.getDate()+41);
  const byDay=allOccurrences(IcsParser.dstr(winFrom), IcsParser.dstr(winTo));
  const tStr=todayStr();
  const selIdx=Math.round((IcsParser.parseDate(state.day)-winFrom)/86400000);
  const selRow=Math.max(0,Math.min(5,Math.floor(selIdx/7)));
  for(let i=0;i<42;i++){
    const cd=new Date(winFrom); cd.setDate(winFrom.getDate()+i);
    const ds=IcsParser.dstr(cd);
    const cell=el('div','cell'+(cd.getMonth()!==state.month-1?' other':'')+(ds===tStr?' today':'')+(ds===state.day?' sel':''));
    if(Math.floor(i/7)===selRow) cell.classList.add('keep');
    cell.appendChild(el('div','date-num',String(cd.getDate())));
    const list=byDay[ds]||[];
    cellDecorate(cell, cd, ds, list.some((x)=>x.ev.type==='work'||x.ev.type==='rest'));
    if(list.length){
      const people=[]; const byId={};
      list.forEach(({ev,sp})=>{
        const oid=Store.resolve(sp.data,ev.ownerId);
        if(byId[oid+'|'+sp.code]){ byId[oid+'|'+sp.code].n++; return; }
        byId[oid+'|'+sp.code]={ id:oid, sp, n:1, color:(sp.data.members[oid]||{}).color||'var(--weak2)' };
        people.push(byId[oid+'|'+sp.code]);
      });
      const dots=el('div','dots');
      people.slice(0,4).forEach((p)=>{
        const d=el('span','mdot'+(p.n>1?' many':'')); d.style.background=p.color;
        d.title=((p.sp.data.members[p.id]||{}).name||'未知')+' · '+p.sp.name;
        dots.appendChild(d);
      });
      if(people.length>4) dots.appendChild(el('span','mdot more','+'+(people.length-4)));
      cell.appendChild(dots);
      if(list.length>1) cell.appendChild(el('div','cell-cnt',list.length+'条'));
      cell.title=list.map(({ev,sp})=>((sp.data.members[Store.resolve(sp.data,ev.ownerId)]||{}).name||'未知')+'（'+sp.name+'）· '+ev.title).join('\n');
    }
    cell.onclick=()=>{ state.day=ds; syncYm(); renderCalendar(); };
    cal.appendChild(cell);
  }
}
function renderAllAgenda(box){
  const ds=state.day, d=IcsParser.parseDate(ds);
  const list=(allOccurrences(ds,ds)[ds]||[]);
  const {marks,evs}=splitMarks(list.map((x)=>x.ev));
  box.className='agenda';
  const head=el('div','ag-head');
  head.appendChild(el('div','ag-date',`${d.getMonth()+1}月${d.getDate()}日 ${WD_ZH[d.getDay()]}`));
  head.appendChild(el('div','ag-sub',`全部空间 · ${evs.length} 条日程`));
  box.appendChild(head);
  if(!list.length) box.appendChild(el('p','ag-empty','这一天所有空间都没有日程。'));
  const cardOf=(e)=>{
    const it=list.find((x)=>x.ev===e); if(!it) return null;
    const card=evCard(it.sp.data, e, ds);
    const chip=el('span','badge ev-space',it.sp.name);
    card.querySelector('.ec-main').appendChild(chip);
    return card;
  };
  marks.forEach((e)=>{ const c=cardOf(e); if(c) box.appendChild(c); });
  evs.forEach((e)=>{ const c=cardOf(e); if(c) box.appendChild(c); });
  const cur=Store.get(state.code);
  const btn=el('button','big-btn ghost ag-new','＋ 在「'+((cur&&cur.name)||'当前空间')+'」新建日程');
  btn.onclick=()=>openEventModal(ds);
  box.appendChild(btn);
}

/* ---------- 共同空闲：选人 + 时段 → 大家都有空的档期 ---------- */
function freeSpaces(){
  if(state.view==='all'){
    return allSpacesData().map((sp)=>({ code:sp.code, name:sp.name, data:sp.data,
      members:Object.keys(sp.data.members).filter((id)=>!sp.data.members[id].out) }));
  }
  const data=state.code?Store.get(state.code):null;
  if(!data) return [];
  return [{ code:state.code, name:data.name||'共享空间', data,
    members:Object.keys(data.members).filter((id)=>!data.members[id].out) }];
}
function fmtDur(m){
  m=Number(m)||0;
  if(m>=60){ const h=Math.floor(m/60), r=m%60; return h+' 小时'+(r?' '+r+' 分':''); }
  return m+' 分钟';
}
function openFreeModal(){
  if(!state.code) return toast('请先进入一个空间');
  const box=$('#freeMembers'); box.innerHTML='';
  const spaces=freeSpaces();
  if(!spaces.length) return toast('还没有可用的空间数据');
  spaces.forEach((sp)=>{
    sp.members.forEach((id)=>{
      const m=sp.data.members[id]||{};
      const row=el('div','batch-row');
      const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=true;
      cb.dataset.key=sp.code+'|'+id;
      const dot=el('span','dot'); dot.style.background=m.color||'#999';
      row.appendChild(cb); row.appendChild(dot);
      const label=(sp.name||'')+(spaces.length>1?' · ':'')+ (m.name||'成员') + (Store.owns(id,sp.data)?'（我）':'');
      row.appendChild(el('span','batch-t',label));
      box.appendChild(row);
    });
  });
  const today=todayStr();
  const to=new Date(); to.setDate(to.getDate()+13);
  $('#freeFrom').value=today; $('#freeTo').value=IcsParser.dstr(to);
  $('#freeResults').innerHTML='<p class="import-tip">选好人、点「计算空档」。</p>';
  $('#freeModal').hidden=false;
}
$('#freeBtn').onclick=openFreeModal;
$('#freeRun').onclick=()=>{
  const sel=[...document.querySelectorAll('#freeMembers input:checked')].map((c)=>c.dataset.key.split('|'));
  if(!sel.length) return toast('至少选一个人');
  const from=$('#freeFrom').value||todayStr();
  const to=$('#freeTo').value||from;
  if(to<from) return toast('「到」要晚于「从」');
  const win=$('#freeWin').value.split('-').map(Number);
  const list=freeSpaces()
    .map((sp)=>({ data:sp.data, members:sel.filter(([c])=>c===sp.code).map(([,id])=>id) }))
    .filter((x)=>x.members.length);
  const r=FreeTime.slots(list,{ from, to, dayStart:win[0]*60, dayEnd:win[1]*60, minDur:Number($('#freeMin').value)||60 });
  const box=$('#freeResults'); box.innerHTML='';
  let n=0;
  r.forEach((day)=>{
    if(!day.slots.length) return;
    const d=IcsParser.parseDate(day.date);
    const hol=Holidays.get(day.date);
    const head=el('div','batch-group');
    head.appendChild(el('span','batch-t',`${d.getMonth()+1}月${d.getDate()}日 ${WD_ZH[d.getDay()]}${hol?' · '+hol.name+(hol.off?'（休）':'（班）'):''}`));
    box.appendChild(head);
    day.slots.forEach((s)=>{
      n++;
      const row=el('button','batch-row ft-slot'); row.type='button';
      row.appendChild(el('span','batch-t',`${s.s} – ${s.e}`));
      row.appendChild(el('span','ig-cnt','共 '+fmtDur(s.eMin-s.sMin)));
      row.onclick=()=>{
        $('#freeModal').hidden=true;
        state.day=day.date; syncYm(); renderCalendar(true);
        openEventModal(day.date, null, { start:s.s, end:s.e });
      };
      box.appendChild(row);
    });
  });
  if(!n) box.appendChild(el('p','import-tip','这个范围里没有共同空档——试试放宽时段、缩短最短时长，或少选几个人。'));
};
$('#freeClose').onclick=()=>{ $('#freeModal').hidden=true; };

/* ---------- 空间动态 ---------- */
$('#activityBtn').onclick=()=>{ renderActivity(); $('#activityModal').hidden=false; };
function renderActivity(){
  const box=$('#activityList'); box.innerHTML='';
  const feed=loadFeed().filter((f)=>!state.code||f.code===state.code);
  if(!feed.length){
    box.appendChild(el('p','import-tip','最近还没有变更记录。成员增删改日程、应答出勤之后，这里会出现一行行「谁做了什么」。'));
    return;
  }
  feed.slice(0,60).forEach((f)=>{
    const row=el('div','batch-row');
    const t=new Date(f.t);
    const hm=String(t.getHours()).padStart(2,'0')+':'+String(t.getMinutes()).padStart(2,'0');
    row.appendChild(el('span','act-time',`${t.getMonth()+1}月${t.getDate()}日 ${hm}`));
    row.appendChild(el('span','batch-t',diffText(f,f.code)));
    box.appendChild(row);
  });
}
$('#activityClose').onclick=()=>{ $('#activityModal').hidden=true; };
$('#activityClear').onclick=async()=>{
  if(!await uiConfirm('清空动态','只清本机的这份记录，日程数据不动。','清空')) return;
  saveFeed([]); renderActivity(); toast('已清空');
};

/* ---------- 节假日与农历（设置页） ---------- */
function syncHolidayUI(){
  const ys=Holidays.years();
  $('#holidayYears').textContent=ys.length?ys.map(String).join(' / '):'—';
  const cur=new Date().getFullYear();
  $('#holidaySrcNote').textContent='今年的数据来源：'+(Holidays.sourceLabel(cur)||'未收录（只显示周六日与手工班/休）');
}
$('#holidayRefreshBtn').onclick=async()=>{
  const btn=$('#holidayRefreshBtn');
  btn.disabled=true; const old=btn.textContent; btn.textContent='正在检查…';
  try{
    const r=await Holidays.refresh();
    toast(r.saved.length ? '已更新 '+r.saved.join('、')+' 年的节假日数据'
      : (r.failed.length ? '没有拿到新数据（离线，或来年的安排还没公布）' : '数据已是最新'));
    syncHolidayUI();
  } finally { btn.disabled=false; btn.textContent=old; }
};

/* ---------- 应用内更新：安卓/鸿蒙走原生插件，桌面端走 Tauri 下载 + 应用内弹层 ---------- */
let updInfo = null;
let updBusy = false;
const isDesktopShell = () => !!(window.Transport && Transport.isDesktop);
const AUTOUPD_KEY = 'tm:autoUpd';
const autoUpdOn = () => localStorage.getItem(AUTOUPD_KEY) !== '0'; // 默认开：不主动关的人就是想要它
function syncAutoUpd(){
  const row=$('#autoUpdRow'), sw=$('#autoUpdSw');
  if(!row||!sw) return;
  row.classList.toggle('hidden', !isDesktopShell());
  sw.checked = autoUpdOn();
}
$('#autoUpdSw').onchange=(e)=>{ localStorage.setItem(AUTOUPD_KEY, e.target.checked?'1':'0'); };

/* 弹层四态：ask 有新版 / dl 下载中 / done 包已就绪 / err 下载失败。
   下载跑在原生线程，所以「后台继续」只是收窗，进度照走 */
const UM = { mode:'', pct:0, text:'', title:'' };
const UM_TITLE = { ask:'发现新版本', dl:'正在下载更新', done:'更新包已就绪', err:'更新没有完成' };
const UM_BTN = { ask:['⬇ 立即下载新版','稍后再说'], dl:['✖ 取消下载','后台继续'], done:['📲 立即安装','稍后再说'], err:['🔄 重试下载','关闭'] };
function renderUpdModal(){
  if($('#updModal').hidden) return;
  $('#updModalTitle').textContent = UM.title || UM_TITLE[UM.mode] || '更新';
  const txt=$('#updModalText'); txt.textContent = UM.text; txt.hidden = !UM.text;
  $('#updModalBarWrap').hidden = UM.mode!=='dl';
  $('#updModalBar').style.width = UM.pct+'%';
  $('#updModalMain').textContent = UM_BTN[UM.mode][0];
  $('#updModalCancel').textContent = UM_BTN[UM.mode][1];
}
function showUpdModal(mode, text, title){
  UM.mode=mode; UM.text=text||''; UM.title=title||'';
  if(mode!=='dl') UM.pct = mode==='done' ? 100 : 0;
  $('#updModal').hidden=false; renderUpdModal();
}
function fmtMB(b){ return (Math.max(0,b)/1048576).toFixed(1)+' MB'; }
function onUpdProgress(p){
  const pct = p && p.percent!=null ? p.percent : (p && p.total ? Math.floor(p.received/p.total*100) : 0);
  UM.pct=pct;
  const line=`下载中 ${pct}%`+(p&&p.total?`（${fmtMB(p.received)} / ${fmtMB(p.total)}）`:'' );
  if(UM.mode==='dl'){ UM.text=line; renderUpdModal(); }
  $('#updState').textContent=line+'（可离开此页，不影响）';
}
async function startUpdateDownload(){
  if(!updInfo || !updInfo.url) return toast('没有可用的安装包');
  if(updBusy) return;
  updBusy=true; showUpdModal('dl','正在连接下载源…'); renderUpdate();
  try{
    const path = await Update.download(updInfo, onUpdProgress);
    Update.markReady(updInfo.latest, path);
    updBusy=false;
    showUpdModal('done', `v${updInfo.latest} 已下载完成（sha256 校验通过）。\n点「立即安装」即可覆盖升级。`);
  }catch(e){
    updBusy=false;
    const msg=(e && e.message) || '下载失败';
    if(/取消/.test(msg)){
      $('#updModal').hidden=true;
      $('#updState').textContent='已取消下载，可点「后台下载新版」重来';
      toast('已取消下载');
    }else{
      $('#updState').textContent='下载失败：'+msg;
      showUpdModal('err', msg+'\n换下载源再试一次，或到发布页手动下载。');
    }
  }finally{ renderUpdate(); }
}
async function runUpdateInstall(){
  const rdy = Update.ready();
  if(!rdy) return toast('还没有下载好的安装包');
  try{
    const note = await Update.install(rdy.path);
    if(note){ showUpdModal('done', note); toast('已打开安装包所在目录'); } // Linux：deb 要 root，只能把命令念给人
  }catch(e){ Update.clearReady(); toast(e.message); renderUpdate(); showUpdModal('ask','安装包已经不可用了，重新下载一份。'); }
}
$('#updModalMain').onclick=()=>{
  if(UM.mode==='dl'){ Update.cancelDownload().catch(()=>{}); $('#updState').textContent='正在取消…'; return; }
  if(UM.mode==='done') return runUpdateInstall();
  startUpdateDownload();
};
$('#updModalCancel').onclick=()=>{ $('#updModal').hidden=true; };

function renderUpdate(){
  const grp=$('#updGroup'); if(grp) grp.hidden = !Update.canDownload && !isDesktopShell();
  const dl=$('#updDlBtn'), ins=$('#updInstallBtn'), page=$('#updPageBtn'), note=$('#updNote');
  /* 这些按钮是用 .hidden 类藏起来的，切换必须走 classList——
     只改 el.hidden 属性的话类名还留在身上，按钮永远出不来（下载/安装入口就是这么丢的） */
  let rdy = Update.ready();
  if(rdy && (!updInfo || rdy.ver !== updInfo.latest)){ Update.clearReady(); rdy = null; } // 旧版残留的包不算就绪
  const canDl = Update.canDownload && updInfo && updInfo.hasUpdate && updInfo.url;
  dl.classList.toggle('hidden', !canDl || !!rdy || updBusy);
  ins.classList.toggle('hidden', !rdy);
  if(ins) ins.textContent = (isDesktopShell() && !Update.canAutoInstall) ? '📂 打开安装包目录' : '📲 立即安装';
  if(page) page.classList.toggle('hidden', !(isDesktopShell() && updInfo && updInfo.hasUpdate));
  note.hidden = !updInfo;
  if(updInfo){
    const lines=[];
    if(rdy) lines.push(isDesktopShell() && !Update.canAutoInstall
      ? `v${rdy.ver} 安装包已下载：${rdy.path}`
      : `v${rdy.ver} 安装包已下载完成，点「立即安装」即可覆盖升级`);
    else if(updInfo.hasUpdate) lines.push(`新版本 v${updInfo.latest}：${(updInfo.notes||'').replace(/\s+/g,' ').slice(0,120)}`);
    else lines.push(`已是最新版本 v${updInfo.latest}`);
    if(!Update.canDownload) lines.push('本平台不能自动安装，请到发布页下载：'+(updInfo.page||''));
    note.textContent=lines.join('\n');
  }
}
$('#updCheckBtn').onclick=async()=>{
  const st=$('#updState'); st.textContent='检查中…';
  try{
    updInfo = await Update.check(APP_VERSION);
    st.textContent = updInfo.hasUpdate ? `发现新版 v${updInfo.latest}` : `已是最新 v${APP_VERSION}`;
    if(updInfo.hasUpdate && !Update.canDownload) st.textContent += '（需手动安装）';
    renderUpdate();
    if(isDesktopShell() && updInfo.hasUpdate) showUpdModal(Update.ready()?'done':'ask',
      Update.ready() ? `v${updInfo.latest} 安装包已就绪，点「立即安装」即可覆盖升级。`
        : `当前 v${APP_VERSION} → 最新 v${updInfo.latest}\n${(updInfo.notes||'').replace(/\s+/g,' ').slice(0,160)}`);
  }catch(e){ st.textContent='检查失败'; toast(e.message); }
};
$('#updDlBtn').onclick=async()=>{
  if(isDesktopShell()) return startUpdateDownload();
  const st=$('#updState'), btn=$('#updDlBtn');
  if(!updInfo || !updInfo.url) return toast('没有可用的安装包');
  btn.disabled=true; st.textContent='后台下载 0%';
  try{
    const path = await Update.download(updInfo, (p)=>{
      const pct = p && p.percent != null ? p.percent : (p && p.total ? Math.floor(p.received/p.total*100) : 0);
      st.textContent = `下载中 ${pct}%（可退出此页，不影响）`;
    });
    Update.markReady(updInfo.latest, path);
    st.textContent = `v${updInfo.latest} 已下载完成`;
    toast('下载完成，点「立即安装」');
  }catch(e){ st.textContent='下载失败：'+e.message; }
  finally{ btn.disabled=false; renderUpdate(); }
};
$('#updInstallBtn').onclick=()=> isDesktopShell() ? runUpdateInstall()
  : (async()=>{ const rdy=Update.ready(); if(!rdy) return toast('还没有下载好的安装包');
     try{ await Update.install(rdy.path); toast('已交给系统安装'); }catch(e){ toast(e.message); } })();
$('#updPageBtn').onclick=()=>{
  const u = (updInfo && updInfo.page) || 'https://github.com/Kepler16f/timemaster/releases';
  if(window.Transport) Transport.openExternal(u);
};

/* 启动自动检查（仅桌面端、且设置里没关掉）：半天只悄悄问一次——
   GitHub 匿名限流 60 次/小时，反复开开关关不该把额度吃光；检查失败一律不打扰 */
const AUTO_SPAN = 12*3600*1000;
async function autoCheckUpdate(){
  if(!isDesktopShell() || !autoUpdOn()) return;
  if(Date.now() - Number(localStorage.getItem('tm:autoUpdAt')||0) < AUTO_SPAN) return;
  localStorage.setItem('tm:autoUpdAt', String(Date.now()));
  try{
    const info = await Update.check(APP_VERSION);
    updInfo = info; renderUpdate();
    if(!info.hasUpdate) return;
    const rdy = Update.ready();
    if(rdy && rdy.ver===info.latest) showUpdModal('done', `v${info.latest} 安装包已就绪，点「立即安装」即可覆盖升级。`);
    else showUpdModal('ask', `当前 v${APP_VERSION} → 最新 v${info.latest}\n${(info.notes||'').replace(/\s+/g,' ').slice(0,160)}`);
  }catch(e){ /* 自动检查失败保持安静，用户仍可在设置里手动检查 */ }
}

/* ---------- 视图导航 & FAB ---------- */
$('#myName').oninput=onNameInput;
$('#addBtn').onclick=()=>openEventModal(state.day);
function navStep(n){
  if(state.view==='month' || state.view==='all'){
    const d=IcsParser.parseDate(state.day), want=d.getDate();
    d.setDate(1); d.setMonth(d.getMonth()+n);
    d.setDate(Math.min(want, new Date(d.getFullYear(),d.getMonth()+1,0).getDate())); // 31 日翻到短月夹到月末
    state.day=IcsParser.dstr(d);
  }else{
    state.day=shiftDay(state.day, n*(state.view==='week'?7:1));
  }
  syncYm(); renderCalendar();
}
$('#prevBtn').onclick=()=>navStep(-1);
$('#nextBtn').onclick=()=>navStep(1);
$('#todayBtn').onclick=()=>{ state.day=todayStr(); syncYm(); renderCalendar(true); };

/* ---------- 启动：除首次安装外，直接回到最近一次进入的空间 ---------- */
async function boot(){
  applyTheme(); showDeviceId(); renderUpdate(); syncAutoUpd(); syncDayView(); syncAllSegBtn(); syncNotifySw();
  /* 桌面端系统日历对接暂缓：整组隐藏，别留一个点了只会报错的按钮 */
  if (isDesktopShell()) $('#calGroup').hidden = true;
  const last=localStorage.getItem('tm:lastSpace'), cfg=Dav.cfg();
  if(last && cfg && cfg.user && Store.get(last)){
    try{ await enterSpace(last); }catch(e){ initStart(); }
  }else initStart();
  adoptNativeDeviceId(8); // 鸿蒙桥可能晚于首屏才注入，重试等一会儿
  if(window.Auth && Auth.session()) Auth.refresh(); // 静默续期，失败保持现有会话
  autoCheckUpdate(); // 有新版弹一次，装好前的提醒就靠它
}
boot();
