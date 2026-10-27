const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

function harness(id = 'a', shared) {
  const values = shared || new Map(); let tick = 10000;
  const win = {
    App: { clientId: id, me: { name: id, color: '#123456' } }, crypto: require('node:crypto').webcrypto,
    console, Date: class extends Date { static now() { return ++tick; } },
    localStorage: { getItem: (k) => values.get(k) || null, setItem: (k,v) => values.set(k,String(v)), removeItem: (k) => values.delete(k) },
    setTimeout() { return 1; }, clearTimeout() {}, document: { addEventListener() {} },
  };
  win.window = win; vm.createContext(win);
  const load = (file) => vm.runInContext(readFileSync(join(__dirname,'../public',file),'utf8'),win,{filename:file});
  load('ics.js'); load('store.js'); load('freetime.js');
  return { win, load, values, store: win.Store, ics: win.IcsParser };
}
function doc(events = {}) {
  return { v:2, code:'PLAN', name:'Planning', createdBy:'a',
    members: { a:{name:'a',dev:'a',color:'#1',updatedAt:1,joinedAt:1}, b:{name:'b',dev:'b',color:'#2',updatedAt:1,joinedAt:1} },
    events, deletions:{}, retired:{} };
}
const event = () => ({ id:'e', ownerId:'a', title:'Meeting', date:'2026-10-27', start:'09:00', end:'10:00', allDay:false,
  type:'normal', rrule:{freq:'DAILY',count:5},updatedAt:1,by:'a' });
const plain = (value) => JSON.parse(JSON.stringify(value));

test('单次取消保持 COUNT 原名额，改期可进入原实例日期之外的显示窗口', async () => {
  const {store,ics}=harness(); await store.attach('PLAN',doc({e:event()}));
  assert.equal(store.updateOccurrence('PLAN','e','2026-10-28',null),true);
  assert.deepEqual(plain(ics.expandOccurrences(store.get('PLAN').events.e,'2026-10-27','2026-11-05')),['2026-10-27','2026-10-29','2026-10-30','2026-10-31']);
  assert.equal(store.updateOccurrence('PLAN','e','2026-10-29',{date:'2026-11-02',title:'Moved',start:'15:00',end:'16:00'}),true);
  const instances=ics.expandEvents(store.get('PLAN').events.e,'2026-11-01','2026-11-03');
  assert.equal(instances.length,1); assert.equal(instances[0].displayDate,'2026-11-02');
  assert.equal(instances[0].occurrenceDate,'2026-10-29'); assert.equal(instances[0].title,'Moved');
  assert.equal(store.get('PLAN').events.e.title,'Meeting');
  assert.equal(store.updateOccurrence('PLAN','e','2026-11-05',null),false);
  assert.equal(store.updateOccurrence('PLAN','e','2026-10-30',{date:'2026-02-31'}),false);
});

test('不同日期例外逐键合并，正文编辑不会覆盖单次修改', async () => {
  const a=harness(), b=harness(); await a.store.attach('PLAN',doc({e:event()})); await b.store.attach('PLAN',doc({e:event()}));
  a.store.updateOccurrence('PLAN','e','2026-10-28',null);
  b.store.updateOccurrence('PLAN','e','2026-10-29',{title:'Special'});
  b.store.updateEvent('PLAN','e',{location:'Room 2'});
  const left=plain(a.store.get('PLAN')),right=plain(b.store.get('PLAN'));
  await a.store.attach('PLAN',right); await b.store.attach('PLAN',left);
  for(const store of [a.store,b.store]) {
    const ev=store.get('PLAN').events.e;
    assert.equal(ev.exceptions['2026-10-28'].cancelled,true);
    assert.equal(ev.exceptions['2026-10-29'].patch.title,'Special'); assert.equal(ev.location,'Room 2');
  }
});

test('其他成员不能修改单次实例；空闲计算使用单次改后的时间', async () => {
  const {store,win}=harness(); await store.attach('PLAN',doc({e:event()}));
  store.updateOccurrence('PLAN','e','2026-10-27',{start:'14:00',end:'15:00'});
  const busy=win.FreeTime.busyOf(store.get('PLAN'),'2026-10-27','2026-10-27',['a'],480,1080);
  assert.equal(busy[0].s,840); assert.equal(busy[0].e,900);
  const other=harness('b'); await other.store.attach('PLAN',plain(store.get('PLAN')));
  assert.equal(other.store.updateOccurrence('PLAN','e','2026-10-27',null),false);
});

test('ICS 导出再导入保留取消与改期，同一系列不拆成重复事件', () => {
  const {ics}=harness(); const ev=event();
  ev.exceptions={'2026-10-28':{cancelled:true},'2026-10-29':{patch:{date:'2026-11-02',title:'Special',start:'14:00',end:'15:00'}}};
  const exported=ics.buildICS([ev]); assert.match(exported,/RECURRENCE-ID/); assert.match(exported,/STATUS:CANCELLED/);
  const parsed=ics.parseICS(exported); assert.equal(parsed.length,1);
  assert.deepEqual(plain(ics.expandOccurrences(parsed[0],'2026-10-27','2026-11-03')),['2026-10-27','2026-10-30','2026-10-31','2026-11-02']);
  assert.equal(ics.expandEvents(parsed[0],'2026-11-02','2026-11-02')[0].start,'14:00');
  delete ev.id; const anonymous=ics.parseICS(ics.buildICS([ev])); assert.equal(anonymous.length,1);
});

test('ICS EXDATE 取消日期，并入同 UID 的 RECURRENCE-ID 改期', () => {
  const {ics}=harness(); const parsed=ics.parseICS('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nDTSTART:20261027T090000\nDTEND:20261027T100000\nRRULE:FREQ=DAILY;COUNT=3\nEXDATE:20261028T090000\nEND:VEVENT\nBEGIN:VEVENT\nUID:x\nRECURRENCE-ID:20261029T090000\nDTSTART:20261101T140000\nDTEND:20261101T150000\nSUMMARY:Moved\nEND:VEVENT\nEND:VCALENDAR');
  assert.equal(parsed.length,1);
  assert.deepEqual(plain(ics.expandOccurrences(parsed[0],'2026-10-27','2026-11-02')),['2026-10-27','2026-11-01']);
});

test('只含 RECURRENCE-ID 的取消指令仍能取消相应实例', () => {
  const {ics}=harness();
  const text='BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nDTSTART:20261027T090000\nRRULE:FREQ=DAILY;COUNT=3\nEND:VEVENT\nBEGIN:VEVENT\nUID:x\nRECURRENCE-ID:20261028T090000\nSTATUS:CANCELLED\nEND:VEVENT\nEND:VCALENDAR';
  const parsed=ics.parseICS(text);
  assert.deepEqual(plain(ics.expandOccurrences(parsed[0],'2026-10-27','2026-10-29')),['2026-10-27','2026-10-29']);
});

test('修改重复规则后，不属于新规则的旧例外不会被复活', async () => {
  const {store,ics}=harness(); await store.attach('PLAN',doc({e:event()}));
  store.updateOccurrence('PLAN','e','2026-10-28',{date:'2026-11-12',title:'Moved'});
  store.updateEvent('PLAN','e',{rrule:{freq:'WEEKLY',count:3}});
  assert.deepEqual(plain(ics.expandOccurrences(store.get('PLAN').events.e,'2026-11-12','2026-11-12')),[]);
});

const options=[{date:'2026-11-01',start:'09:00',end:'10:00'},{date:'2026-11-02',start:'15:00',end:'16:00'}];
test('两人并发投票保留各自选择，只有发起人能确认且只生成一条日程', async () => {
  const a=harness('a'),b=harness('b'); await a.store.attach('PLAN',doc());
  const id=a.store.createPoll('PLAN','Dinner',options); await b.store.attach('PLAN',plain(a.store.get('PLAN')));
  a.store.votePoll('PLAN',id,['o0']); b.store.votePoll('PLAN',id,['o1']);
  const left=plain(a.store.get('PLAN')),right=plain(b.store.get('PLAN'));
  await a.store.attach('PLAN',right); await b.store.attach('PLAN',left);
  for(const store of [a.store,b.store]) {
    assert.deepEqual(plain(store.get('PLAN').polls[id].votes.a.choices),['o0']);
    assert.deepEqual(plain(store.get('PLAN').polls[id].votes.b.choices),['o1']);
  }
  assert.equal(b.store.confirmPoll('PLAN',id,'o0'),null);
  const eventId=a.store.confirmPoll('PLAN',id,'o0'); assert.ok(eventId);
  assert.equal(a.store.confirmPoll('PLAN',id,'o1'),null);
  assert.equal(a.store.votePoll('PLAN',id,['o1']),false);
  assert.equal(Object.keys(a.store.get('PLAN').events).length,1);
});

test('同账户两设备并发确认不同选项，投票结果与生成日程一致收敛', async () => {
  const a=harness('device-a'),b=harness('device-b');
  a.win.Auth={memberKey:()=> 'a'}; b.win.Auth={memberKey:()=> 'a'};
  await a.store.attach('PLAN',doc()); const id=a.store.createPoll('PLAN','Meet',options);
  await b.store.attach('PLAN',plain(a.store.get('PLAN')));
  a.store.confirmPoll('PLAN',id,'o0'); b.store.confirmPoll('PLAN',id,'o1');
  const left=plain(a.store.get('PLAN')),right=plain(b.store.get('PLAN'));
  await a.store.attach('PLAN',right); await b.store.attach('PLAN',left);
  for(const store of [a.store,b.store]) {
    const d=store.get('PLAN'),p=d.polls[id],chosen=p.options.find(o=>o.id===p.resolution.optionId);
    assert.equal(d.events[p.resolution.eventId].date,chosen.date);
  }
  assert.equal(a.store.get('PLAN').polls[id].resolution.optionId,b.store.get('PLAN').polls[id].resolution.optionId);
});

test('投票拒绝重复、无效日期及已退出成员的操作', async () => {
  const {store}=harness(); await store.attach('PLAN',doc());
  assert.throws(()=>store.createPoll('PLAN','Invalid',[options[0],options[0]]),/重复/);
  assert.throws(()=>store.createPoll('PLAN','Invalid',[{...options[0],date:'2026-02-31'},options[1]]),/日期无效/);
  const id=store.createPoll('PLAN','Valid',options);
  store.mutate('PLAN',d=>{d.members.a.out=100;});
  assert.equal(store.votePoll('PLAN',id,['o0']),false); assert.equal(store.confirmPoll('PLAN',id,'o0'),null);
});

test('完整备份找回缺失投票而不覆盖现有投票', async () => {
  const {store}=harness(); await store.attach('PLAN',doc());
  const existing=store.createPoll('PLAN','Current',options);
  const backup=doc(); backup.polls={ [existing]:{id:existing,title:'Old'}, restored:{id:'restored',title:'Restored',options:plain(options),votes:{}} };
  const result=store.importBackup('PLAN',backup);
  assert.equal(result.polls,1); assert.equal(store.get('PLAN').polls[existing].title,'Current');
  assert.equal(store.get('PLAN').polls.restored.title,'Restored');
});

test('投票按退休身份合并，换身份后仍能修改自己的选择且只算一人', async () => {
  const {store,win}=harness('a'); await store.attach('PLAN',doc());
  const id=store.createPoll('PLAN','Dinner',options);
  store.votePoll('PLAN',id,['o0']);
  store.mutate('PLAN',d=>{d.retired.a='b';});
  store.votePoll('PLAN',id,['o1']);
  const d=store.get('PLAN'), votes=store.pollVotes(d,d.polls[id]);
  assert.deepEqual(Object.keys(votes),['b']);
  assert.deepEqual(plain(votes.b.choices),['o1']);
  assert.ok(win.App.clientId);
});

test('失败与 412 不刷新最近成功时间；诊断和待上传列表可跨重启恢复', async () => {
  const {store,win,values}=harness(); await store.attach('PLAN',doc({e:event()}));
  store.updateEvent('PLAN','e',{title:'Changed'});
  win.Dav={get:async()=>{throw new Error('Offline');}}; await store.syncCode('PLAN');
  assert.equal(store.status('PLAN').lastSync,0); assert.equal(store.status('PLAN').pending.length,1);
  const restored=harness('a',values); assert.equal(restored.store.status('PLAN').lastError,'Offline');
  assert.equal(restored.store.status('PLAN').pending[0].title,'Changed');
  win.Dav={get:async()=>({status:200,text:JSON.stringify(doc({e:event()})),etag:'v1'}),put:async()=>({status:412})};
  await store.syncCode('PLAN'); assert.equal(store.status('PLAN').conflicts,3); assert.equal(store.status('PLAN').lastSync,0);
  win.Dav.put=async()=>({status:200,etag:'v2'}); await store.syncCode('PLAN');
  assert.ok(store.status('PLAN').lastSync>0); assert.equal(store.status('PLAN').pending.length,0);
});

test('系统提醒按空间回写，部分失败保留明确错误，不宣称成功', async () => {
  const h=harness(); const calls=[];
  h.win.CalBridge={available:()=>true,isHarmony:()=>false,ensurePermission:async()=>{},sysHandle:(id)=>id&&id.startsWith('cal:'),
    writeBack:async(events,scope)=>{calls.push({events,scope});return {upserted:events.length,failed:1,error:'Reminder denied'};}};
  h.load('reminders.js'); await h.store.attach('PLAN',doc({e:{...event(),rrule:null,rem:10}}));
  await assert.rejects(h.win.ReminderSync.enable('PLAN',true),/Reminder denied/);
  assert.equal(calls[0].scope,'PLAN'); assert.equal(h.win.ReminderSync.status('PLAN').lastSync,0);
  assert.equal(h.win.ReminderSync.status('PLAN').enabled,true);
  h.win.CalBridge.writeBack=async(events,scope)=>({upserted:events.length,failed:0});
  await h.win.ReminderSync.sync('PLAN'); assert.ok(h.win.ReminderSync.status('PLAN').lastSync>0);
  assert.equal(h.win.ReminderSync.current('PLAN'),true);
});

test('日历权限失败不会开启自动回写；单次例外导出为独立系统条目', async () => {
  const h=harness(); h.win.CalBridge={available:()=>true,isHarmony:()=>false,sysHandle:()=>false,
    ensurePermission:async()=>{const e=new Error('Permission denied');e.needSettings=true;throw e;}};
  h.load('reminders.js'); const ev=event(); ev.exceptions={'2026-10-28':{cancelled:true}};
  await h.store.attach('PLAN',doc({e:ev}));
  await assert.rejects(h.win.ReminderSync.enable('PLAN',true),/Permission denied/);
  assert.equal(h.win.ReminderSync.status('PLAN').enabled,false); assert.equal(h.win.ReminderSync.status('PLAN').needSettings,true);
  const items=h.win.ReminderSync.eventsFor('PLAN',new Date('2026-10-27T00:00:00'));
  assert.equal(items.length,4); assert.equal(items.some(e=>e.date==='2026-10-28'),false);
  assert.equal(items.every(e=>!e.rrule),true);
});

test('桥接透传空间范围，明确清除提醒时传 -1，缺省提醒不碰原日历设置', async () => {
  const h=harness(); let payload,edit;
  h.win.Capacitor={Plugins:{AndroidCalendar:{sync:async(p)=>{payload=p;},edit:async(p)=>{edit=p;}}}};
  h.win.Transport={hasHarmony:false}; h.load('calbridge.js');
  await h.win.CalBridge.writeBack([{...event(),rrule:null,rem:0}],'PLAN');
  assert.equal(payload.scope,'PLAN'); assert.equal(payload.events[0].rem,0);
  await h.win.CalBridge.editSystemEvent({...event(),sourceUid:'cal:1:2'});
  assert.equal(Object.hasOwn(edit,'rem'),false);
  await h.win.CalBridge.editSystemEvent({...event(),sourceUid:'cal:1:2',rem:null}); assert.equal(edit.rem,-1);
});
