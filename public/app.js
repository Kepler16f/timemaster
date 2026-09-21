/* ===== 时间管理大师 TimeMaster · 前端主逻辑（数据层：Store/Dav，无服务器依赖） ===== */
'use strict';

const PALETTE = ['#FF6B6B','#4ECDC4','#5B8FF9','#F6BD16','#9270CA','#73D13D','#FF9C6E','#36CFC9'];

function getClientId() {
  let id = localStorage.getItem('tm:clientId');
  if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : 'c' + Math.random().toString(36).slice(2) + Date.now()); localStorage.setItem('tm:clientId', id); }
  return id;
}

window.App = {
  clientId: getClientId(),
  me: {
    name: localStorage.getItem('tm:myName') || ('用户' + Math.floor(100 + Math.random() * 900)),
    color: localStorage.getItem('tm:myColor') || PALETTE[Math.floor(Math.random() * PALETTE.length)],
  },
};

const state = {
  code: null,
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  visible: {},
  spaceMode: 'create',
  pollTimer: null,
};

const $ = (s) => document.querySelector(s);
function pad(n){ return String(n).padStart(2,'0'); }
function dateStr(y,m,d){ return `${y}-${pad(m)}-${pad(d)}`; }
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),1800); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function shade(hex,p){ const n=parseInt(hex.slice(1),16); let r=(n>>16)&255,g=(n>>8)&255,b=n&255; r=Math.max(0,Math.min(255,r+p)); g=Math.max(0,Math.min(255,g+p)); b=Math.max(0,Math.min(255,b+p)); return '#'+((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1); }
function genCode() { const b = new Uint8Array(4); crypto.getRandomValues(b); return Array.from(b, x=>x.toString(16).padStart(2,'0')).join('').toUpperCase(); }
function needDav(){ if(!Dav.cfg()){ toast('请先配置网盘'); openDavModal(); return false; } return true; }

function showScreen(name){
  ['startScreen','calendarScreen'].forEach(s=>$('#'+s).classList.add('hidden'));
  $('#'+name).classList.remove('hidden');
}

/* ---------- 起始屏 ---------- */
function buildMyColorPicker(){
  const box=$('#myColorPicker'); box.innerHTML='';
  PALETTE.forEach(c=>{
    const sw=document.createElement('div'); sw.className='color-swatch'+(c===App.me.color?' sel':'');
    sw.style.background=c; sw.onclick=()=>{ App.me.color=c; localStorage.setItem('tm:myColor',c); buildMyColorPicker(); };
    box.appendChild(sw);
  });
}
function initStart(){
  stopPolling();
  $('#myName').value = App.me.name;
  $('#myName').oninput = (e)=>{ App.me.name=e.target.value.trim()||App.me.name; localStorage.setItem('tm:myName', App.me.name); if(state.code && Store.get(state.code)) Store.setProfile(state.code); };
  buildMyColorPicker();
  const last = localStorage.getItem('tm:lastSpace');
  $('#lastSpaceBox').classList.toggle('hidden', !last);
  $('#startHint').textContent = Dav.cfg() ? '' : '第一步：点右上角 ⚙ 配置坚果云 WebDAV（需要应用密码）';
  showScreen('startScreen');
}

$('#createBtn').onclick=()=>{ if(needDav()) openSpaceModal('create'); };
$('#joinBtn').onclick=()=>{ if(needDav()) openSpaceModal('join'); };
$('#enterLastBtn').onclick=()=>{ const c=localStorage.getItem('tm:lastSpace'); if(c) enterSpace(c); };
$('#davBtn').onclick=openDavModal;

/* ---------- 网盘设置 ---------- */
function openDavModal(){
  const c = Dav.cfg() || { baseUrl:'https://dav.jianguoyun.com/dav', user:'', pass:'' };
  $('#davBase').value=c.baseUrl||''; $('#davUser').value=c.user||''; $('#davPass').value=c.pass||'';
  $('#davModal').hidden=false;
}
$('#davCancel').onclick=()=>{ $('#davModal').hidden=true; };
$('#davTest').onclick=async()=>{
  if(!$('#davUser').value.trim()||!$('#davPass').value) return toast('请填写账号和应用密码');
  Dav.saveConfig({ baseUrl:$('#davBase').value.trim(), user:$('#davUser').value.trim(), pass:$('#davPass').value });
  try{ await Dav.test(); toast('网盘连接成功 ✔'); $('#davModal').hidden=true; initStart(); }
  catch(e){ toast(e.message); }
};
$('#davSave').onclick=()=>{
  Dav.saveConfig({ baseUrl:$('#davBase').value.trim(), user:$('#davUser').value.trim(), pass:$('#davPass').value });
  $('#davModal').hidden=true; toast('已保存（未验证）'); initStart();
};

/* ---------- 创建 / 加入空间 ---------- */
function openSpaceModal(mode){
  state.spaceMode=mode;
  $('#spaceModalTitle').textContent = mode==='create' ? '创建共享空间' : '用邀请码加入';
  $('#spaceNameLabel').classList.toggle('hidden', mode!=='create');
  $('#spaceCodeLabel').classList.toggle('hidden', mode!=='create');
  $('#spaceNameInput').value=''; $('#spaceCodeInput').value='';
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
      let { data, etag } = await Store.openRemote(code);
      if(data.members[App.clientId]) { toast('你已在该空间'); }
      else {
        Store.joinMember(data);
        let p = await Dav.put(code, JSON.stringify(data), etag);
        if(p.status===412){ // 并发加入：重拉合并再写一次
          const fresh = await Store.openRemote(code);
          data = mergeJoin(fresh.data); etag = fresh.etag;
          p = await Dav.put(code, JSON.stringify(data), etag);
          if(p.status===412) throw new Error('空间正被修改，请稍后重试');
        }
      }
      Store.upsertSpaceMeta(code, data.name||'共享空间');
      $('#spaceModal').hidden=true;
      await enterSpace(code);
    }
  }catch(e){ toast(e.message); }
  finally{ btn.disabled=false; }
};
function mergeJoin(remoteData){
  const local = Store.get(state.code);
  const merged = local ? remoteData : JSON.parse(JSON.stringify(remoteData));
  Store.joinMember(merged);
  return merged;
}

/* ---------- 进入空间 ---------- */
async function enterSpace(code){
  state.code=code;
  const data = Store.get(code) || (await Store.openRemote(code)).data;
  await Store.attach(code, data);
  Object.keys(data.members).forEach(id=>{ if(!(id in state.visible)) state.visible[id]=true; });
  state.visible[App.clientId]=true;
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
Store.onChange((code)=>{ if(code===state.code){ renderPeopleTags(); renderCalendar(); updateSyncChip(); } });

function updateSyncChip(){
  const s=Store.status(state.code); const el=$('#syncState');
  if(!s.exists){ el.textContent=''; return; }
  el.textContent = s.syncing? '同步中…' : s.dirty? '待同步（离线可写）' : s.lastSync? '已同步 '+new Date(s.lastSync).toLocaleTimeString() : '';
}
$('#backStart').onclick=()=>{ state.code=null; initStart(); };
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
    tag.className='person-tag'+(state.visible[id]?'':' off');
    tag.style.borderColor=m.color; tag.style.background=state.visible[id]?m.color+'22':'transparent';
    tag.innerHTML=`<span class="dot" style="background:${m.color}"></span>${escapeHtml(m.name)}${id===App.clientId?'（我）':''}`;
    tag.onclick=()=>{ state.visible[id]=!state.visible[id]; renderPeopleTags(); renderCalendar(); };
    wrap.appendChild(tag);
  });
}

/* ---------- 月视图（渲染期按 RRULE 展开，数据里只存规则） ---------- */
function renderCalendar(){
  const data=Store.get(state.code); if(!data) return;
  $('#monthTitle').textContent=`${state.year}年${state.month}月`;
  const cal=$('#calendar'); cal.innerHTML='';
  const first=new Date(state.year,state.month-1,1);
  const startWeekday=first.getDay();
  const daysInMonth=new Date(state.year,state.month,0).getDate();
  const today=new Date();
  const todayStr=dateStr(today.getFullYear(),today.getMonth()+1,today.getDate());

  // 42 格窗口 [winFrom, winTo]
  const winFrom=new Date(first); winFrom.setDate(winFrom.getDate()-startWeekday);
  const winTo=new Date(winFrom); winTo.setDate(winTo.getDate()+41);
  const fromStr=dateStr(winFrom.getFullYear(),winFrom.getMonth()+1,winFrom.getDate());
  const toStr=dateStr(winTo.getFullYear(),winTo.getMonth()+1,winTo.getDate());

  const byDay={}; // ds -> [ {ev} ]
  Object.keys(data.events).forEach(id=>{
    const ev=data.events[id];
    if(!state.visible[ev.ownerId] || !data.members[ev.ownerId]) return;
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
        const owner=data.members[e.ownerId].name;
        chip.title=`${owner} · ${e.title}`+(e.start?` ${e.start}`:'')+(e.location?` @${e.location}`:'')+(e.rrule?' ↻':'');
        chip.onclick=(ev2)=>{ ev2.stopPropagation(); if(confirm(`删除「${e.title}」(${owner})？`)) Store.deleteEvent(state.code,e.id); };
        box.appendChild(chip);
      });
      cell.appendChild(box);
    }
    cell.onclick=()=>openEventModal(ds);
    cal.appendChild(cell);
  }
}

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

/* ---------- 导入 .ics ---------- */
function fillImportOwner(){
  const sel=$('#importOwner'); sel.innerHTML='';
  const data=Store.get(state.code); if(!data) return;
  Object.keys(data.members).forEach(id=>{
    const o=document.createElement('option'); o.value=id;
    o.textContent=data.members[id].name+(id===App.clientId?'（我）':''); sel.appendChild(o);
  });
  sel.value=App.clientId;
}
$('#importBtn').onclick=()=>{ fillImportOwner(); $('#permBtn').hidden=true; $('#importModal').hidden=false; };
$('#importCancel').onclick=()=>{ $('#importModal').hidden=true; };

/* 直接读取系统日历（原生桥） */
$('#permBtn').onclick=()=>CalBridge.openSettings();
$('#sysImportBtn').onclick=async()=>{
  if(!state.code) return;
  try{
    await CalBridge.ensurePermission();
    toast('正在读取系统日历…');
    const now=Date.now(), YEAR=365*86400000;
    const list=await CalBridge.fetchEvents(now-YEAR, now+YEAR);
    if(!list.length) return toast('系统日历中近一年没有日程');
    Store.addEvents(state.code, list, $('#importOwner').value||App.clientId);
    toast(`已导入 ${list.length} 条系统日程`);
    $('#importModal').hidden=true;
  }catch(e){ toast(e.message); if(e.needSettings) $('#permBtn').hidden=false; }
};

/* 回写：空间内可见日程 → 系统「共享日程」独立日历 */
$('#writeBackBtn').onclick=async()=>{
  if(!state.code) return;
  const data=Store.get(state.code); if(!data) return;
  const list=Object.keys(data.events).map(k=>data.events[k])
    .filter(e=>state.visible[e.ownerId] && e.type!=='work' && e.type!=='rest');
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

/* ---------- 月份导航 & FAB ---------- */
$('#addBtn').onclick=()=>openEventModal();
$('#prevBtn').onclick=()=>{ state.month--; if(state.month<1){state.month=12;state.year--;} renderCalendar(); };
$('#nextBtn').onclick=()=>{ state.month++; if(state.month>12){state.month=1;state.year++;} renderCalendar(); };
$('#todayBtn').onclick=()=>{ const t=new Date(); state.year=t.getFullYear(); state.month=t.getMonth()+1; renderCalendar(); };

/* ---------- 启动 ---------- */
initStart();
