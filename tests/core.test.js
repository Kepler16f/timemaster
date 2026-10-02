/* Node 冒烟测试：ics 解析 / RRULE 展开 / store 合并引擎（浏览器模块用 vm 沙箱加载） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const win = {};
win.window = win;
win.crypto = require('crypto').webcrypto;
win.localStorage = (() => {
  /* 真实 Storage 除了按 key 取值，还能被 Object.keys 枚举（快照的容量清理就靠这个）：
     所以每个键同时挂成自身属性，别做成只有三个方法的假对象 */
  const m = new Map();
  const s = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); s[k] = String(v); },
    removeItem: (k) => { m.delete(k); delete s[k]; },
  };
  return s;
})();
win.document = { addEventListener() {}, visibilityState: 'visible', hidden: false };
win.setTimeout = setTimeout; win.clearTimeout = clearTimeout;
vm.createContext(win);

function load(file) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8'), win, { filename: file });
}
load('ics.js');
win.App = { clientId: 'zDevice', me: { name: 'T', color: '#fff' } };
win.Dav = { get: async () => ({ status: 404 }), put: async () => ({ status: 200 }), remove: async (code) => { (win.Dav.removed = win.Dav.removed || []).push(code); } };
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

/* COUNT 与 UNTIL：这两个值都要经过云端 JSON 往返，测试形状就按往返后写 —— until 是字符串 */
const counted = { date: '2026-09-01', rrule: { freq: 'DAILY', interval: 1, count: 10, until: null, byDay: null, byMonthDay: null } };
eq('expand: count 从最初那次数起（窗口外的历史出现也占名额）',
  expandOccurrences(counted, '2026-09-08', '2026-09-30'), ['2026-09-08', '2026-09-09', '2026-09-10']);
const untilStrEv = { date: '2026-09-01', rrule: { freq: 'DAILY', interval: 2, count: null, until: '2026-09-09T00:00:00.000Z', byDay: null, byMonthDay: null } };
eq('expand: until 同步过后变成字符串照样截断',
  expandOccurrences(untilStrEv, '2026-09-01', '2026-09-30'), ['2026-09-01', '2026-09-03', '2026-09-05', '2026-09-07', '2026-09-09']);
eq('expand: until 之前的月份整段为空就什么都不给',
  expandOccurrences(untilStrEv, '2026-09-10', '2026-09-30'), []);
/* 每周多选：byDay 决定周内哪几天出现，间隔 2 周则跳周（2026-09-02 是周三，周六是 09-05） */
const biweekly = { date: '2026-09-02', rrule: { freq: 'WEEKLY', interval: 2, count: null, until: null, byDay: ['WE', 'SA'], byMonthDay: null } };
eq('expand: 每周三六 + 隔周',
  expandOccurrences(biweekly, '2026-09-01', '2026-09-30'), ['2026-09-02', '2026-09-05', '2026-09-16', '2026-09-19', '2026-09-30']);

/* ---------- 2b. 导出 .ics：自家导出的文本再导回来，日程必须一模一样 ---------- */
const { buildICS } = win.IcsParser;
const longDesc = '第一行\n' + '很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长';
const srcEvs = [
  { id: 'a1', title: '出差三天', date: '2026-09-16', endDate: '2026-09-18', allDay: true, start: '', end: '', desc: '', location: '', rrule: null },
  { id: 'a2', title: '组会, 三五六; 带\\反斜杠', date: '2026-10-02', allDay: false, start: '09:00', end: '10:00',
    desc: longDesc, location: '图书馆三楼', rrule: { freq: 'WEEKLY', interval: 2, byDay: ['WE', 'FR', 'SA'], byMonthDay: null, count: null, until: '2026-11-14' } },
  { id: 'a3', title: '班', date: '2026-10-10', allDay: true, start: '', end: '', desc: '', location: '', rrule: null, type: 'work' },
];
const exported = buildICS(srcEvs, { name: '测试空间' });
const back = parseICS(exported);
eq('export: 条数一致', back.length, 3);
eq('export: 全天跨日区间还原', back.find((e) => e.title === '出差三天').endDate, '2026-09-18');
const zc = back.find((e) => e.rrule);
eq('export: 逗号分号反斜杠还原', zc.title, srcEvs[1].title);
eq('export: 折行的备注还原', zc.desc, longDesc);
eq('export: 地点还原', zc.location, '图书馆三楼');
eq('export: BYDAY 还原', zc.rrule.byDay, ['WE', 'FR', 'SA']);
eq('export: 间隔还原', zc.rrule.interval, 2);
/* UNTIL 导成 UTC 后换个时区可能差一天，所以窗口取在截止日之前，两边展开应当一致 */
eq('export: 展开出的日期完全一致',
  expandOccurrences(zc, '2026-10-01', '2026-11-05'), expandOccurrences(srcEvs[1], '2026-10-01', '2026-11-05'));
eq('export: 班/休类型还原', back.find((e) => e.title === '班').type, 'work');
const maxBytes = (s) => [...s].reduce((n, ch) => n + (ch.codePointAt(0) < 0x80 ? 1 : ch.codePointAt(0) < 0x800 ? 2 : ch.codePointAt(0) < 0x10000 ? 3 : 4), 0);
eq('export: 每行不超过 75 字节', exported.split('\r\n').every((l) => maxBytes(l) <= 75), true);
eq('export: 用 CRLF 分行', exported.indexOf('\r\n') > -1 && !/[^\r]\n/.test(exported), true);

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

  /* ---------- 4. 空间改名：name 按 nameUpdatedAt LWW + 仅创建者可改 ---------- */
  const rnLocal = { v: 2, code: 'C2', name: '本地新名', nameUpdatedAt: 500, createdBy: 'a', members: {}, events: {}, deletions: {} };
  const rnRemote = { v: 2, code: 'C2', name: '远端旧名', nameUpdatedAt: 100, createdBy: 'a', members: {}, events: {}, deletions: {} };
  await store.attach('C2', rnRemote);
  await store.attach('C2', rnLocal);
  eq('rename: 时间戳新的一方胜出', store.get('C2').name, '本地新名');
  eq('rename: createdBy 保留', store.get('C2').createdBy, 'a');

  const space3 = store.createSpace('C3', '初创名');
  await store.attach('C3', space3);
  eq('rename: createSpace 记录创建者', space3.createdBy, 'zDevice');
  eq('rename: 创建者 canRename', store.canRename('C3'), true);
  eq('rename: 创建者改名成功', store.renameSpace('C3', '改名成功'), true);
  /* 非创建者要拿一个「我」从没用过的键来当创建者：isMine 会把用过的自己的键都记住，
     光换 memberKey 还是会被认成同一个人（这正是放宽归属判定想要的行为） */
  const space4 = store.createSpace('C4', '别人建的空间');
  space4.createdBy = 'otherPerson';
  space4.members.otherPerson = { name: '别人', color: '#9', joinedAt: 3, updatedAt: 3, by: 'otherPerson' };
  await store.attach('C4', space4);
  eq('rename: 非创建者 canRename', store.canRename('C4'), false);
  eq('rename: 非创建者改名被拒', store.renameSpace('C4', '非法改名'), false);
  eq('rename: 旧空间无 createdBy 时取最早成员', store.canRename('C1'), false); // C1 members a(joinedAt1) b(joinedAt2)，我谁也不是

  /* ---------- 5. 系统日程导入去重（同批多行 / 重复导入 / 历史清理） ---------- */
  const mk = (n) => Array.from({ length: n }, () => ({ title: '循环日程', date: '2026-09-22', allDay: true, sourceUid: 'cal:1:42' }));
  eq('import: 同批 5 条重复只进 1 条', store.addEvents('C3', mk(5), 'zDevice'), 1);
  eq('import: 再次导入 3 条全部跳过', store.addEvents('C3', mk(3), 'zDevice'), 0);
  eq('import: 无 sourceUid 的事件照常导入', store.addEvents('C3', [{ title: '无UID', date: '2026-09-23', allDay: true }], 'zDevice'), 1);
  store.mutate('C3', (d) => {
    for (let i = 0; i < 2; i++) d.events['dup' + i] = { id: 'dup' + i, title: '循环日程', date: '2026-09-22', allDay: true, sourceUid: 'cal:1:42', ownerId: 'zDevice', updatedAt: Date.now() };
  });
  eq('dedupe: 清理历史重复 2 条', store.dedupe('C3'), 2);
  eq('dedupe: 清理后保留恰好 1 条', Object.values(store.get('C3').events).filter((e) => e.sourceUid === 'cal:1:42').length, 1);
  eq('dedupe: 清理后再导入不再产生重复', store.addEvents('C3', mk(2), 'zDevice'), 0);

  /* ---------- 6. 批量删除 + 邮箱身份迁移 ---------- */
  {
    const ownIds = Object.keys(store.get('C3').events).filter((id) => store.get('C3').events[id].ownerId === 'zDevice');
    store.mutate('C3', (d) => { d.events.otherEv = { id: 'otherEv', title: '他人日程', date: '2026-09-25', ownerId: 'someoneElse', updatedAt: Date.now() }; });
    eq('batch: 只删自己的（他人项被过滤）', store.deleteEvents('C3', ownIds.concat(['otherEv'])), ownIds.length);
    eq('batch: 自己的全部消失', Object.values(store.get('C3').events).filter((e) => e.ownerId === 'zDevice').length, 0);
    eq('batch: 他人日程保留', !!store.get('C3').events.otherEv, true);
    eq('batch: 已写删除墓碑', Object.keys(store.get('C3').deletions).length >= ownIds.length, true);
  }
  {
    store.upsertSpaceMeta('C3', 'C3');
    store.mutate('C3', (d) => { d.members.zDevice = { name: 'T', color: '#fff', joinedAt: 1, updatedAt: 1, by: 'zDevice' }; });
    const keepId = store.addEvent('C3', { title: '迁移后新增', date: '2026-09-26' });
    store.migrateIdentity('zDevice', 'u:mail');
    const d = store.get('C3');
    eq('migrate: 成员资料迁到新身份', d.members['u:mail'].name, 'T');
    eq('migrate: 旧成员键移除', !!d.members.zDevice, false);
    eq('migrate: 创建者迁移', d.createdBy, 'u:mail');
    eq('migrate: 本机身份事件全部改写', Object.values(d.events).every((e) => e.ownerId === 'u:mail' || e.ownerId === 'someoneElse'), true);
    eq('migrate: 不再有 zDevice 名下事件', Object.values(d.events).some((e) => e.ownerId === 'zDevice'), false);
    win.Auth = { memberKey: () => 'u:mail' };
    eq('migrate: 迁移后新身份仍可删除自己的旧日程', store.deleteEvent('C3', keepId), true);
    delete win.Auth;
  }

  /* ---------- 7. 身份收口：同人折叠 / 退休留痕 / 归属判定 ---------- */
  {
    /* 同一个人换了身份键（网页存储被清、设备号被原生存储接管）会留下两条成员，
       旧键名下还压着日程：折成一条，日程改写到当前键，旧键写退休记录而不是直接删 */
    win.Auth = { memberKey: () => 'zDevice', session: () => null };
    await store.attach('S7', { v: 2, code: 'S7', name: 'S7', createdBy: 'oldDev',
      members: {
        oldDev: { name: 'T', color: '#fff', dev: 'zDevice', joinedAt: 1, updatedAt: 1, by: 'oldDev' },
        zDevice: { name: 'T', color: '#fff', dev: 'zDevice', joinedAt: 5, updatedAt: 5, by: 'zDevice' },
      },
      events: { k1: { id: 'k1', ownerId: 'oldDev', title: '旧键写的日程', date: '2026-09-21', updatedAt: 1, by: 'oldDev' } },
      deletions: {}, retired: {} });
    const d7 = store.get('S7');
    eq('fold: 同设备同昵称折成一条', Object.keys(d7.members).sort(), ['zDevice']);
    eq('fold: 旧键名下日程改写到当前键', d7.events.k1.ownerId, 'zDevice');
    eq('fold: 创建者一并改写', d7.createdBy, 'zDevice');
    eq('fold: 折掉的键留下退休记录', d7.retired.oldDev, 'zDevice');

    /* 别人本机留过档 → 把退休的旧键塞回成员表：合并侧要再次收掉，不能显示成第二个人 */
    const resurrect = JSON.parse(JSON.stringify(d7));
    resurrect.members.oldDev = { name: 'T', color: '#fff', dev: 'zDevice', joinedAt: 1, updatedAt: Date.now() + 9e5, by: 'oldDev' };
    await store.attach('S7', resurrect);
    eq('retired: 被复活的旧键当轮再折掉', !!store.get('S7').members.oldDev, false);
    eq('retired: 日程仍在当前键名下', store.get('S7').events.k1.ownerId, 'zDevice');

    /* 共用平板的两个人：设备号相同、昵称不同，绝不能并成一个 */
    await store.attach('S9', { v: 2, code: 'S9', name: 'S9', createdBy: 'pad1',
      members: { pad1: { name: '姐姐', color: '#1', dev: 'pad', joinedAt: 1, updatedAt: 1, by: 'pad1' },
                 pad2: { name: '妹妹', color: '#2', dev: 'pad', joinedAt: 2, updatedAt: 2, by: 'pad2' } },
      events: {}, deletions: {}, retired: {} });
    eq('fold: 同设备不同昵称不算同一人', Object.keys(store.get('S9').members).sort(), ['pad1', 'pad2']);
  }
  {
    /* 归属判定：邮箱是强证据，没登录的老记录宁可放宽给本人 */
    win.Auth = { memberKey: () => 'u:me@x', session: () => ({ email: 'me@x' }) };
    const d = { members: {
      'u:me@x': { name: 'T', color: '#fff', acct: 'me@x' },
      rival: { name: 'T', color: '#fff', acct: 'other@x' },
      legacy: { name: 'T', color: '#fff' },
      other: { name: '别人', color: '#123' },
    }, events: {}, retired: { oldKey: 'u:me@x' } };
    eq('id: 退休旧键名下的日程算自己', store.owns('oldKey', d), true);
    eq('id: 同昵称同颜色但邮箱不同，不算自己', store.owns('rival', d), false);
    eq('id: 未登录留下的同昵称老记录放宽给自己', store.owns('legacy', d), true);
    eq('id: 别人的日程不是自己', store.owns('other', d), false);
    eq('id: resolve 把旧键指向后继键', store.resolve(d, 'oldKey'), 'u:me@x');
  }
  {
    /* 绑邮箱时账户名下已有资料（别的设备先登录过）：保留账户那条，冲突交给界面问 */
    store.upsertSpaceMeta('S8', 'S8');
    win.Auth = { memberKey: () => 'zDevice', session: () => null };
    await store.attach('S8', { v: 2, code: 'S8', name: 'S8', createdBy: 'zDevice',
      members: {
        zDevice: { name: '本机名', color: '#fff', dev: 'zDevice', joinedAt: 9, updatedAt: 9, by: 'zDevice' },
        'u:m@x': { name: '账户名', color: '#0a0', joinedAt: 2, updatedAt: 2, by: 'u:m@x' },
      },
      events: { a: { id: 'a', ownerId: 'zDevice', title: '本机日程', date: '2026-09-21', updatedAt: 1, by: 'zDevice' } },
      deletions: {}, retired: {} });
    const mig = store.migrateIdentity('zDevice', 'u:m@x');
    const d8 = store.get('S8');
    eq('migrate: 昵称冲突被报给界面', mig.conflicts.map((c) => [c.code, c.mine, c.theirs]), [['S8', '本机名', '账户名']]);
    eq('migrate: 不覆盖账户原有的昵称', d8.members['u:m@x'].name, '账户名');
    eq('migrate: joinedAt 取更早那次', d8.members['u:m@x'].joinedAt, 2);
    eq('migrate: 本机日程并到账户键', d8.events.a.ownerId, 'u:m@x');
    eq('migrate: 旧键退休指向账户键', d8.retired.zDevice, 'u:m@x');
    /* 统一改昵称要落到所有已加入空间，而不是只改当前空间 */
    win.Auth = { memberKey: () => 'u:m@x', session: () => ({ email: 'm@x' }) };
    store.setMyName('新昵称');
    eq('name: 当前空间成员记录已更新', store.get('S8').members['u:m@x'].name, '新昵称');
    eq('name: 昵称写进本机资料', win.App.me.name, '新昵称');
    win.App.me.name = 'T';
  }
  {
    /* 换设备登录自动补回空间：靠网盘扫描，云端不落任何凭据 */
    const acctA = { baseUrl: 'https://dav.a.example/dav', user: 'a@x.com', pass: 'p' };
    win.Dav.scanCodes = async () => ({ codes: { F1: acctA, GONE: acctA }, errors: [] });
    win.Dav.getWith = async (c, code) => code === 'F1' ? { status: 200, text: JSON.stringify({
      v: 2, code: 'F1', name: '找回的空间', createdBy: 'sis',
      members: { 'u:m@x': { name: '账户里的名字', color: '#0a0', acct: 'm@x', joinedAt: 1, updatedAt: 1, by: 'u:m@x' } },
      events: {}, deletions: {}, retired: {} }) } : { status: 404 };
    win.Dav.bindSpace = () => {};
    win.Auth = { memberKey: () => 'u:m@x', session: () => ({ email: 'm@x' }) };
    await store.followAccount('u:m@x').then((f) => {
      eq('follow: 只补回成员表命中自己的空间', f.added, ['F1']);
      eq('follow: 带回账户里的昵称供弹窗选择', f.nick, '账户里的名字');
      eq('follow: 空间进了本机列表', store.listSpaces().some((s) => s.code === 'F1'), true);
      eq('follow: 读不到文件的码被跳过', store.listSpaces().some((s) => s.code === 'GONE'), false);
    });
  }

  /* ---------- 8. 管理员角色 / 退出空间 / 移出成员 ---------- */
  {
    /* 本机在 S10 用的是「家里那个网盘账号」，在别处用别的账号 */
    win.Dav.acctId = (code) => (code === 'S10' ? 'aHome' : 'aOther');
    win.Auth = { memberKey: () => 'sisDev', session: () => null };
    await store.attach('S10', {
      v: 2, code: 'S10', name: '家里', createdBy: 'mom',
      members: {
        mom: { name: '妈妈', color: '#1', joinedAt: 1, updatedAt: 1, by: 'mom', davId: 'aHome' },
        sisDev: { name: 'T', color: '#2', joinedAt: 2, updatedAt: 2, by: 'sisDev', davId: 'aHome' },
        friend: { name: '同学', color: '#3', joinedAt: 3, updatedAt: 3, by: 'friend', davId: 'aOther' },
      },
      events: {
        f1: { id: 'f1', ownerId: 'friend', title: '同学的日程', date: '2026-09-21', updatedAt: 1, by: 'friend' },
        s1: { id: 's1', ownerId: 'sisDev', title: '我的日程', date: '2026-09-22', updatedAt: 1, by: 'sisDev' },
      },
      deletions: {}, retired: {},
    });
    eq('role: 与创建者同一个网盘账号的人算管理员', store.role('S10'), 'admin');
    eq('role: 管理员可以改空间名', store.canRename('S10'), true);
    eq('kick: 管理员可移出普通成员', store.canKick('S10', 'friend'), true);
    eq('kick: 管理员动不了创建者', store.canKick('S10', 'mom'), false);
    eq('kick: 同为管理员的互相动不了', store.canKick('S10', 'sisDev'), false);
    eq('members: 创建者排前、带角色与名下日程数',
      store.members('S10').map((m) => [m.name, m.role, m.events]), [['妈妈', 'creator', 0], ['T', 'admin', 1], ['同学', 'member', 1]]);

    /* 退出空间：写云端 + 本机副本要等云端确认后才清（清副本在界面层做） */
    eq('leave: 非创建者可以退出', await store.leave('S10', { dropMine: true }), { purged: false });
    const dl = store.get('S10');
    eq('leave: 成员表里标成已退出、且是自己标的', [!!dl.members.sisDev.out, dl.members.sisDev.outBy], [true, 'sisDev']);
    eq('leave: 勾选后自己名下的日程打了墓碑', [!!dl.events.s1, !!dl.deletions.s1], [false, true]);
    eq('leave: 别人的日程一条不动', !!dl.events.f1, true);
    eq('leave: 已退出的人不再是管理员', store.isManager('S10'), false);
    eq('leave: 自己主动退出的不算「被移出」（不该弹那条告知）', store.kickedOut('S10'), false);
    eq('leave: 创建者不能退出自己的空间', await (async () => {
      win.Auth = { memberKey: () => 'mom', session: () => null };
      return store.leave('S10', {});
    })(), false);
    /* 拿邀请码重新进来：清掉原来那条的 out 标记，而不是又冒出第二个人 */
    win.Auth = { memberKey: () => 'sisDev', session: () => null };
    eq('leave: 重新加入会写回成员表', store.ensureMember('S10'), true);
    eq('leave: 重新加入后不再是已退出', !!store.get('S10').members.sisDev.out, false);
    eq('leave: 成员表里没有多出第二条', store.members('S10').filter((m) => m.mine).length, 1);

    /* 管理员移出成员：名片与名下日程都留着，只是标成已退出 */
    eq('kick: 移出执行成功', store.kickMember('S10', 'friend'), true);
    const dk = store.get('S10');
    eq('kick: 对方被标成被别人移出', [!!dk.members.friend.out, dk.members.friend.outBy], [true, 'sisDev']);
    eq('kick: 对方的日程保留（不脏数据）', !!dk.events.f1, true);
    eq('kick: 移出后不能再移出第二次', store.canKick('S10', 'friend'), false);
    /* 这件事在别人眼里该提几次，按「TA 的日程还在不在空间里」分两种。
       日程还留着：一直正常显示，绝不弹提示（历史日程仍写着 TA 的名字，没什么好提醒的） */
    eq('look: 日程还在→第一次照常画进名单', store.lookMembers('S10').rows.some((m) => m.id === 'friend'), true);
    eq('look: 日程还在→第二次仍画、仍不弹提示',
      (() => { const r = store.lookMembers('S10'); return [r.rows.some((m) => m.id === 'friend'), r.notices.length]; })(), [true, 0]);
    eq('look: 只是显示的事，云端记录与 TA 的日程都没被动', [!!dk.members.friend, !!dk.events.f1], [true, true]);

    /* 日程已清空：画一次 → 提一句 → 从此不再出现 */
    dk.members.friend.out = 0; delete dk.members.friend.outBy; // 他重新加入过
    eq('kick: 移出时可以连 TA 名下的日程一起清掉', store.kickMember('S10', 'friend', { dropMine: true }), true);
    eq('kick: 勾选后 TA 的日程打了墓碑', [!!dk.events.f1, !!dk.deletions.f1], [false, true]);
    const g1 = store.lookMembers('S10');
    eq('look: 已清空的第一次仍画进名单', [g1.rows.some((m) => m.id === 'friend'), g1.notices.length], [true, 0]);
    const g2 = store.lookMembers('S10');
    eq('look: 第二次只弹一句「已被移出，日程已清空」',
      [g2.rows.some((m) => m.id === 'friend'), g2.notices.map((m) => m.name)], [false, ['同学']]);
    const g3 = store.lookMembers('S10');
    eq('look: 第三次起既不画也不弹', [g3.rows.some((m) => m.id === 'friend'), g3.notices.length], [false, 0]);
    eq('look: 不再提≠删记录，成员表里那条还在', !!dk.members.friend, true);
    dk.members.friend.out = 0; delete dk.members.friend.outBy;

    /* 管理员资格以创建者为准：给得了也收得回，收回来之后任何自动途径都不算数 */
    win.Auth = { memberKey: () => 'mom', session: () => null };
    eq('adm: 创建者可以指定普通成员当管理员', store.adminAction('S10', 'friend'), 'set');
    eq('adm: 指定后角色变成管理员', (store.setAdmin('S10', 'friend', true), store.role('S10', 'friend')), 'admin');
    eq('adm: 名单里能看出这是手动指定的', store.members('S10').find((m) => m.id === 'friend').adm, true);
    eq('adm: 再点一次取消，退回普通成员', (store.setAdmin('S10', 'friend', false), store.role('S10', 'friend')), 'member');
    eq('adm: 取消时把 adm 换成「创建者收走」这笔账',
      [store.get('S10').members.friend.adm, !!store.get('S10').members.friend.admOff, store.get('S10').members.friend.admOffBy],
      [undefined, true, 'mom']);
    eq('adm: 同网盘账号的自动管理员，创建者也撤得动', store.adminAction('S10', 'sisDev'), 'unset');
    eq('adm: 撤销后 davId 相同也不再算管理员', (store.setAdmin('S10', 'sisDev', false), store.role('S10', 'sisDev')), 'member');
    eq('adm: 撤销后这位原管理员连移人都移不动了', (() => {
      win.Auth = { memberKey: () => 'sisDev', session: () => null };
      const r = store.canKick('S10', 'friend');
      win.Auth = { memberKey: () => 'mom', session: () => null };
      return r;
    })(), false);
    eq('adm: 创建者改不了自己的角色', store.canSetAdmin('S10', 'mom'), false);
    eq('adm: 被移出的人不该被提名为管理员', (dk.members.friend.out = Date.now(), store.canSetAdmin('S10', 'friend')), false);
    dk.members.friend.out = 0; delete dk.members.friend.outBy;
    win.Auth = { memberKey: () => 'sisDev', session: () => null };
    eq('adm: 管理员（非创建者）没有给收资格的权利', store.canSetAdmin('S10', 'friend'), false);
    win.Auth = { memberKey: () => 'mom', session: () => null };
    eq('adm: 只有创建者重新指定才恢复', (store.setAdmin('S10', 'sisDev', true), store.role('S10', 'sisDev')), 'admin');
    eq('adm: 重新指定后撤销标记一并清掉', store.get('S10').members.sisDev.admOff, undefined);
    eq('kick: 创建者能把管理员也移出去', store.canKick('S10', 'sisDev'), true);
    eq('kick: 创建者动不了自己', store.canKick('S10', 'mom'), false);
    win.Auth = { memberKey: () => 'sisDev', session: () => null };

    /* 先用邀请码进来、事后才粘配置码：拿得到配置码就等于和创建者共用同一台网盘账号，
       本机直接把自己认作管理员，不必等 davId 比对（换过设备就可能对不上） */
    win.Auth = { memberKey: () => 'friend', session: () => null };
    eq('claim: 被创建者撤销过的人，配置码也复活不了管理员', store.claimAdmin('S10'), false);
    eq('claim: 撤销期间角色仍是普通成员', store.role('S10'), 'member');
    delete store.get('S10').members.friend.admOff; delete store.get('S10').members.friend.admOffBy; // 创建者后来又重新给过
    eq('claim: 没被撤销过的人，粘配置码=自我认作管理员', store.claimAdmin('S10'), true);
    eq('claim: 认完之后角色生效', store.role('S10'), 'admin');
    eq('claim: 走的是手动指定那条路，没去改 davId', [store.get('S10').members.friend.adm > 0, store.get('S10').members.friend.davId], [true, 'aOther']);
    eq('claim: 已经是管理员的人不必再提名一次', store.claimAdmin('S10'), false);
    eq('claim: 创建者不必自我提名', (() => {
      win.Auth = { memberKey: () => 'mom', session: () => null };
      const r = store.claimAdmin('S10');
      win.Auth = { memberKey: () => 'sisDev', session: () => null };
      return r;
    })(), false);
    eq('kick: 非管理员谁也别想移', (() => {
      win.Auth = { memberKey: () => 'friend', session: () => null };
      const r = store.canKick('S10', 'sisDev');
      win.Auth = { memberKey: () => 'sisDev', session: () => null };
      return r;
    })(), false);
  }

  /* ---------- 8b. 解散空间 / 只剩 0 人自动删除 / 日历分组名回填 ---------- */
  {
    /* S12：创建者 dad + 普通成员 kid（本机当前身份）。网盘账号按 S10 那个规则给，
       kid 拿的是别的账号，所以只是普通成员——解散只归创建者管 */
    win.Auth = { memberKey: () => 'kid', session: () => null };
    await store.attach('S12', {
      v: 2, code: 'S12', name: '全家桶', createdBy: 'dad',
      members: {
        dad: { name: '爸爸', color: '#1', joinedAt: 1, updatedAt: 1, by: 'dad', davId: 'aHome' },
        kid: { name: 'T', color: '#2', dev: 'kid', joinedAt: 2, updatedAt: 2, by: 'kid', davId: 'aOther' },
      },
      events: {
        d1: { id: 'd1', ownerId: 'dad', title: '爸爸的日程', date: '2026-09-21', updatedAt: 1, by: 'dad' },
        k1: { id: 'k1', ownerId: 'kid', title: '我的日程', date: '2026-09-22', updatedAt: 1, by: 'kid', sourceUid: 'cal:7:99' },
      },
      deletions: {}, retired: {},
    });
    eq('dis: 人数只数还活着的成员', store.liveCount('S12'), 2);
    eq('dis: 非创建者解散不了', await store.dissolve('S12', {}), false);

    win.Auth = { memberKey: () => 'dad', session: () => null };
    eq('dis: 创建者解散成功，但别人还在→数据留着给他看告知', await store.dissolve('S12', {}), { purged: false });
    const s12 = store.get('S12');
    eq('dis: 云端记下谁解散的', [s12.dissolved.by, !!s12.members.dad.out], ['dad', true]);
    eq('dis: 解散不动任何人的日程', [!!s12.events.d1, !!s12.events.k1], [true, true]);
    eq('dis: 本机认出这是个已解散的空间', store.isDissolved('S12'), true);
    eq('dis: 已解散的空间不再把人补回成员表', store.ensureMember('S12'), false);
    /* 同步一轮：死掉的空间不能被自愈逻辑（补成员/折叠/推名单）复活 */
    await store.syncCode('S12');
    eq('dis: 同步后创建者仍是「已退出」，没被 ensureSelf 抹掉', !!store.get('S12').members.dad.out, true);
    eq('dis: 解散之后只剩 kid 一个人', store.liveCount('S12'), 1);

    /* 最后一个人确认告知之后：自己也退出，人数归零 → 顺手把网盘上这份文档删掉 */
    eq('dis: 还有人没确认时绝不删云端', win.Dav.removed, undefined);
    win.Auth = { memberKey: () => 'kid', session: () => null };
    eq('dis: 最后一个人确认解散后把云端数据删了', await store.acknowledgeDissolve('S12'), true);
    eq('dis: 删除动作确实发给了网盘', win.Dav.removed, ['S12']);
    eq('dis: 全员退出后人数为 0', store.liveCount('S12'), 0);

    /* 导入系统日历时只存了日历 id 的老日程：拿到 id→名字后回填分组名，按分组管理才分得开 */
    await store.attach('S13', {
      v: 2, code: 'S13', name: 'S13', createdBy: 'kid',
      members: { kid: { name: 'T', color: '#2', dev: 'kid', joinedAt: 1, updatedAt: 1, by: 'kid' } },
      events: {
        k1: { id: 'k1', ownerId: 'kid', title: '有分组', date: '2026-09-22', updatedAt: 1, by: 'kid', sourceUid: 'cal:7:99', calDisp: '家庭日历' },
        k2: { id: 'k2', ownerId: 'kid', title: '缺分组', date: '2026-09-23', updatedAt: 1, by: 'kid', sourceUid: 'cal:8:12' },
        k3: { id: 'k3', ownerId: 'kid', title: '手工建的', date: '2026-09-24', updatedAt: 1, by: 'kid' },
      },
      deletions: {}, retired: {},
    });
    eq('grp: 按 id→名字回填缺失的分组（已有一致的不动）', store.tagSourceGroups('S13', { 8: '工作日历', 7: '家庭日历' }), 1);
    eq('grp: 回填只碰该碰的那条', [store.get('S13').events.k2.calDisp, store.get('S13').events.k3.calDisp], ['工作日历', undefined]);
    eq('grp: 没有需要补的就返回 0、不产生写入', store.tagSourceGroups('S13', { 8: '工作日历' }), 0);
    win.Auth = { memberKey: () => 'sisDev', session: () => null }; // 下面一段测的是 sisDev 被移出的情形
  }
  {
    /* 被移出的人下次同步要收到通知，本机记录不能被「补回成员表」逻辑悄悄复活 */
    win.Dav.get = async () => ({
      status: 200, etag: 'W/"11"', text: JSON.stringify({
        v: 2, code: 'S11', name: 'S11', createdBy: 'mom',
        members: {
          mom: { name: '妈妈', color: '#1', joinedAt: 1, updatedAt: 1, by: 'mom', davId: 'aOther' },
          sisDev: { name: 'T', color: '#2', joinedAt: 2, updatedAt: 2, by: 'sisDev', out: 123, outBy: 'mom' },
        },
        events: {}, deletions: {}, retired: {},
      }),
    });
    let kickedCode = '';
    store.onKicked((c) => { kickedCode = c; });
    await store.syncCode('S11');
    eq('kicked: 同步时通知界面（由界面问用户要不要移除本机副本）', kickedCode, 'S11');
    eq('kicked: 自己的 out 标记没被 ensureSelf 抹掉', store.get('S11').members.sisDev.out, 123);
    eq('kicked: 被移出的人不算管理员', store.isManager('S11'), false);
  }

  /* ---------- 6. 写回前的本机快照：网盘没有回收站，覆盖前得能自己救回来 ---------- */
  {
    win.Auth = { memberKey: () => 'me', session: () => null };
    const ev = (id, t) => ({ id, ownerId: 'me', title: 'E' + id, date: '2026-09-21', allDay: false, start: '', end: '', type: 'normal', desc: '', updatedAt: t, by: 'me' });
    const cloud = { v: 2, code: 'S20', name: 'S20', createdBy: 'me',
      members: { me: { name: 'T', color: '#fff', joinedAt: 1, updatedAt: 1, by: 'me' } },
      events: { keep: ev('keep', 100), gone: ev('gone', 100) }, deletions: {}, retired: {} };
    store.attach('S20', JSON.parse(JSON.stringify(cloud)));
    store.deleteEvent('S20', 'gone');
    win.Dav.get = async () => ({ status: 200, etag: 'W/"20"', text: JSON.stringify(cloud) });
    let putBody = '';
    win.Dav.put = async (code, body) => { putBody = body; return { status: 200, etag: 'W/"21"' }; };
    await store.syncCode('S20');
    eq('snap: 开关默认是开的', store.snaps.enabled(), true);
    const snaps = store.snaps.list('S20');
    eq('snap: 盖写云端之前留下旧版一份', snaps.length, 1);
    eq('snap: 列表只给元信息、不带正文', snaps[0].text, undefined);
    eq('snap: 快照正文里那条还在', JSON.parse(store.snaps.text('S20', snaps[0].t)).events.gone.title, 'Egone');
    eq('snap: 恢复只补现在没有的那条', store.snaps.restore('S20', snaps[0].t), 1);
    eq('snap: 找回来的那条标题对得上', store.get('S20').events.gone.title, 'Egone');
    /* 此刻云端仍留着这条的删除墓碑：恢复写入的时间戳必须压过它，否则同步一轮又被杀回去 */
    win.Dav.get = async () => ({ status: 200, etag: 'W/"22"', text: putBody });
    await store.syncCode('S20');
    eq('snap: 恢复后的那条不会下一轮就被墓碑杀掉', !!store.get('S20').events.gone, true);
    store.snaps.setEnabled(false);
    store.mutate('S20', (d) => { d.events.extra = ev('extra', Date.now() + 5); });
    await store.syncCode('S20');
    eq('snap: 关掉开关后不再新增快照', store.snaps.list('S20').length, 1);
    store.snaps.setEnabled(true);
    store.removeSpace('S20');
    eq('snap: 退掉空间时连同快照一起清掉', store.snaps.bytes(), 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
