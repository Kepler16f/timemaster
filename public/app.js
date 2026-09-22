/* ===== Reunion · 前端主逻辑（数据层：Store/Dav，无服务器依赖） ===== */
'use strict';

const PALETTE = ['#FF6B6B','#4ECDC4','#5B8FF9','#F6BD16','#9270CA','#73D13D','#FF9C6E','#36CFC9'];
const APP_VERSION = '0.1.5';

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
  prevCode: null,
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  visible: {},
  spaceMode: 'create',
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

/* 键盘弹出时收起底栏：底栏是 fixed 定位，adjustResize 下会顶在键盘上方 */
const isEditable=(el)=>!!el&&(el.tagName==='INPUT'||el.tagName==='TEXTAREA')&&!el.readOnly;
document.addEventListener('focusin',(e)=>{ if(isEditable(e.target)) $('#tabbar').classList.add('kb-hide'); });
document.addEventListener('focusout',()=>{ setTimeout(()=>{ if(!isEditable(document.activeElement)) $('#tabbar').classList.remove('kb-hide'); },150); });

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
      await Dav.put(code, JSON.stringify(data), null);
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
  let { data, etag } = await Store.openRemote(code);
  if(data.members[myId()]) { toast('你已在该空间'); }
  else {
    Store.joinMember(data);
    let p = await Dav.put(code, JSON.stringify(data), etag);
    if(p.status===412){ // 并发加入：重拉合并再写一次
      const fresh = await Store.openRemote(code);
      Store.joinMember(fresh.data);
      p = await Dav.put(code, JSON.stringify(fresh.data), fresh.etag);
      if(p.status===412) throw new Error('空间正被修改，请稍后重试');
    }
  }
  Store.upsertSpaceMeta(code, data.name||'共享空间');
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
    item.innerHTML=`<div class="si-main">
        <div class="si-name">${escapeHtml(s.name||'共享空间')}${s.code===state.code?'<span class="si-now">使用中</span>':''}</div>
        <div class="si-meta">码 ${s.code} · ${data?Object.keys(data.members).length:0} 人${st.lastSync?' · '+new Date(st.lastSync).toLocaleTimeString():''}</div>
      </div>`;
    if(onClick) item.onclick=()=>onClick(s);
    else {
      const enter=document.createElement('button'); enter.className='si-btn'; enter.textContent='进入';
      enter.onclick=(ev2)=>{ ev2.stopPropagation(); if(needDav()) enterSpace(s.code); };
      const clr=document.createElement('button'); clr.className='si-btn'; clr.textContent='☁ 清空'; clr.title='清空该空间在网盘上的数据';
      clr.onclick=(ev2)=>{ ev2.stopPropagation(); openClearModal(s.code, s.name||s.code); };
      const out=document.createElement('button'); out.className='si-btn danger'; out.textContent='移除';
      out.onclick=async(ev2)=>{
        ev2.stopPropagation();
        if(!await uiConfirm('移除空间',`从本机移除「${s.name||s.code}」？网盘数据不会被删除，重新输入邀请码即可回来。`,'移除')) return;
        Store.removeSpace(s.code);
        if(state.code===s.code) initStart(); else renderSpaceMgmt();
      };
      item.appendChild(enter); item.appendChild(clr); item.appendChild(out);
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
$('#switchSpaceBtn').onclick=()=>{ spaceItems($('#switchList'), (s)=>{ $('#switchModal').hidden=true; enterSpace(s.code); }); $('#switchModal').hidden=false; };
$('#swSettings').onclick=()=>{ $('#switchModal').hidden=true; openSettings(); };
$('#swHome').onclick=()=>{
  $('#switchModal').hidden=true;
  const prev=state.prevCode || localStorage.getItem('tm:prevSpace');
  if(prev && prev!==state.code && Store.listSpaces().some(s=>s.code===prev) && needDav()){ enterSpace(prev); }
  else { state.code=null; state.prevCode=null; initStart(); }
};
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
  batchIds=Object.keys(data.events).map(k=>data.events[k]).filter(e=>e.ownerId===myId())
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
  if(state.code && state.code!==code){
    state.prevCode=state.code;
    localStorage.setItem('tm:prevSpace', state.code);
  }
  state.code=code;
  const data = Store.get(code) || (await Store.openRemote(code)).data;
  await Store.attach(code, data);
  Store.dedupe(code);
  $('#spaceName').textContent=data.name||'共享日程';
  $('#codeText').textContent=code;
  renderPeopleTags(); renderCalendar(); updateSyncChip();
  showScreen('calendarScreen');
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
    tag.innerHTML=`<span class="dot" style="background:${m.color}"></span>${escapeHtml(m.name)}${id===myId()?'（我）':''}`;
    tag.onclick=()=>{ state.visible[id]=!on; renderPeopleTags(); renderCalendar(); };
    wrap.appendChild(tag);
  });
}

/* ---------- 月视图（渲染期按 RRULE 展开，数据里只存规则） ---------- */
const REPEAT_ZH = { DAILY:'每天', WEEKLY:'每周', MONTHLY:'每月', YEARLY:'每年' };
function renderCalendar(){
  const data=Store.get(state.code); if(!data) return;
  $('#monthTitle').textContent=`${state.year}年${state.month}月`;
  const cal=$('#calendar'); cal.innerHTML='';
  const first=new Date(state.year,state.month-1,1);
  const startWeekday=first.getDay();
  const today=new Date();
  const todayStr=dateStr(today.getFullYear(),today.getMonth()+1,today.getDate());

  const winFrom=new Date(first); winFrom.setDate(winFrom.getDate()-startWeekday);
  const winTo=new Date(winFrom); winTo.setDate(winTo.getDate()+41);
  const fromStr=dateStr(winFrom.getFullYear(),winFrom.getMonth()+1,winFrom.getDate());
  const toStr=dateStr(winTo.getFullYear(),winTo.getMonth()+1,winTo.getDate());

  const byDay={};
  Object.keys(data.events).forEach(id=>{
    const ev=data.events[id];
    if(!memberOn(ev.ownerId) || !data.members[ev.ownerId]) return;
    IcsParser.expandOccurrences(ev, fromStr, toStr).forEach(ds=>{ (byDay[ds]=byDay[ds]||[]).push(ev); });
  });

  for(let i=0;i<42;i++){
    const cellDate=new Date(winFrom); cellDate.setDate(winFrom.getDate()+i);
    const ds=dateStr(cellDate.getFullYear(),cellDate.getMonth()+1,cellDate.getDate());
    const cell=document.createElement('div'); cell.className='cell';
    if(cellDate.getMonth()!==state.month-1) cell.classList.add('other');
    if(ds===todayStr) cell.classList.add('today');
    const num=document.createElement('div'); num.className='date-num'; num.textContent=cellDate.getDate(); cell.appendChild(num);

    let dayEvents=(byDay[ds]||[]).sort((a,b)=>(a.start||'').localeCompare(b.start||''));
    const mark=dayEvents.find(e=>e.type==='work'||e.type==='rest');
    if(mark){ const dm=document.createElement('div'); dm.className='daymark '+mark.type; dm.textContent=mark.type==='work'?'班':'休'; cell.appendChild(dm); }
    dayEvents=dayEvents.filter(e=>e.type!=='work'&&e.type!=='rest');

    if(dayEvents.length){
      const box=document.createElement('div'); box.className='events';
      dayEvents.forEach(e=>{
        const chip=document.createElement('div'); chip.className='ev';
        const color=data.members[e.ownerId].color;
        chip.style.background=color; chip.style.borderLeftColor=shade(color,-25);
        const time=(!e.allDay&&e.start)?`<span class="ev-time">${e.start}</span>`:'';
        chip.innerHTML=`${time}${escapeHtml(e.title)}`;
        chip.onclick=(ev2)=>{ ev2.stopPropagation(); openDetail(e, data); };
        box.appendChild(chip);
      });
      cell.appendChild(box);
    }
    cell.onclick=()=>openEventModal(ds);
    cal.appendChild(cell);
  }
}

/* ---------- 日程详情 ---------- */
let detailEvent=null;
function openDetail(ev, data){
  detailEvent=ev;
  const owner=data.members[ev.ownerId]||{name:'未知',color:'#999'};
  $('#detailDot').style.background=owner.color;
  $('#detailTitle').textContent=ev.title;
  const lines=[];
  lines.push(`成员：${owner.name}${ev.ownerId===myId()?'（我）':''}`);
  lines.push(`日期：${ev.date}${ev.endDate?' → '+ev.endDate:''}`);
  if(!ev.allDay && ev.start) lines.push(`时间：${ev.start}${ev.end?' – '+ev.end:''}`);
  if(ev.allDay) lines.push('全天');
  if(ev.rrule) lines.push(`重复：${REPEAT_ZH[(ev.rrule.freq||'').toUpperCase()]||ev.rrule.freq}`);
  if(ev.type==='work'||ev.type==='rest') lines.push(`类型：${ev.type==='work'?'班（调休上班）':'休（放假）'}`);
  if(ev.location) lines.push(`地点：${ev.location}`);
  if(ev.desc) lines.push(`备注：${ev.desc}`);
  $('#detailMeta').innerHTML=lines.map(l=>`<div class="dm-row">${escapeHtml(l)}</div>`).join('');
  const mine=ev.ownerId===myId();
  $('#detailDelete').classList.toggle('hidden', !mine);
  $('#detailLockNote').classList.toggle('hidden', mine);
  $('#detailModal').hidden=false;
}
$('#detailClose').onclick=()=>{ $('#detailModal').hidden=true; };
$('#detailDelete').onclick=async()=>{
  if(!detailEvent) return;
  if(!await uiConfirm('删除日程',`删除「${detailEvent.title}」？删除会同步给空间内所有成员。`,'删除')) return;
  if(Store.deleteEvent(state.code, detailEvent.id)){ $('#detailModal').hidden=true; toast('已删除'); }
  else toast('只有创建者可以删除这条日程');
};

/* ---------- 新建日程 ---------- */
function openEventModal(presetDate){
  $('#evTitle').value='';
  $('#evDate').value=presetDate||dateStr(state.year,state.month,new Date().getDate());
  $('#evAllDay').checked=false; $('#timeRow').style.display='flex';
  $('#evStart').value='09:00'; $('#evEnd').value='10:00'; $('#evType').value='normal'; $('#evDesc').value='';
  $('#evRepeat').value='none';
  $('#eventModal').hidden=false;
}
$('#eventCancel').onclick=()=>{ $('#eventModal').hidden=true; };
$('#evAllDay').onchange=(e)=>{ $('#timeRow').style.display=e.target.checked?'none':'flex'; };
$('#eventSave').onclick=async()=>{
  const date=$('#evDate').value; if(!date) return toast('请选择日期');
  const ev={
    title:$('#evTitle').value.trim()||'未命名日程', date,
    allDay:$('#evAllDay').checked, start:$('#evAllDay').checked?'':$('#evStart').value,
    end:$('#evAllDay').checked?'':$('#evEnd').value, type:$('#evType').value, desc:$('#evDesc').value,
  };
  const rep=$('#evRepeat').value;
  if(rep!=='none'){ ev.rrule={ freq:rep.toUpperCase(), interval:1, byDay:null, byMonthDay:null, count:null, until:null }; }
  Store.addEvent(state.code, ev);
  $('#eventModal').hidden=true; toast('已保存，稍后自动同步');
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
    .filter(e=>memberOn(e.ownerId) && e.type!=='work' && e.type!=='rest');
  if(!list.length) return toast('没有可回写的日程');
  try{
    await CalBridge.ensurePermission();
    const r=await CalBridge.writeBack(list);
    toast(`已回写系统日历：更新 ${r.upserted} 条，清理 ${r.removed} 条`);
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

/* ---------- 应用内更新 ---------- */
let updInfo = null;
function renderUpdate(){
  const dl=$('#updDlBtn'), ins=$('#updInstallBtn'), note=$('#updNote');
  const rdy = Update.ready();
  dl.hidden = !(updInfo && updInfo.hasUpdate && updInfo.url) || !!rdy;
  ins.hidden = !(rdy && Update.canAutoInstall);
  note.hidden = !updInfo;
  if(updInfo){
    const lines=[];
    if(rdy) lines.push(`v${rdy.ver} 安装包已就绪，点立即安装`);
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
      const pct = p && p.total ? Math.floor(p.received/p.total*100) : 0;
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

/* ---------- 月份导航 & FAB ---------- */
$('#myName').oninput=onNameInput;
$('#addBtn').onclick=()=>openEventModal();
$('#prevBtn').onclick=()=>{ state.month--; if(state.month<1){state.month=12;state.year--;} renderCalendar(); };
$('#nextBtn').onclick=()=>{ state.month++; if(state.month>12){state.month=1;state.year++;} renderCalendar(); };
$('#todayBtn').onclick=()=>{ const t=new Date(); state.year=t.getFullYear(); state.month=t.getMonth()+1; renderCalendar(); };

/* ---------- 启动 ---------- */
applyTheme();
initStart();
showDeviceId();
renderUpdate(); // 进页面就按「已下载/无更新」摆好更新按钮，不必等到设置页
adoptNativeDeviceId(8); // 鸿蒙桥可能晚于首屏才注入，重试等一会儿
if(window.Auth && Auth.session()) Auth.refresh(); // 静默续期，失败保持现有会话
