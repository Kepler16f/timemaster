/* RSVP 字段级合并 / 同步 diff / 共同空闲：v0.6.0 协作三件套 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const win = {};
win.window = win;
win.crypto = require('crypto').webcrypto;
win.localStorage = (() => {
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
load('freetime.js');
win.App = { clientId: 'zDev', me: { name: 'T', color: '#fff' } };
win.Dav = { get: async () => ({ status: 404 }), put: async () => ({ status: 200 }), remove: async () => {} };
load('store.js');

const store = win.Store;
const { FreeTime } = win;
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}
function ok(name, cond) {
  if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); }
}

function mkDoc(code, events, extra) {
  return Object.assign({
    v: 2, code, name: code, createdBy: 'a',
    members: {
      a: { name: '甲', color: '#1', joinedAt: 1, updatedAt: 1, by: 'a' },
      b: { name: '乙', color: '#2', joinedAt: 2, updatedAt: 2, by: 'b' },
    },
    events, deletions: {}, retired: {},
  }, extra || {});
}
function mkEvent(id, ownerId, updatedAt, rsvp) {
  const e = { id, ownerId, title: 'E' + id, date: '2026-10-01', allDay: false, start: '09:00', end: '10:00', type: 'normal', updatedAt, by: ownerId };
  if (rsvp) e.rsvp = rsvp;
  return e;
}

(async () => {
  /* ---------- 1. rsvp 字段级合并：整事件 LWW 之上做逐键并集 ---------- */
  {
    /* 远端整条较新（LWW 会选远端），但本机留着更新的答题：键内 t 大者胜 */
    const local = mkDoc('R1', { e1: mkEvent('e1', 'a', 100, { a: { s: 'yes', t: 300 } }) });
    const remote = mkDoc('R1', { e1: mkEvent('e1', 'a', 200, { a: { s: 'no', t: 900 }, b: { s: 'maybe', t: 50 } }) });
    await store.attach('R1', local);
    await store.attach('R1', remote);
    const e1 = store.get('R1').events.e1;
    eq('rsvp: 键内 t 大者胜（a 改答 no）', e1.rsvp.a, { s: 'no', t: 900 });
    eq('rsvp: 另一方的键保留（b 的 maybe）', e1.rsvp.b, { s: 'maybe', t: 50 });

    /* 本机整条较新：远端的新答题照样并进来 */
    const local2 = mkDoc('R2', { e1: mkEvent('e1', 'a', 500, { a: { s: 'yes', t: 500 } }) });
    const remote2 = mkDoc('R2', { e1: mkEvent('e1', 'a', 100, { b: { s: 'no', t: 800 } }) });
    await store.attach('R2', local2);
    await store.attach('R2', remote2);
    const r2 = store.get('R2').events.e1.rsvp;
    eq('rsvp: LWW 胜者是本机', r2.a, { s: 'yes', t: 500 });
    eq('rsvp: 远端答题不因整条较旧而丢失', r2.b, { s: 'no', t: 800 });

    /* 合并顺序无关：先并 remote 再并 local 与反过来结果一致 */
    const revLocal = mkDoc('R3', { e1: mkEvent('e1', 'a', 100, { a: { s: 'yes', t: 300 } }) });
    const revRemote = mkDoc('R3', { e1: mkEvent('e1', 'a', 200, { a: { s: 'no', t: 900 } }) });
    await store.attach('R3', revLocal);
    await store.attach('R3', revRemote);
    eq('rsvp: 逆序合并同样收敛', store.get('R3').events.e1.rsvp.a, { s: 'no', t: 900 });
  }

  /* ---------- 2. setRsvp：只写自己的键，且不动别人已答的 ---------- */
  {
    await store.attach('R4', mkDoc('R4', { e1: mkEvent('e1', 'b', 100, { b: { s: 'no', t: 100 } }) }));
    eq('rsvp: 本人应答成功', store.setRsvp('R4', 'e1', 'yes'), true);
    const r = store.get('R4').events.e1.rsvp;
    eq('rsvp: 自己的键写上', r.zDev.s, 'yes');
    eq('rsvp: 别人的键不动', r.b, { s: 'no', t: 100 });
    eq('rsvp: 清除自己的', (store.setRsvp('R4', 'e1', null), store.get('R4').events.e1.rsvp.zDev), undefined);
    eq('rsvp: 别人的键在清除后仍在', !!store.get('R4').events.e1.rsvp.b, true);
    /* 别人的日程也能答：正文编辑权归创建者，出勤是自己的事 */
    eq('rsvp: 他人的日程允许应答', store.setRsvp('R4', 'e1', 'maybe'), true);
    /* 抬 updatedAt 会让这台设备的旧正文在 LWW 里获胜，把别人刚改的标题顶回去（真实丢数据） */
    eq('rsvp: 应答不抬整条的 updatedAt', store.get('R4').events.e1.updatedAt, 100);
  }

  /* ---------- 2b. 应答出勤绝不参与正文的 LWW 竞争 ---------- */
  {
    const mk = (t, title, start) => ({
      id: 'e1', ownerId: 'b', title, date: '2026-10-01', allDay: false,
      start, end: '', type: 'normal', updatedAt: t, by: 'b',
    });
    await store.attach('S9', mkDoc('S9', { e1: Object.assign(mk(100, '原标题', '09:00'), { rsvp: {} }) }));
    store.setRsvp('S9', 'e1', 'no');                       // 本机拿着旧正文答了个「不去」
    await store.attach('S9', mkDoc('S9', { e1: Object.assign(mk(200, '乙改过的', '14:00'), { rsvp: {} }) }));
    const e = store.get('S9').events.e1;
    eq('出勤: 云端较新的标题不被旧正文顶掉', e.title, '乙改过的');
    eq('出勤: 云端较新的时间不被旧正文顶掉', e.start, '14:00');
    eq('出勤: 自己的应答仍然并进来', e.rsvp.zDev.s, 'no');
  }

  /* ---------- 3. 同步 diff：别人带来的增改答删才 notify ---------- */
  {
    const seen = [];
    store.onDiff((code, diff) => { seen.push({ code, diff }); });
    const base = mkDoc('D1', {
      e1: mkEvent('e1', 'b', 100),
      e2: mkEvent('e2', 'b', 100),
      e3: mkEvent('e3', 'b', 100, { b: { s: 'no', t: 100 } }),
    });
    await store.attach('D1', base);
    win.Dav.get = async () => ({
      status: 200, etag: 'W/"d1"',
      text: JSON.stringify(mkDoc('D1', {
        e1: mkEvent('e1', 'b', 100),                                   // 没变
        e2: mkEvent('e2', 'b', 300),                                   // 别人改了
        e3: mkEvent('e3', 'b', 200, { b: { s: 'yes', t: 200 } }),      // 别人只改了出勤
        e4: mkEvent('e4', 'b', 50),                                    // 别人新增
      })),
    });
    await store.syncCode('D1');
    eq('diff: 三条变更按类别上报',
      seen[0].diff.map((d) => [d.kind, d.id]).sort((x, y) => x[1].localeCompare(y[1])),
      [['add', 'e4'], ['edit', 'e2'], ['rsvp', 'e3']].sort((x, y) => x[1].localeCompare(y[1])));
    const rsvpItem = seen[0].diff.filter((d) => d.kind === 'rsvp')[0];
    eq('diff: rsvp 带上应答人与选项', [rsvpItem.who, rsvpItem.st], ['b', 'yes']);
    /* 远端只是答了出勤、本机那份正文更新（LWW 不吃远端）：这条新闻仍然要报出来 */
    seen.length = 0;
    await store.attach('D2', mkDoc('D2', { e1: mkEvent('e1', 'b', 900, { b: { s: 'no', t: 100 } }) }));
    win.Dav.get = async () => ({
      status: 200, etag: 'W/"d2"',
      text: JSON.stringify(mkDoc('D2', {
        e1: mkEvent('e1', 'b', 500, { b: { s: 'no', t: 100 }, c: { s: 'yes', t: 700 } }),
      })),
    });
    await store.syncCode('D2');
    eq('diff: 远端答题不靠 updatedAt 也能报出',
      seen.length ? seen[0].diff.map((d) => [d.kind, d.who, d.st]) : [], [['rsvp', 'c', 'yes']]);
    eq('diff: 本机较新的正文没被远端旧版顶掉', store.get('D2').events.e1.updatedAt, 900);
    /* 自己再改一条（本机身份写）：不算新闻 */
    seen.length = 0;
    store.addEvent('D1', { title: '我自己加的', date: '2026-10-02' });
    win.Dav.get = async () => ({ status: 200, etag: 'W/"d2"', text: JSON.stringify(store.get('D1')) });
    await store.syncCode('D1');
    eq('diff: 本机自己的变更不上报', seen.length, 0);
    /* 删除（墓碑）也上报 */
    seen.length = 0;
    win.Dav.get = async () => ({
      status: 200, etag: 'W/"d3"',
      text: JSON.stringify(Object.assign(mkDoc('D1', { e2: mkEvent('e2', 'b', 300) }), { deletions: { e2: 900 } })),
    });
    await store.syncCode('D1');
    eq('diff: 删除以墓碑上报', seen.map((s) => s.diff.map((d) => d.kind)), [['del']]);
    eq('diff: 删除条目带上标题', seen[0].diff[0].title, 'Ee2');
  }

  /* ---------- 4. 共同空闲 ---------- */
  {
    const mk = (id, ownerId, start, end, extra) => Object.assign(mkEvent(id, ownerId, 1), start ? { start, end } : { allDay: true, start: '', end: '' }, extra || {});
    const W = { from: '2026-10-01', to: '2026-10-03', dayStart: 480, dayEnd: 1320, minDur: 30 };
    /* 甲乙各占一段且重叠：合并成 09:00-11:00，剩三段空 */
    const data = mkDoc('F1', {
      a1: mk('a1', 'a', '09:00', '10:00'),
      b1: mk('b1', 'b', '09:30', '11:00'),
      a2: mk('a2', 'a', '13:00', '14:00'),
    });
    let r = FreeTime.slots([{ data, members: ['a', 'b'] }], W);
    eq('free: 重叠合并后剩三段',
      r[0].slots.map((s) => [s.s, s.e]),
      [['08:00', '09:00'], ['11:00', '13:00'], ['14:00', '22:00']]);
    /* 只看乙：甲的事件不再挡时间 */
    r = FreeTime.slots([{ data, members: ['b'] }], W);
    eq('free: 只看乙时剩两段',
      r[0].slots.map((s) => [s.s, s.e]),
      [['08:00', '09:30'], ['11:00', '22:00']]);
    /* 全天日程 = 占满整个时间窗 */
    const allday = mkDoc('F2', { a3: mk('a3', 'a', null, null) });
    eq('free: 全天日程挡住整天', FreeTime.slots([{ data: allday, members: ['a'] }], W)[0].slots, []);
    eq('free: 不选甲时全天日程不挡',
      FreeTime.slots([{ data: allday, members: ['b'] }], W)[0].slots,
      [{ sMin: 480, eMin: 1320, s: '08:00', e: '22:00' }]);
    /* 最短时长过滤：头尾不足 30 分钟的碎档都被滤掉 */
    const tight = mkDoc('F3', { t1: mk('t1', 'a', '08:20', '21:55') });
    r = FreeTime.slots([{ data: tight, members: ['a'] }], { from: '2026-10-01', to: '2026-10-01', dayStart: 480, dayEnd: 1320, minDur: 30 });
    eq('free: 头尾不足 30 分钟的碎档被滤掉', r[0].slots, []);
    /* 班/休标记不占时间 */
    const marks = mkDoc('F4', { w1: mk('w1', 'a', null, null, { type: 'rest', title: '休' }) });
    eq('free: 班/休标记不算占用',
      FreeTime.slots([{ data: marks, members: ['a'] }], W)[0].slots,
      [{ sMin: 480, eMin: 1320, s: '08:00', e: '22:00' }]);
    /* 跨空间取并集 */
    const s1 = mkDoc('F5', { x1: mk('x1', 'a', '09:00', '10:00') });
    const s2 = mkDoc('F6', { y1: mk('y1', 'a', '10:00', '11:00') });
    r = FreeTime.slots([{ data: s1, members: ['a'] }, { data: s2, members: ['a'] }],
      { from: '2026-10-01', to: '2026-10-01', dayStart: 480, dayEnd: 1320, minDur: 30 });
    eq('free: 跨空间忙碌取并', r[0].slots.map((s) => [s.s, s.e]), [['08:00', '09:00'], ['11:00', '22:00']]);
    /* 循环日程在窗口内展开：每周三 09:00-10:00（2026-09-30 是周三） */
    const rec = mkDoc('F7', { r1: { id: 'r1', ownerId: 'a', title: '周会', date: '2026-09-30', allDay: false, start: '09:00', end: '10:00', type: 'normal', rrule: { freq: 'WEEKLY', interval: 1 }, updatedAt: 1, by: 'a' } });
    r = FreeTime.slots([{ data: rec, members: ['a'] }], { from: '2026-10-05', to: '2026-10-11', dayStart: 480, dayEnd: 1320, minDur: 30 });
    const wed = r.find((x) => x.date === '2026-10-07');
    eq('free: 循环日程展开后当天剩两段', wed.slots.map((s) => [s.s, s.e]), [['08:00', '09:00'], ['10:00', '22:00']]);
    eq('free: 其余天不受影响', r.find((x) => x.date === '2026-10-08').slots, [{ sMin: 480, eMin: 1320, s: '08:00', e: '22:00' }]);
  }

  /* ---------- 5. 完整备份找回：只补缺的、压过墓碑、绝不动已有的 ---------- */
  {
    const backup = mkDoc('BK1', {
      e1: mkEvent('e1', 'a', 100),
      e2: mkEvent('e2', 'b', 90),
      e3: mkEvent('e3', 'b', 50, { a: { s: 'yes', t: 100 } }),
    });
    const local = mkDoc('BK1', { e1: mkEvent('e1', 'a', 100), e2: mkEvent('e2', 'b', 5e12) }, { deletions: { e3: 9e12 } });
    await store.attach('BK1', local);
    const r = store.importBackup('BK1', backup);
    eq('backup: 只补回丢了的那条', r.events, 1);
    eq('backup: 别人改过的不动（updatedAt 还是新的）', store.get('BK1').events.e2.updatedAt, 5e12);
    eq('backup: 找回条目时间戳压过墓碑', store.get('BK1').events.e3.updatedAt > 9e12, true);
    eq('backup: rsvp 随找回条目原样回来', store.get('BK1').events.e3.rsvp.a.s, 'yes');
    let err = '';
    try { store.importBackup('BK1', { v: 1, events: {} }); } catch (e) { err = e.message; }
    ok('backup: 非 v:2 文档报格式错', err.indexOf('备份') >= 0);
    try { store.importBackup('BK9', { v: 2, events: { a: {} } }); err = 'no-throw'; } catch (e) { err = e.message; }
    ok('backup: 本机没这个空间时报错而不是默默建', err.indexOf('本机') >= 0);
    const dis = mkDoc('BK1', { e9: mkEvent('e9', 'b', 10) }, { dissolved: { at: 1, by: 'a' } });
    try { store.importBackup('BK1', dis); err = 'no-throw'; } catch (e) { err = e.message; }
    ok('backup: 已解散空间的备份拒绝找回', err.indexOf('解散') >= 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('UNEXPECTED:', e); process.exit(1); });