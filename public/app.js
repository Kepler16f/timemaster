/* ===== 共享日程 APP · 免登录前端逻辑 ===== */
'use strict';

const PALETTE = ['#FF6B6B','#4ECDC4','#5B8FF9','#F6BD16','#9270CA','#73D13D','#FF9C6E','#36CFC9'];

// 设备本地身份：无需注册，首次打开自动生成
function getClientId() {
  let id = localStorage.getItem('clientId');
  if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : 'c' + Math.random().toString(36).slice(2) + Date.now()); localStorage.setItem('clientId', id); }
  return id;
}
const state = {
  clientId: getClientId(),
  me: {
    name: localStorage.getItem('myName') || ('用户' + Math.floor(100 + Math.random() * 900)),
    color: localStorage.getItem('myColor') || PALETTE[Math.floor(Math.random() * PALETTE.length)],
  },
  space: null,
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  visible: {},
  spaceMode: 'create',
};

const $ = (s) => document.querySelector(s);
function pad(n){ return String(n).padStart(2,'0'); }
function dateStr(y,m,d){ return `${y}-${pad(m)}-${pad(d)}`; }
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),1800); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function shade(hex,p){ const n=parseInt(hex.slice(1),16); let r=(n>>16)&255,g=(n>>8)&255,b=n&255; r=Math.max(0,Math.min(255,r+p)); g=Math.max(0,Math.min(255,g+p)); b=Math.max(0,Math.min(255,b+p)); return '#'+((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1); }

// ---------- API（自动带设备身份） ----------
async function api(path, opts={}) {
  opts.headers = opts.headers || {};
  opts.headers['Content-Type'] = 'application/json';
  opts.headers['X-Client-Id'] = state.clientId;
  const res = await fetch(path, opts);
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(data.error || ('请求失败 '+res.status));
  return data;
}

function showScreen(name){
  ['startScreen','calendarScreen'].forEach(s=>$('#'+s).classList.add('hidden'));
  $('#'+name).classList.remove('hidden');
}

// ---------- 起始屏 ----------
function buildMyColorPicker(){
  const box=$('#myColorPicker'); box.innerHTML='';
  PALETTE.forEach(c=>{
    const sw=document.createElement('div'); sw.className='color-swatch'+(c===state.me.color?' sel':'');
    sw.style.background=c; sw.onclick=()=>{ state.me.color=c; localStorage.setItem('myColor',c); buildMyColorPicker(); };
    box.appendChild(sw);
  });
}
function initStart(){
  $('#myName').value = state.me.name;
  $('#myName').oninput = (e)=>{ state.me.name=e.target.value.trim()||state.me.name; localStorage.setItem('myName', state.me.name); };
  buildMyColorPicker();
  const last = localStorage.getItem('lastSpaceId');
  if (last) $('#lastSpaceBox').classList.remove('hidden'); else $('#lastSpaceBox').classList.add('hidden');
  showScreen('startScreen');
}

$('#createBtn').onclick=()=>openSpaceModal('create');
$('#joinBtn').onclick=()=>openSpaceModal('join');
$('#enterLastBtn').onclick=()=>{ const id=localStorage.getItem('lastSpaceId'); if(id) enterSpace(id); };

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
  try{
    let r;
    if(state.spaceMode==='create'){
      const name=$('#spaceNameInput').value.trim()||'共享日程';
      r=await api('/api/spaces',{method:'POST',body:JSON.stringify({name,displayName:state.me.name,color:state.me.color})});
    }else{
      const code=$('#spaceCodeInput').value.trim().toUpperCase();
      if(!code) return toast('请输入邀请码');
      r=await api('/api/spaces/join',{method:'POST',body:JSON.stringify({code,displayName:state.me.name,color:state.me.color})});
    }
    $('#spaceModal').hidden=true;
    localStorage.setItem('lastSpaceId', r.id);
    await enterSpace(r.id);
  }catch(e){ toast(e.message); }
};

async function enterSpace(id){
  try{
    const sp=await api('/api/spaces/'+id);
    state.space=sp;
    sp.members.forEach(m=>{ if(!(m.clientId in state.visible)) state.visible[m.clientId]=true; });
    if(!state.visible[state.clientId]) state.visible[state.clientId]=true;
    $('#spaceName').textContent=sp.name;
    $('#codeText').textContent=sp.code;
    renderPeopleTags(); renderCalendar();
    showScreen('calendarScreen');
  }catch(e){ toast(e.message); $('#lastSpaceBox').classList.add('hidden'); localStorage.removeItem('lastSpaceId'); }
}
$('#backStart').onclick=()=>{ state.space=null; localStorage.removeItem('lastSpaceId'); initStart(); };
$('#copyCode').onclick=()=>{
  const code=$('#codeText').textContent;
  if(navigator.clipboard) navigator.clipboard.writeText(code).then(()=>toast('邀请码已复制：'+code));
  else toast('邀请码：'+code);
};

// ---------- 成员标签 ----------
function renderPeopleTags(){
  const wrap=$('#peopleTags'); wrap.innerHTML='';
  if(!state.space) return;
  state.space.members.forEach(m=>{
    const tag=document.createElement('span');
    tag.className='person-tag'+(state.visible[m.clientId]?'':' off');
    tag.style.borderColor=m.color; tag.style.background=state.visible[m.clientId]?m.color+'22':'transparent';
    tag.innerHTML=`<span class="dot" style="background:${m.color}"></span>${escapeHtml(m.name)}`;
    tag.onclick=()=>{ state.visible[m.clientId]=!state.visible[m.clientId]; renderPeopleTags(); renderCalendar(); };
    wrap.appendChild(tag);
  });
}

// ---------- 月视图 ----------
function renderCalendar(){
  if(!state.space) return;
  $('#monthTitle').textContent=`${state.year}年${state.month}月`;
  const cal=$('#calendar'); cal.innerHTML='';
  const first=new Date(state.year,state.month-1,1);
  const startWeekday=first.getDay();
  const daysInMonth=new Date(state.year,state.month,0).getDate();
  const daysInPrev=new Date(state.year,state.month-1,0).getDate();
  const today=new Date();
  const todayStr=dateStr(today.getFullYear(),today.getMonth()+1,today.getDate());
  const memberOf={}; state.space.members.forEach(m=>memberOf[m.clientId]=m);

  for(let i=0;i<42;i++){
    const cell=document.createElement('div'); cell.className='cell';
    let y,m,d,other=false;
    if(i<startWeekday){ const pd=daysInPrev-startWeekday+1+i; const pm=state.month-1||12; const py=pm===12?state.year-1:state.year; y=py;m=pm;d=pd;other=true; }
    else if(i>=startWeekday+daysInMonth){ const nd=i-(startWeekday+daysInMonth)+1; const nm=state.month%12+1; const ny=nm===1?state.year+1:state.year; y=ny;m=nm;d=nd;other=true; }
    else { y=state.year;m=state.month;d=i-startWeekday+1; }
    const ds=dateStr(y,m,d);
    if(other) cell.classList.add('other');
    if(ds===todayStr) cell.classList.add('today');

    const num=document.createElement('div'); num.className='date-num'; num.textContent=d; cell.appendChild(num);

    const dayEvents=state.space.events
      .filter(e=>e.date===ds && state.visible[e.ownerId] && memberOf[e.ownerId])
      .sort((a,b)=>(a.start||'').localeCompare(b.start||''));
    const mark=dayEvents.find(e=>e.type==='work'||e.type==='rest');
    if(mark){ const dm=document.createElement('div'); dm.className='daymark '+mark.type; dm.textContent=mark.type==='work'?'班':'休'; cell.appendChild(dm); }

    if(dayEvents.length){
      const box=document.createElement('div'); box.className='events';
      dayEvents.forEach(e=>{
        if(e.type==='work'||e.type==='rest') return;
        const chip=document.createElement('div'); chip.className='ev';
        const color=memberOf[e.ownerId].color;
        chip.style.background=color; chip.style.borderLeftColor=shade(color,-25);
        const time=(!e.allDay&&e.start)?`<span class="ev-time">${e.start}</span>`:'';
        chip.innerHTML=`${time}${escapeHtml(e.title)}`;
        const owner=memberOf[e.ownerId].name;
        chip.title=`${owner} · ${e.title}`+(e.start?` ${e.start}`:'')+(e.location?` @${e.location}`:'');
        chip.onclick=()=>{ if(confirm(`删除「${e.title}」(${owner})？`)) deleteEvent(e.id); };
        box.appendChild(chip);
      });
      cell.appendChild(box);
    }
    cell.onclick=(ev)=>{ if(ev.target!==cell && ev.target!==num) return; openEventModal(ds); };
    cal.appendChild(cell);
  }
}

// ---------- 日程弹窗 ----------
function openEventModal(presetDate){
  $('#evTitle').value='';
  $('#evDate').value=presetDate||dateStr(state.year,state.month,new Date().getDate());
  $('#evAllDay').checked=false; $('#timeRow').style.display='flex';
  $('#evStart').value='09:00'; $('#evEnd').value='10:00'; $('#evType').value='normal'; $('#evDesc').value='';
  $('#eventModal').hidden=false;
}
$('#eventCancel').onclick=()=>{ $('#eventModal').hidden=true; };
$('#evAllDay').onchange=(e)=>{ $('#timeRow').style.display=e.target.checked?'none':'flex'; };
$('#eventSave').onclick=async()=>{
  const payload={ title:$('#evTitle').value.trim()||'未命名日程', date:$('#evDate').value,
    allDay:$('#evAllDay').checked, start:$('#evAllDay').checked?'':$('#evStart').value,
    end:$('#evAllDay').checked?'':$('#evEnd').value, type:$('#evType').value, desc:$('#evDesc').value };
  if(!payload.date) return toast('请选择日期');
  try{ await api('/api/spaces/'+state.space.id+'/events',{method:'POST',body:JSON.stringify(payload)});
    $('#eventModal').hidden=true; await enterSpace(state.space.id); toast('已保存'); }
  catch(e){ toast(e.message); }
};
async function deleteEvent(id){
  try{ await api(`/api/spaces/${state.space.id}/events/${id}`,{method:'DELETE'}); await enterSpace(state.space.id); }
  catch(e){ toast(e.message); }
}

// ---------- 导入 ----------
function fillImportOwner(){
  const sel=$('#importOwner'); sel.innerHTML='';
  (state.space.members||[]).forEach(m=>{
    const o=document.createElement('option'); o.value=m.clientId;
    o.textContent=m.name+(m.clientId===state.clientId?'（我）':''); sel.appendChild(o);
  });
  sel.value=state.clientId;
}
$('#importBtn').onclick=()=>{ fillImportOwner(); $('#importModal').hidden=false; };
$('#importCancel').onclick=()=>{ $('#importModal').hidden=true; };
$('#importSave').onclick=async()=>{
  const f=$('#icsFile'); if(!f.files.length) return toast('请选择 .ics 文件');
  let text='';
  for(const file of f.files){ text += '\n' + await file.text(); }
  const asClientId=$('#importOwner').value;
  try{ const r=await api('/api/spaces/'+state.space.id+'/import',{method:'POST',body:JSON.stringify({ics:text, asClientId})});
    $('#importModal').hidden=true; await enterSpace(state.space.id); toast(`导入成功，新增 ${r.added} 条`); }
  catch(e){ toast(e.message); }
};

// ---------- 月份导航 & FAB ----------
$('#addBtn').onclick=()=>openEventModal();
$('#prevBtn').onclick=()=>{ state.month--; if(state.month<1){state.month=12;state.year--;} renderCalendar(); };
$('#nextBtn').onclick=()=>{ state.month++; if(state.month>12){state.month=1;state.year++;} renderCalendar(); };
$('#todayBtn').onclick=()=>{ const t=new Date(); state.year=t.getFullYear(); state.month=t.getMonth()+1; renderCalendar(); };

// ---------- 启动 ----------
initStart();
