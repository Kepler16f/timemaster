/* ===== Reunion · 前端主逻辑（数据层：Store/Dav，无服务器依赖） ===== */
'use strict';

const PALETTE = ['#FF6B6B','#4ECDC4','#5B8FF9','#F6BD16','#9270CA','#73D13D','#FF9C6E','#36CFC9'];
const APP_VERSION = '0.2.5';
const VIEW_KEY = 'tm:view';
const WEEK_FIT_KEY = 'tm:weekFit'; // 周视图一屏四格（默认）还是收成一屏七格
const DAYVIEW_KEY = 'tm:dayView'; // 日视图开关，默认关（设置-外观里可打开）

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
  const btn = $('#viewSeg [data-val="day"]');
  if (btn) btn.classList.toggle('hidden', !on);
  const sw = $('#dayViewSw');
  if (sw) sw.checked = on;
  if (!on && state.view === 'day') { state.view = 'week'; localStorage.setItem(VIEW_KEY, 'week'); }
}
$('#dayViewSw').onchange = (e) => {
  state.dayView = e.target.checked;
  localStorage.setItem(DAYVIEW_KEY, e.target.checked ? '1' : '0');
  syncDayView();
  renderCalendar(true);
};
/* 鸿蒙 ArkWeb 里系统深色模式在应用切回前台时才保证同步过来，媒体查询事件不一定触发 */
document.addEventListener('visibilitychange', () => { if (!document.hidden) applyTheme(); });

function pad(n){ return String(n).padStart(2,'0'); }
function dateStr(y,m,d){ return `${y}-${pad(m)}-${pad(d)}`; }
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),1800); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function shade(hex,p){ const n=parseInt(hex.slice(1),16); let r=(n>>16)&255,g=(n>>8)&255,b=n&255; r=Math.max(0,Math.min(255,r+p)); g=Math.max(0,Math.min(255,g+p)); b=Math.max(0,Math.min(255,b+p)); return '#'+((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1); }
function genCode() { const b = new Uint8Array(4); crypto.getRandomValues(b); return Array.from(b, x=>x.toString(16).padStart(2,'0')).join('').toUpperCase(); }
function needDav(){ if(!Dav.cfg() || !Dav.cfg().user || !Dav.cfg().pass){ toast('请先在设置中配置网盘'); openSettings(); return false; } return true; }

function uiConfirm(title, text, yesText){
  return new Promise((res)=>{
    $('#confirmTitle').textContent=title; $('#confirmText').textContent=text; $('#confirmYes').textContent=yesText||'确认';
    $('#confirmModal').hidden=false;
    $('#confirmYes').onclick=()=>{ $('#confirmModal').hidden=true; res(true); };
    $('#confirmNo').onclick=()=>{ $('#confirmModal').hidden=true; res(false); };
  });
}

function showScreen(name){
  ['startScreen','calendarScreen','settingsScreen'].forEach(s=>$('#'+s).classList.add('hidden'));
  $('#'+name).classList.remove('hidden');
  $('#tabbar').classList.toggle('hidden', name==='startScreen');
  $('#tabRoom').classList.toggle('active', name==='calendarScreen');
  $('#tabSettings').classList.toggle('active', name==='settingsScreen');
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
  const last = localStorage.getItem('tm:lastSpace');
  $('#lastSpaceBox').classList.toggle('hidden', !last);
  $('#startHint').textContent = (Dav.cfg() && Dav.cfg().user) ? '' : '第一步：进入设置，配置坚果云 WebDAV 或粘贴家人的配置码';
  showScreen('startScreen');
}

$('#createBtn').onclick=()=>{ if(needDav()) openSpaceModal('create'); };
$('#joinBtn').onclick=()=>{ if(needDav()) openSpaceModal('join'); };
$('#enterLastBtn').onclick=()=>{ const c=localStorage.getItem('tm:lastSpace'); if(c && needDav()) enterSpace(c); };
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

/* ---------- 账户（登录即用，Supabase 配置已内置） ---------- */
function renderAccountSection(){
  const s = Auth.session();
  $('#acctLoggedOut').classList.toggle('hidden', !!s);
  $('#acctLoggedIn').classList.toggle('hidden', !s);
  if(s) $('#acctEmail').textContent = s.email||'已登录';
  else { $('#otpCodeWrap').classList.add('hidden'); $('#otpVerifyBtn').classList.add('hidden'); $('#otpCode').value=''; }
}
const OTP_RESEND_SEC=90;
const OTP_SEND_LABEL='📧 发送验证码';
let otpTimer=null;
function startOtpCountdown(btn){
  clearInterval(otpTimer);
  let left=OTP_RESEND_SEC;
  btn.disabled=true; btn.textContent=`📧 重新发送（${left}s）`;
  otpTimer=setInterval(()=>{
    left--;
    if(left<=0){ clearInterval(otpTimer); otpTimer=null; btn.disabled=false; btn.textContent=OTP_SEND_LABEL; }
    else btn.textContent=`📧 重新发送（${left}s）`;
  },1000);
}
$('#otpSendBtn').onclick=async()=>{
  const btn=$('#otpSendBtn');
  if(btn.disabled) return;
  const email=$('#loginEmail').value.trim();
  btn.disabled=true;
  try{
    await Auth.sendOtp(email);
    $('#otpCodeWrap').classList.remove('hidden'); $('#otpVerifyBtn').classList.remove('hidden');
    $('#otpCode').focus();
    toast('验证码已发到邮箱，请查收');
    startOtpCountdown(btn);
  }catch(e){ toast(e.message); btn.disabled=false; }
};
$('#otpVerifyBtn').onclick=async()=>{
  const btn=$('#otpVerifyBtn'); btn.disabled=true;
  try{
    const oldKey=myId();
    await Auth.verifyOtp($('#loginEmail').value, $('#otpCode').value);
    const newKey=myId();
    if(newKey!==oldKey) Store.migrateIdentity(oldKey, newKey); // 邮箱绑定到当前本地身份，而不是另建账户
    renderAccountSection(); renderSpaceMgmt();
    toast('登录成功，已将本机身份绑定到此邮箱');
    if(state.code && Store.get(state.code)){ Store.setProfile(state.code); renderPeopleTags(); renderCalendar(); }
  }catch(e){ toast(e.message); }
  finally{ btn.disabled=false; }
};
$('#logoutBtn').onclick=()=>{
  const oldKey=myId();
  Auth.clear();
  const newKey=myId();
  if(newKey!==oldKey) Store.migrateIdentity(oldKey, newKey); // 退出后并回本机身份，别在空间里留下第二个账号
  renderAccountSection(); toast('已退出，回到本机身份');
  if(state.code && Store.get(state.code)){ Store.setProfile(state.code); renderPeopleTags(); renderCalendar(); }
};

/* 配置码 B/C 共存：手动表单 = 方式B；配置码 = 方式C 一步导入 */
$('#cfgImportBtn').onclick=()=>{ $('#cfgImportText').value=''; $('#cfgImportModal').hidden=false; };
$('#cfgImportCancel').onclick=()=>{ $('#cfgImportModal').hidden=true; };
$('#cfgImportSave').onclick=async()=>{
  try{
    const r = Dav.importCode($('#cfgImportText').value);
    $('#cfgImportModal').hidden=true; toast('配置码已导入，正在测试连接…');
    try{
      await Dav.test();
      if(r.spaceCode){ await joinSpace(r.spaceCode); }
      else { toast('该配置码没带房间，请在首页创建或用邀请码加入'); $('#settingsBack').onclick(); }
    }catch(e){ toast(e.message); }
  }catch(e){ toast(e.message); }
};
$('#cfgExportBtn').onclick=()=>{
  try{
    const sc = state.code || localStorage.getItem('tm:lastSpace') || '';
    $('#cfgExportText').value = Dav.exportCode(sc);
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
  if(!needDav()) return;
  /* 加入不再自己 PUT 整篇文档：先合并进本机缓存，写回交给 syncCode（它在覆盖前会重新拉全量合并），
     否则后来的人会把前一个人刚写进去的成员/日程一起盖掉 */
  const { data, etag } = await Store.openRemote(code);
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
    item.innerHTML=`<div class="si-top">
        <div class="si-name">${escapeHtml(s.name||'共享空间')}</div>
        ${s.code===state.code?'<span class="si-now">使用中</span>':''}
      </div>
      <div class="si-meta">${s.code} · ${data?Object.keys(data.members).length:0} 人${st.lastSync?' · '+new Date(st.lastSync).toLocaleTimeString():''}</div>`;
    if(onClick) item.onclick=()=>onClick(s);
    else {
      /* 整张卡片可点：新建/加入空间后在设置里点一下就切过去 */
      item.onclick=()=>{ if(s.code!==state.code && needDav()) enterSpace(s.code); };
      const btns=document.createElement('div'); btns.className='si-btns'; item.appendChild(btns);
      const clr=document.createElement('button'); clr.className='si-btn'; clr.textContent='☁ 清空'; clr.title='清空该空间在网盘上的数据';
      clr.onclick=(ev2)=>{ ev2.stopPropagation(); openClearModal(s.code, s.name||s.code); };
      const out=document.createElement('button'); out.className='si-btn danger'; out.textContent='移除';
      out.onclick=async(ev2)=>{
        ev2.stopPropagation();
        if(!await uiConfirm('移除空间',`从本机移除「${s.name||s.code}」？网盘数据不会被删除，重新输入邀请码即可回来。`,'移除')) return;
        Store.removeSpace(s.code);
        if(state.code===s.code) initStart(); else renderSpaceMgmt();
      };
      btns.appendChild(clr); btns.appendChild(out);
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
}
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
$('#batchBtn').onclick=()=>{
  if(!state.code || !Store.get(state.code)) return toast('请先进入一个空间');
  renderBatch(); $('#batchModal').hidden=false;
};
function renderBatch(){
  const data=Store.get(state.code);
  batchIds=Object.keys(data.events).map(k=>data.events[k]).filter(e=>Store.owns(e.ownerId,data))
    .sort((a,b)=>a.date.localeCompare(b.date)||String(a.start||'').localeCompare(String(b.start||'')))
    .map(e=>e.id);
  batchSel.clear();
  const box=$('#batchList'); box.innerHTML='';
  if(!batchIds.length) box.innerHTML='<p class="set-note">这里还没有你自己创建的日程（导入的系统日程看归属标签）。</p>';
  const idSet=new Set(batchIds);
  batchIds.forEach(id=>{
    const e=data.events[id];
    const row=document.createElement('label'); row.className='batch-row';
    const cb=document.createElement('input'); cb.type='checkbox';
    cb.onchange=()=>{ cb.checked?batchSel.add(id):batchSel.delete(id); updateBatchBar(idSet); };
    const span=document.createElement('span'); span.className='batch-t';
    span.textContent=`${e.date}${e.start?' '+e.start:''} · ${e.title}`;
    row.appendChild(cb); row.appendChild(span); box.appendChild(row);
  });
  updateBatchBar(idSet);
}
function updateBatchBar(idSet){
  $('#batchDel').textContent=`删除所选（${batchSel.size}）`;
  $('#batchDel').disabled=!batchSel.size;
  const total=(idSet||new Set(batchIds)).size;
  $('#batchAll').checked = total>0 && batchSel.size===total;
}
$('#batchAll').onchange=(ev)=>{
  const on=ev.target.checked;
  $('#batchList').querySelectorAll('input[type=checkbox]').forEach(cb=>{ cb.checked=on; });
  batchSel.clear(); if(on) batchIds.forEach(id=>batchSel.add(id));
  updateBatchBar();
};
$('#batchClose').onclick=()=>{ $('#batchModal').hidden=true; };
$('#batchDel').onclick=async()=>{
  if(!batchSel.size) return;
  if(!await uiConfirm('批量删除日程',`将删除所选 ${batchSel.size} 条日程，并同步给空间所有成员。`,'删除')) return;
  const n=Store.deleteEvents(state.code,[...batchSel]);
  $('#batchModal').hidden=true;
  toast(n?`已删除 ${n} 条日程`:'没有可删除的日程（仅能删除自己创建的）');
};

/* ---------- 清空云端空间数据 ---------- */
let clearTarget=null;
function openClearModal(code,name){
  clearTarget=code;
  $('#clearSpaceName').textContent=name;
  $('#clearAlsoLocal').checked=false;
  $('#clearModal').hidden=false;
}
$('#clearCancel').onclick=()=>{ $('#clearModal').hidden=true; };
$('#clearOk').onclick=async()=>{
  if(!clearTarget) return;
  const btn=$('#clearOk'); btn.disabled=true;
  try{
    if(needDav()){
      await Dav.remove(clearTarget);
      const alsoLocal=$('#clearAlsoLocal').checked;
      if(alsoLocal){
        Store.removeSpace(clearTarget);
        if(state.code===clearTarget) initStart(); else renderSpaceMgmt();
        toast('云端与本机数据均已清空');
      } else {
        toast('云端数据已清空；本机数据保留，下次同步将以本机重建云端');
      }
    }
    $('#clearModal').hidden=true;
  }catch(e){ toast(e.message); }
  finally{ btn.disabled=false; }
};

/* ---------- 进入空间 ---------- */
async function enterSpace(code){
  state.code=code;
  localStorage.setItem('tm:lastSpace', code); // 下次冷启动直接回到这个空间
  state.day=todayStr(); syncYm();
  let data = Store.get(code), etag;
  if(!data){ const remote = await Store.openRemote(code); data = remote.data; etag = remote.etag; }
  await Store.attach(code, data, etag);
  Store.ensureMember(code); /* 被别人用旧版本覆盖掉时，回到空间就先把自己补回成员表 */
  Store.dedupe(code);
  $('#spaceName').textContent=data.name||'共享日程';
  $('#codeText').textContent=code;
  renderPeopleTags();
  showScreen('calendarScreen'); /* 必须先显示：藏在 display:none 里量不到格子宽度，周视图的「今天置左」会算成 0 */
  renderCalendar(true); updateSyncChip();
  Store.syncCode(code);
  startPolling();
}
function startPolling(){
  stopPolling();
  state.pollTimer=setInterval(()=>{ if(state.code && document.visibilityState==='visible') Store.syncCode(state.code).then(updateSyncChip); },60000);
}
function stopPolling(){ if(state.pollTimer){ clearInterval(state.pollTimer); state.pollTimer=null; } }
document.addEventListener('visibilitychange',()=>{ if(!document.hidden && state.code) Store.syncCode(state.code).then(updateSyncChip); });
Store.onChange((code)=>{ if(code===state.code){
  renderPeopleTags(); renderCalendar(); updateSyncChip();
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
  el.textContent = s.syncing? '同步中…' : s.dirty? '待同步（离线可写）' : s.lastSync? '已同步 '+new Date(s.lastSync).toLocaleTimeString() : '';
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
    if(!memberOn(ev.ownerId) || !data.members[ev.ownerId]) return;
    IcsParser.expandOccurrences(ev, fromStr, toStr).forEach(ds=>{ (byDay[ds]=byDay[ds]||[]).push(ev); });
  });
  return byDay;
}
function splitMarks(list){
  return { marks:list.filter(e=>e.type==='work'||e.type==='rest'),
           evs:list.filter(e=>e.type!=='work'&&e.type!=='rest').sort(sortByTime) };
}

function renderCalendar(fresh){
  const data=Store.get(state.code); if(!data) return;
  const cal=$('#calendar'), ag=$('#agenda');
  document.querySelectorAll('#viewSeg .seg-btn').forEach((b)=>b.classList.toggle('active', b.dataset.val===state.view));
  cal.innerHTML=''; ag.innerHTML='';
  $('#calMain').classList.toggle('with-agenda', state.view==='month');
  $('#calMain').classList.toggle('tgrid-mode', state.view!=='month');
  $('#addBtn').hidden = state.view==='month'; // 月视图用列表底部的「新建日程」，悬浮按钮不再压住内容
  $('#monthToggle').classList.toggle('hidden', state.view!=='month' || window.innerWidth>=600);
  if(fresh===true) state.monthCollapsed=false; // 切视图/换空间时回到展开态
  if(state.view==='month'){
    $('#weekHeader').hidden=false;
    cal.className='calendar month'+(state.monthCollapsed?' collapsed':'');
    renderMonth(data, cal);
    renderAgenda(data, ag);
  }else{
    $('#weekHeader').hidden=true;
    renderTimeGrid(data, cal, state.view==='week'?weekDays(state.day):[state.day], fresh);
  }
  $('#monthToggle').textContent = state.monthCollapsed ? '⌄' : '⌃';
  $('#monthTitle').innerHTML = state.view==='month'
    ? escapeHtml(`${state.year}年${state.month}月`)
    : (state.view==='week'
        /* 区间太长会被顶栏挤断行，干脆自己拆：第一个日期和 – 一行，第二个日期一行 */
        ? (()=>{ const a=IcsParser.parseDate(weekDays(state.day)[0]), b=IcsParser.parseDate(weekDays(state.day)[6]);
                 return `${escapeHtml(`${a.getMonth()+1}月${a.getDate()}日 –`)}<span class="l2">${escapeHtml(`${b.getMonth()+1}月${b.getDate()}日`)}</span>`; })()
        : (()=>{ const d=IcsParser.parseDate(state.day); return escapeHtml(`${d.getMonth()+1}月${d.getDate()}日 ${WD_ZH[d.getDay()]}`); })());
}

/* ---------- 月视图：格子只放日期与成员色块，整月一屏 ---------- */
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
    if(marks.length){ const dm=el('div','daymark '+marks[0].type, marks[0].type==='work'?'班':'休'); cell.appendChild(dm); }
    if(evs.length){
      const colors=[]; const seen={};
      evs.forEach((e)=>{ const c=data.members[e.ownerId].color; if(!seen[c]){ seen[c]=1; colors.push(c); } });
      const dots=el('div','dots');
      colors.slice(0,4).forEach((c)=>{ const d=el('span','mdot'); d.style.background=c; dots.appendChild(d); });
      if(evs.length>4) dots.appendChild(el('span','mdot more','+'+(evs.length-4)));
      cell.appendChild(dots);
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
    const m=data.members[id]||{name:'未知',color:'#999'};
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
  const owner=data.members[e.ownerId]||{name:'未知',color:'#999'};
  const card=el('div','ev-card');
  card.style.borderLeftColor=owner.color;
  const time=e.type!=='normal' ? (e.type==='work'?'上班':'休息') : (isAllDay(e)?'全天':`${e.start}${e.end?'–'+e.end:''}`);
  card.appendChild(el('span','ec-time',time));
  const main=el('div','ec-main');
  main.appendChild(el('div','ec-title', e.type==='normal'?e.title:(e.title+'（'+(e.type==='work'?'班':'休')+'）')));
  const meta=[];
  meta.push(owner.name+(Store.owns(e.ownerId,data)?'（我）':''));
  if(e.rrule) meta.push(REPEAT_ZH[(e.rrule.freq||'').toUpperCase()]||'重复');
  if(e.location) meta.push(e.location);
  if(e.desc) meta.push(e.desc);
  main.appendChild(el('div','ec-meta',meta.join(' · ')));
  card.appendChild(main);
  card.onclick=()=>openDetail(e, data, ds);
  return card;
}

/* ---------- 日 / 周视图：时间轴网格，重叠日程分栏，当前时间红线 ---------- */
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
    } else {
      c.appendChild(el('div',null,WD_ZH[d.getDay()]));
      c.appendChild(el('div','dnum',String(d.getDate())));
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
      const m=data.members[e.ownerId]||{color:'#999'};
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
  const e=it.e, m=data.members[e.ownerId]||{name:'未知',color:'#999'};
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
  state.monthCollapsed=v;
  renderCalendar();
}
$('#monthToggle').onclick=()=>setMonthCollapsed(!state.monthCollapsed);
let mSwipe=null;
$('#calMain').addEventListener('touchstart',(e)=>{
  if(state.view!=='month' || window.innerWidth>=600 || e.touches.length!==1) { mSwipe=null; return; }
  mSwipe={ y:e.touches[0].clientY, x:e.touches[0].clientX, top:$('#calMain').scrollTop };
},{passive:true});
$('#calMain').addEventListener('touchend',(e)=>{
  if(!mSwipe) return;
  const t=e.changedTouches[0], dy=t.clientY-mSwipe.y, dx=t.clientX-mSwipe.x;
  /* 只在明显竖向滑动时判断，避免和横翻月份/滚动列表抢手势 */
  if(Math.abs(dy)>48 && Math.abs(dy)>Math.abs(dx)*1.5) setMonthCollapsed(dy<0);
  mSwipe=null;
},{passive:true});

setInterval(()=>{ // 时间红线自己走，不必整页重绘
  const n=new Date(), hm=pad(n.getHours())+':'+pad(n.getMinutes());
  const pct=(n.getHours()*60+n.getMinutes())/1440*100;
  document.querySelectorAll('.tg-now').forEach((el2)=>{ el2.style.top=pct+'%'; });
  document.querySelectorAll('.tg-rnown').forEach((el2)=>{ el2.style.top=pct+'%'; el2.textContent=hm; });
},60000);

/* ---------- 日程详情 ---------- */
let detailEvent=null, detailDate=null;
function openDetail(ev, data, ds){
  detailEvent=ev; detailDate=ds||ev.date;
  const owner=data.members[ev.ownerId]||{name:'未知',color:'#999'};
  $('#detailDot').style.background=owner.color;
  $('#detailTitle').textContent=ev.title;
  const lines=[];
  const mine=Store.owns(ev.ownerId,data);
  lines.push(`成员：${owner.name}${mine?'（我）':''}`);
  lines.push(`日期：${detailDate}${detailDate!==ev.date?'（原起于 '+ev.date+'）':''}${ev.endDate?' → '+ev.endDate:''}`);
  if(!ev.allDay && ev.start) lines.push(`时间：${ev.start}${ev.end?' – '+ev.end:''}`);
  if(ev.allDay || !ev.start) lines.push('全天');
  if(ev.rrule) lines.push(`重复：${REPEAT_ZH[(ev.rrule.freq||'').toUpperCase()]||ev.rrule.freq}`);
  if(ev.type==='work'||ev.type==='rest') lines.push(`类型：${ev.type==='work'?'班（调休上班）':'休（放假）'}`);
  if(ev.location) lines.push(`地点：${ev.location}`);
  if(ev.desc) lines.push(`备注：${ev.desc}`);
  $('#detailMeta').innerHTML=lines.map(l=>`<div class="dm-row">${escapeHtml(l)}</div>`).join('');
  $('#detailDelete').classList.toggle('hidden', !mine);
  $('#detailEdit').classList.toggle('hidden', !mine);
  $('#detailLockNote').classList.toggle('hidden', mine);
  $('#detailModal').hidden=false;
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
  if(Store.deleteEvent(state.code, detailEvent.id)){ $('#detailModal').hidden=true; toast('已删除'); }
  else toast('只有创建者可以删除这条日程');
};

/* ---------- 新建 / 编辑日程 ---------- */
let editingEvent=null;
function openEventModal(presetDate,ev){
  editingEvent=ev||null;
  $('#eventModalTitle').textContent=ev?'编辑日程':'新建日程（归属于我）';
  $('#evTitle').value=ev?ev.title:'';
  $('#evDate').value=(ev?ev.date:null)||presetDate||state.day||todayStr();
  $('#evAllDay').checked=ev?!!ev.allDay:false;
  $('#timeRow').style.display=$('#evAllDay').checked?'none':'flex';
  $('#evStart').value=(ev&&ev.start)||'09:00'; $('#evEnd').value=(ev&&ev.end)||'10:00';
  $('#evType').value=(ev&&ev.type)||'normal'; $('#evDesc').value=(ev&&ev.desc)||'';
  $('#evLocation').value=(ev&&ev.location)||'';
  $('#evRepeat').value=ev&&ev.rrule?(String(ev.rrule.freq||'none').toLowerCase()):'none';
  $('#eventModal').hidden=false;
}
$('#eventCancel').onclick=()=>{ $('#eventModal').hidden=true; editingEvent=null; };
$('#evAllDay').onchange=(e)=>{ $('#timeRow').style.display=e.target.checked?'none':'flex'; };
$('#eventSave').onclick=async()=>{
  const date=$('#evDate').value; if(!date) return toast('请选择日期');
  const allDay=$('#evAllDay').checked;
  const rep=$('#evRepeat').value;
  const ev={
    title:$('#evTitle').value.trim()||'未命名日程', date,
    allDay, start:allDay?'':$('#evStart').value,
    end:allDay?'':$('#evEnd').value, type:$('#evType').value, desc:$('#evDesc').value,
    location:$('#evLocation').value.trim(),
    rrule: rep!=='none' ? { freq:rep.toUpperCase(), interval:1, byDay:null, byMonthDay:null, count:null, until:null } : null,
  };
  if(allDay) ev.endDate=null;
  let ok=true;
  if(editingEvent){
    if(date!==editingEvent.date) ev.endDate=null; // 改了日期，原来的多天区间不再成立
    ok=Store.updateEvent(state.code, editingEvent.id, ev);
  } else {
    Store.addEvent(state.code, ev);
  }
  state.day=date; syncYm();
  editingEvent=null;
  $('#eventModal').hidden=true; toast(ok?'已保存，稍后自动同步':'只有创建者可以编辑这条日程');
};

/* ---------- 系统日历导入 / 回写 ---------- */
function fillImportOwner(){
  const sel=$('#importOwner'); sel.innerHTML='';
  const data=Store.get(state.code); if(!data) return;
  Object.keys(data.members).forEach(id=>{
    const o=document.createElement('option'); o.value=id;
    o.textContent=data.members[id].name+(id===myId()?'（我）':''); sel.appendChild(o);
  });
  sel.value=myId();
}
$('#importBtn').onclick=()=>{ if(!state.code) return toast('请先进入一个空间'); fillImportOwner(); $('#permBtn').hidden=true; $('#importModal').hidden=false; };
$('#importCancel').onclick=()=>{ $('#importModal').hidden=true; };
$('#permBtn').onclick=()=>CalBridge.openSettings();
$('#sysImportBtn').onclick=async()=>{
  if(!state.code) return;
  try{
    await CalBridge.ensurePermission();
    toast('正在读取系统日历…');
    const now=Date.now(), YEAR=365*86400000;
    const list=await CalBridge.fetchEvents(now-YEAR, now+YEAR);
    if(!list.length) return toast('系统日历中近一年没有日程');
    const n=Store.addEvents(state.code, list, $('#importOwner').value||myId());
    toast(n ? `已导入 ${n} 条系统日程（重复的已自动跳过）` : '没有新日程，之前都已导入过');
    $('#importModal').hidden=true;
  }catch(e){ toast(e.message); if(e.needSettings) $('#permBtn').hidden=false; }
};
$('#writeBackBtn').onclick=async()=>{
  if(!state.code) return;
  const data=Store.get(state.code); if(!data) return;
  const list=Object.keys(data.events).map(k=>data.events[k])
    .filter(e=>memberOn(e.ownerId) && e.type!=='work' && e.type!=='rest')
    /* 写进系统日历时注明是谁的日程，回读再导入时也能靠这行标记跳过自己的条目 */
    .map(e=>Object.assign({}, e, { ownerName:(data.members[e.ownerId]||{}).name||'' }));
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

/* ---------- 应用内更新（仅安卓壳；鸿蒙 HAP 不能自装，整组隐藏） ---------- */
let updInfo = null;
function renderUpdate(){
  const grp=$('#updGroup'); if(grp) grp.hidden = !Update.canAutoInstall;
  const dl=$('#updDlBtn'), ins=$('#updInstallBtn'), note=$('#updNote');
  /* 这两个按钮是用 .hidden 类藏起来的，切换必须走 classList——
     只改 el.hidden 属性的话类名还留在身上，按钮永远出不来（下载/安装入口就是这么丢的） */
  let rdy = Update.ready();
  if(rdy && (!updInfo || rdy.ver !== updInfo.latest)){ Update.clearReady(); rdy = null; } // 旧版残留的包不算就绪
  dl.classList.toggle('hidden', !(updInfo && updInfo.hasUpdate && updInfo.url) || !!rdy);
  ins.classList.toggle('hidden', !(rdy && Update.canAutoInstall));
  note.hidden = !updInfo;
  if(updInfo){
    const lines=[];
    if(rdy) lines.push(`v${rdy.ver} 安装包已下载完成，点「立即安装」即可覆盖升级`);
    else if(updInfo.hasUpdate) lines.push(`新版本 v${updInfo.latest}：${(updInfo.notes||'').replace(/\s+/g,' ').slice(0,120)}`);
    else lines.push(`已是最新版本 v${updInfo.latest}`);
    if(!Update.canAutoInstall) lines.push('本平台不能自动安装，请到发布页下载：'+(updInfo.page||''));
    note.textContent=lines.join('\n');
  }
}
$('#updCheckBtn').onclick=async()=>{
  const st=$('#updState'); st.textContent='检查中…';
  try{
    updInfo = await Update.check(APP_VERSION);
    st.textContent = updInfo.hasUpdate ? `发现新版 v${updInfo.latest}` : `已是最新 v${APP_VERSION}`;
    if(updInfo.hasUpdate && !Update.canAutoInstall) st.textContent += '（需手动安装）';
    renderUpdate();
  }catch(e){ st.textContent='检查失败'; toast(e.message); }
};
$('#updDlBtn').onclick=async()=>{
  const st=$('#updState'), btn=$('#updDlBtn');
  if(!updInfo || !updInfo.url) return toast('没有可用的安装包');
  btn.disabled=true; st.textContent='后台下载 0%';
  try{
    const path = await Update.download(updInfo.url, (p)=>{
      const pct = p && p.percent != null ? p.percent : (p && p.total ? Math.floor(p.received/p.total*100) : 0);
      st.textContent = `下载中 ${pct}%（可退出此页，不影响）`;
    });
    Update.markReady(updInfo.latest, path);
    st.textContent = `v${updInfo.latest} 已下载完成`;
    toast('下载完成，点「立即安装」');
  }catch(e){ st.textContent='下载失败：'+e.message; }
  finally{ btn.disabled=false; renderUpdate(); }
};
$('#updInstallBtn').onclick=async()=>{
  const rdy = Update.ready();
  if(!rdy) return toast('还没有下载好的安装包');
  try{ await Update.install(rdy.path); toast('已交给系统安装'); }
  catch(e){ toast(e.message); }
};

/* ---------- 视图导航 & FAB ---------- */
$('#myName').oninput=onNameInput;
$('#addBtn').onclick=()=>openEventModal(state.day);
function navStep(n){
  if(state.view==='month'){
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
  applyTheme(); showDeviceId(); renderUpdate(); syncDayView();
  const last=localStorage.getItem('tm:lastSpace'), cfg=Dav.cfg();
  if(last && cfg && cfg.user && Store.get(last)){
    try{ await enterSpace(last); }catch(e){ initStart(); }
  }else initStart();
  adoptNativeDeviceId(8); // 鸿蒙桥可能晚于首屏才注入，重试等一会儿
  if(window.Auth && Auth.session()) Auth.refresh(); // 静默续期，失败保持现有会话
}
boot();
