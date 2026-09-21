/* Node 冒烟测试：ics 解析 / RRULE 展开 / store 合并引擎（浏览器模块用 vm 沙箱加载） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const win = {};
win.window = win;
win.crypto = require('crypto').webcrypto;
win.localStorage = (() => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
})();
win.document = { addEventListener() {}, visibilityState: 'visible', hidden: false };
vm.createContext(win);

function load(file) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8'), win, { filename: file });
}
load('ics.js');
win.App = { clientId: 'zDevice', me: { name: 'T', color: '#fff' } };
win.Dav = { get: async () => ({ status: 404 }), put: async () => ({ status: 200 }) };
load('store.js');

const { parseICS, expandOccurrences } = win.IcsParser;
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

/* ---------- 1. ICS 解析 ---------- */
const ICS = [
  'BEGIN:VCALENDAR', 'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20260916', 'DTEND;VALUE=DATE:20260919',
  'SUMMARY:出差三天', 'UID:t1@x', 'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;TZID=Asia/Shanghai:20260921T090000', 'DTEND;TZID=Asia/Shanghai:20260921T100000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261031T000000Z',
  'SUMMARY:早会这条', 'DESCRIPTION:第二行被折', ' 叠过来的内容',
  'UID:t2@x', 'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART:20260921T230000Z', 'SUMMARY:UTC事件', 'UID:t3@x', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');
const evs = parseICS(ICS);
eq('parse: count', evs.length, 3);
const trip = evs.find((e) => e.title === '出差三天');
eq('parse: 全天跨日 endDate', trip.endDate, '2026-09-18');
const meeting = evs.find((e) => e.title === '早会这条');
eq('parse: 折叠描述', meeting.desc, '第二行被折叠过来的内容');
eq('parse: rrule freq', meeting.rrule.freq, 'WEEKLY');
eq('parse: rrule byDay', meeting.rrule.byDay, ['MO', 'WE']);
const utc = evs.find((e) => e.title === 'UTC事件');
{
  const dt = new Date('2026-09-21T23:00:00Z');
  const want = String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
  eq('parse: UTC转本地时间', utc.start, want);
}

/* ---------- 2. 展开 ---------- */
let occ = expandOccurrences(meeting, '2026-09-21', '2026-10-04');
// 9/21 周一起：MO/WE → 9/21 9/23 9/28 9/30（10/4 是周日）
eq('expand: weekly MO,WE', occ, ['2026-09-21', '2026-09-23', '2026-09-28', '2026-09-30']);
eq('expand: 全在窗口内', occ.filter((d) => d < '2026-09-21' || d > '2026-10-04').length, 0);

occ = expandOccurrences(trip, '2026-09-15', '2026-09-30');
eq('expand: 全天多日逐日', occ, ['2026-09-16', '2026-09-17', '2026-09-18']);

const daily = { date: '2026-09-01', rrule: { freq: 'DAILY', interval: 2, count: null, until: new Date(2026, 8, 9), byDay: null, byMonthDay: null } };
occ = expandOccurrences(daily, '2026-09-01', '2026-09-30');
eq('expand: daily/2 + until', occ, ['2026-09-01', '2026-09-03', '2026-09-05', '2026-09-07', '2026-09-09']);

const monthly = { date: '2026-01-31', rrule: { freq: 'MONTHLY', interval: 1, count: null, until: null, byDay: null, byMonthDay: [15, 31] } };
occ = expandOccurrences(monthly, '2026-02-01', '2026-04-30');
eq('expand: byMonthDay 31 短月钳制', occ, ['2026-02-15', '2026-02-28', '2026-03-15', '2026-03-31', '2026-04-15', '2026-04-30']);

/* ---------- 3. 合并引擎（借 Store 内部逻辑：直接构造同形数据比对） ---------- */
const store = win.Store;
function mkEvent(id, updatedAt, by) { return { id, ownerId: 'a', title: 'E' + id, date: '2026-09-21', allDay: false, start: '', end: '', type: 'normal', desc: '', updatedAt, by }; }
const local = { v: 2, code: 'C1', name: 'S', members: { a: { name: 'A本地', color: '#1', joinedAt: 1, updatedAt: 200, by: 'a' } }, events: { e1: mkEvent('e1', 100, 'b'), e2: mkEvent('e2', 500, 'a') }, deletions: {} };
const remote = { v: 2, code: 'C1', name: 'S', members: { a: { name: 'A远端', color: '#1', joinedAt: 1, updatedAt: 100, by: 'a' }, b: { name: 'B', color: '#2', joinedAt: 2, updatedAt: 50, by: 'b' } }, events: { e1: mkEvent('e1', 300, 'b'), e3: mkEvent('e3', 400, 'b') }, deletions: { e2: 600 } };
// 通过两次 attach + 直接 sync 无法离线测 merge，改为反射调用：store.js 把 merge 藏在闭包里。
// 用公开路径：attach(code, remote) 时本地已有 local → 触发 merge(local, remote)
store.attach('C1', local);
(async () => {
  await store.attach('C1', remote);
  const d = store.get('C1');
  eq('merge: 成员 LWW 取新', d.members.a.name, 'A本地');
  eq('merge: 成员并集', Object.keys(d.members).sort(), ['a', 'b']);
  eq('merge: 事件远端较新胜出', d.events.e1.title, 'Ee1');
  eq('merge: updatedAt', d.events.e1.updatedAt, 300);
  eq('merge: 墓碑删除生效', !!d.events.e2, false);
  eq('merge: 双方独有事件保留', !!d.events.e3, true);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
