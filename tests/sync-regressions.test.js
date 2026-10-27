const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

function harness() {
  const saved = new Map();
  let tick = 1000;
  const win = {
    App: { clientId: 'self', me: { name: 'Self', color: '#123456' } },
    localStorage: { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, String(v)), removeItem: (k) => saved.delete(k) },
    // 这些测试手动推进网络状态，不运行后台防抖定时器。
    setTimeout() { return 1; }, clearTimeout() {}, console,
    Date: class extends Date { static now() { return ++tick; } },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(readFileSync(join(__dirname, '../public/store.js'), 'utf8'), win);
  return win;
}

function doc(rsvp = {}) {
  return {
    v: 2, code: 'REGRESS', name: 'Regression', createdBy: 'self',
    members: { self: { name: 'Self', color: '#123456', joinedAt: 1, updatedAt: 1, dev: 'self' } },
    events: { e1: { id: 'e1', title: 'Original', ownerId: 'self', date: '2026-10-27', updatedAt: 1, by: 'self', rsvp } },
    deletions: {}, retired: {},
  };
}

for (const initialStatus of [200, 404]) {
  test(`PUT 期间编辑仍标记待同步，并在下一次上传（初次 GET ${initialStatus}）`, async () => {
    const win = harness();
    const store = win.Store;
    let remote = doc(), uploaded;
    win.Dav = {
      get: async () => ({ status: initialStatus, etag: 'v1', text: JSON.stringify(remote) }),
      put: async (_code, text) => {
        uploaded = JSON.parse(text);
        store.updateEvent('REGRESS', 'e1', { title: 'Edited during upload' });
        return { status: 200, etag: 'v2' };
      },
    };
    await store.attach('REGRESS', doc());
    store.updateEvent('REGRESS', 'e1', { title: 'First edit' });
    await store.syncCode('REGRESS');
    assert.equal(uploaded.events.e1.title, 'First edit');
    assert.equal(store.status('REGRESS').dirty, true);
    remote = uploaded;
    win.Dav.get = async () => ({ status: 200, etag: 'v2', text: JSON.stringify(remote) });
    win.Dav.put = async (_code, text) => { uploaded = JSON.parse(text); return { status: 200, etag: 'v3' }; };
    await store.syncCode('REGRESS');
    assert.equal(uploaded.events.e1.title, 'Edited during upload');
    assert.equal(store.status('REGRESS').dirty, false);
  });
}

test('撤回 RSVP 后合并旧设备不会恢复旧应答，重新应答仍然生效', async () => {
  const win = harness();
  const store = win.Store;
  await store.attach('REGRESS', doc());
  store.setRsvp('REGRESS', 'e1', 'yes');
  const stale = JSON.parse(JSON.stringify(store.get('REGRESS')));
  const originalTime = stale.events.e1.rsvp.self.t;
  store.setRsvp('REGRESS', 'e1', null);
  assert.ok(store.get('REGRESS').events.e1.rsvp.self.t > originalTime);
  await store.attach('REGRESS', stale);
  assert.equal(store.get('REGRESS').events.e1.rsvp.self.s, '');
  store.setRsvp('REGRESS', 'e1', 'maybe');
  assert.equal(store.get('REGRESS').events.e1.rsvp.self.s, 'maybe');
  assert.equal(store.get('REGRESS').events.e1.updatedAt, 1);
});

test('RSVP 同一时间戳冲突的结果与合并顺序无关，撤回优先', async () => {
  for (const [left, right, expected] of [['yes', 'no', 'yes'], ['yes', '', '']]) {
    const a = harness().Store, b = harness().Store;
    await a.attach('REGRESS', doc({ self: { s: left, t: 100 } }));
    await a.attach('REGRESS', doc({ self: { s: right, t: 100 } }));
    await b.attach('REGRESS', doc({ self: { s: right, t: 100 } }));
    await b.attach('REGRESS', doc({ self: { s: left, t: 100 } }));
    assert.equal(a.get('REGRESS').events.e1.rsvp.self.s, expected);
    assert.equal(b.get('REGRESS').events.e1.rsvp.self.s, expected);
  }
});
