/* 鸿蒙模拟桥接测试：假 __HarmonyNative（同步字符串入参 + __harmonyNativeCb 异步回传）驱动
   transport → dav(WebDAV/PROPFIND/MKCOL) → store(同步状态机/冲突) → calbridge 全链路 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const win = {};
win.window = win;
win.console = console;
win.crypto = require('crypto').webcrypto;
win.TextEncoder = TextEncoder;
win.TextDecoder = TextDecoder;
win.URL = require('url').URL;
win.setTimeout = setTimeout; win.clearTimeout = clearTimeout;
win.atob = (s) => Buffer.from(s, 'base64').toString('binary');
win.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
win.localStorage = (() => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
})();
win.document = { addEventListener() {}, visibilityState: 'visible', hidden: false };
vm.createContext(win);

/* ---------- 假网盘服务器 + 假原生桥 ---------- */
const files = new Map(); // pathname -> { content, etag, dir }
let ver = 0;
let serveEtag = true; // 有些网盘/反向代理不透传 etag，用来测退化路径
let lastPutHeaders = null;
const editCalls = []; // 假原生侧收到的「写回原日历」调用
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
function done(id, err, resJson) { setTimeout(() => win.__harmonyNativeCb(id, err, resJson == null ? null : resJson), 0); }

function handleHttp(id, payload) {
  let r;
  try {
    const { method, url, headers = {}, body = null } = JSON.parse(payload);
    const p = new win.URL(url).pathname;
    if (method === 'PUT') lastPutHeaders = headers;
    if (method === 'PROPFIND') {
      r = { status: 207, headers: {}, body: '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>' };
    } else if (method === 'MKCOL') {
      if (files.has(p)) r = { status: 405, headers: {}, body: '' };
      else { files.set(p, { content: '', etag: 'dir' + (++ver), dir: true }); r = { status: 201, headers: {}, body: '' }; }
    } else if (method === 'GET') {
      const f = files.get(p);
      if (!f || f.dir) r = { status: 404, headers: {}, body: '' };
      else if (headers['If-None-Match'] === f.etag) r = { status: 304, headers: { etag: f.etag }, body: '' };
      else r = { status: 200, headers: { etag: f.etag }, body: f.content };
    } else if (method === 'PUT') {
      const f = files.get(p);
      if (headers['If-None-Match'] === '*' && f) r = { status: 412, headers: {}, body: '' };
      else if (headers['If-Match'] && f && headers['If-Match'] !== f.etag) r = { status: 412, headers: {}, body: '' };
      else { const etag = 'W"v' + (++ver) + '"'; files.set(p, { content: body || '', etag }); r = { status: 204, headers: { etag }, body: '' }; }
    } else {
      r = { status: 400, headers: {}, body: '' };
    }
  } catch (e) { return done(id, 'native failure: ' + e.message, null); }
  const hdr = serveEtag ? r.headers : Object.assign({}, r.headers, { etag: undefined });
  done(id, null, JSON.stringify({ status: r.status, headers: hdr, bodyBase64: r.body ? b64(r.body) : '' }));
}

win.__HarmonyNative = {
  httpRequest(id, payloadJson) { setTimeout(() => handleHttp(id, payloadJson), 0); },
  calEnsure(id) { done(id, null, null); },
  calFetch(id, from, to) {
    done(id, null, JSON.stringify({ events: [
      { title: '鸿蒙晨跑', date: '2026-09-22', allDay: false, start: '07:30', end: '08:00', rruleStr: 'FREQ=DAILY;INTERVAL=1', sourceUid: 'hos:11', calAcct: 'huawei@cloud.com', calDisp: '华为日历' },
      { title: '发布会', date: '2026-09-25', allDay: true, start: '', end: '', desc: 'HDC', location: '', sourceUid: 'hos:12', calAcct: 'huawei@cloud.com', calDisp: '华为日历' },
    ] }));
  },
  calWrite(id, json) { const o = JSON.parse(json); done(id, null, JSON.stringify({ upserted: o.events.length, removed: 0 })); },
  calEdit(id, json) { editCalls.push(JSON.parse(json)); done(id, null, JSON.stringify({ updated: 1, calendar: '华为日历' })); },
  calOpen(id) { done(id, null, null); },
  deviceId(id) { done(id, null, '{"id":"native-device-1"}'); },
};

function load(file) { vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8'), win, { filename: file }); }
load('transport.js');
win.App = { clientId: 'harDevice', me: { name: '鸿蒙测试', color: '#4ECDC4' } };
load('ics.js');
load('dav.js');
load('store.js');
load('calbridge.js');

const { Transport, Dav, Store, CalBridge, IcsParser } = win;
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}
const ok = (name, cond) => eq(name, !!cond, true);

(async () => {
  /* ---------- 1. 桥探测 ---------- */
  ok('bridge: hasHarmony', Transport.hasHarmony);
  ok('bridge: isNative', Transport.isNative);
  eq('bridge: deviceId() 取到原生设备号', await Transport.deviceId(), 'native-device-1');

  /* ---------- 2. WebDAV 走原生 socket 桥 ---------- */
  Dav.saveConfig({ baseUrl: 'dav.jianguoyun.com/dav', user: 'me@x.com', pass: 'app-pass' });
  eq('dav: baseUrl 自动补 https', Dav.cfg().baseUrl, 'https://dav.jianguoyun.com/dav');
  ok('dav: test() 通过 PROPFIND207+MKCOL', await Dav.test());
  ok('dav: /shared-calendar/ 目录已建', files.has('/dav/shared-calendar/'));

  const data = Store.createSpace('ABCD1234', '鸿蒙房间');
  const p1 = await Dav.put('ABCD1234', JSON.stringify(data), null);
  ok('dav: 首次 PUT(If-None-Match:*) 成功', p1.status === 201 || p1.status === 204);
  const g = await Dav.get('ABCD1234');
  eq('dav: GET 200', g.status, 200);
  eq('dav: 内容 base64 往返一致', JSON.parse(g.text).name, '鸿蒙房间');
  ok('dav: 返回 etag', g.etag);
  eq('dav: If-None-Match 命中 304（零流量轮询）', (await Dav.get('ABCD1234', g.etag)).status, 304);
  eq('dav: 陈旧 etag PUT → 412', (await Dav.put('ABCD1234', '{}', 'W"stale"')).status, 412);

  /* ---------- 3. Store 同步状态机走桥 ---------- */
  await Store.attach('ABCD1234', JSON.parse(g.text), g.etag);
  Store.addEvent('ABCD1234', { title: '喝茶', date: '2026-09-22' });
  eq('store: 变更后 dirty', Store.status('ABCD1234').dirty, true);
  await Store.syncCode('ABCD1234');
  eq('store: 同步后干净', Store.status('ABCD1234').dirty, false);
  const g2 = await Dav.get('ABCD1234');
  const remote = JSON.parse(g2.text);
  ok('store: 事件已上网盘', Object.values(remote.events).some((e) => e.title === '喝茶'));

  // 远端并发更新 + 本地改动 → syncCode 先合再写，双方事件共存
  const d3 = JSON.parse(g2.text);
  d3.events.x9 = { id: 'x9', ownerId: 'other', title: '家人加的日程', date: '2026-09-23', type: 'normal', updatedAt: Date.now() + 5000, by: 'other' };
  await Dav.put('ABCD1234', JSON.stringify(d3), g2.etag); // 带当前 etag 覆盖（本地缓存 etag 变旧）
  Store.addEvent('ABCD1234', { title: '我后加的', date: '2026-09-24' });
  await Store.syncCode('ABCD1234');
  const g4 = JSON.parse((await Dav.get('ABCD1234')).text);
  const titles4 = Object.values(g4.events).map((e) => e.title);
  ok('conflict: 远端事件合并保留', titles4.includes('家人加的日程'));
  ok('conflict: 本地事件合并保留', titles4.includes('我后加的'));

  /* ---------- 4. 日历桥 ---------- */
  ok('cal: available()', CalBridge.available());
  await CalBridge.ensurePermission();
  const fetched = await CalBridge.fetchEvents(0, 9e15);
  const evs = fetched.events;
  eq('cal: 拉取条数', evs.length, 2);
  eq('cal: rrule 字符串解析为规则', evs[0].rrule && evs[0].rrule.freq, 'DAILY');
  eq('cal: 外来日程带上原日历归属', evs[0].calDisp, '华为日历');
  const run = IcsParser.expandOccurrences(evs[0], '2026-09-22', '2026-09-24');
  eq('cal: 展开每日重复', run.length, 3);
  const wr = await CalBridge.writeBack(Object.values(Store.get('ABCD1234').events));
  ok('cal: 回写 upsert 数>0', wr.upserted > 0);
  await CalBridge.openSettings();

  /* ---------- 4b. 外来日程按条写回原日历：只认 hos:/cal: 句柄，自建的返回 false ---------- */
  eq('cal: 鸿蒙句柄解析', CalBridge.sysHandle('hos:11'), { calId: '', id: '11' });
  eq('cal: 安卓句柄解析', CalBridge.sysHandle('cal:7:42'), { calId: '7', id: '42' });
  eq('cal: 自建日程无原生日历句柄', CalBridge.sysHandle('e1'), null);
  ok('cal: 写回原日历走 calEdit', await CalBridge.editSystemEvent(evs[0], 1e12));
  eq('cal: calEdit 收到条目编号与原日历', [editCalls[0].evId, editCalls[0].calDisp], ['11', '华为日历']);
  eq('cal: 自建的日程不写回系统日历', await CalBridge.editSystemEvent({ title: 'x', date: '2026-09-22' }, 0), false);

  /* ---------- 5. 同步状态机：干净时也要拉取远端（新成员/新日程能显示） ---------- */
  const s5 = Store.createSpace('SYNC5', '五人房');
  await Store.attach('SYNC5', s5, null);
  const r5 = await Dav.put('SYNC5', JSON.stringify(s5), null);
  const g5 = await Dav.get('SYNC5');
  await Store.attach('SYNC5', JSON.parse(g5.text), g5.etag);
  const d5 = JSON.parse(g5.text);
  d5.members.family1 = { name: '姐姐', color: '#F0463A', joinedAt: Date.now(), updatedAt: Date.now() + 1, by: 'family1' };
  d5.events.f1 = { id: 'f1', ownerId: 'family1', title: '姐姐加的日程', date: '2026-09-28', type: 'normal', updatedAt: Date.now() + 2, by: 'family1' };
  await Dav.put('SYNC5', JSON.stringify(d5), r5.etag);
  await Store.syncCode('SYNC5'); // 本地无改动：不能提前 return，必须把远端合并进来
  const c5 = Store.get('SYNC5');
  ok('pull: 无本地改动也能拉到他人成员', !!c5.members.family1);
  ok('pull: 无本地改动也能拉到他人日程', Object.values(c5.events).some((e) => e.title === '姐姐加的日程'));

  /* ---------- 6. Dav.put 三态：null=仅新建 / 字符串=比对 etag / undefined=无条件覆盖 ---------- */
  await Dav.put('SYNC5', JSON.stringify(d5), 'W"nope"');
  eq('put: 传 etag → 带 If-Match', lastPutHeaders['If-Match'], 'W"nope"');
  eq('put: etag 陈旧 → 412', (await Dav.put('SYNC5', JSON.stringify(d5), 'W"nope"')).status, 412);
  const pull = await Dav.get('SYNC5');
  ok('put: 陈旧 etag 未覆盖远端', JSON.parse(pull.text).members.family1 !== undefined);
  eq('put: 传 null → 带 If-None-Match:* 且已存在时 412', (await Dav.put('SYNC5', JSON.stringify(d5), null)).status, 412);
  eq('put: 传 undefined → 无条件覆盖', (await Dav.put('SYNC5', JSON.stringify(d5), undefined)).status, 204);

  /* ---------- 7. 网盘不透传 etag 时退化为无条件覆盖，仍能收敛（旧版死循环回归） ---------- */
  serveEtag = false;
  const s7 = Store.createSpace('NOETAG', '无etag房');
  await Store.attach('NOETAG', s7, null);
  Store.addEvent('NOETAG', { title: '第一轮', date: '2026-09-29' });
  await Store.syncCode('NOETAG');
  eq('noEtag: 首轮写回后干净', Store.status('NOETAG').dirty, false);
  Store.addEvent('NOETAG', { title: '第二轮', date: '2026-09-30' });
  await Store.syncCode('NOETAG');
  eq('noEtag: 次轮仍收敛（不死循环）', Store.status('NOETAG').dirty, false);
  const t7 = Object.values(JSON.parse((await Dav.get('NOETAG')).text).events).map((e) => e.title);
  ok('noEtag: 两轮事件都在云端', t7.includes('第一轮') && t7.includes('第二轮'));
  serveEtag = true;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('UNEXPECTED:', e); process.exit(1); });
