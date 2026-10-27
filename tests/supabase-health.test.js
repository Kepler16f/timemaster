const { test } = require('node:test');
const assert = require('node:assert/strict');

const modulePromise = import('../scripts/supabase-health.mjs');
const config = { url: 'https://example.supabase.co', key: 'public-test-key' };
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

test('巡检查询真实数据库函数，并且不调用发送验证码接口', async () => {
  const { checkSupabase } = await modulePromise;
  const requests = [];
  const result = await checkSupabase({ config, fetchImpl: async (url, init) => {
    requests.push({ url, init });
    return reply(url.endsWith('/settings') ? { external: { email: true } } : { ok: true, checked_at: '2026-10-27T00:00:00Z' });
  } });
  assert.equal(result.database, true);
  assert.deepEqual(requests.map((r) => r.url), [config.url + '/auth/v1/settings', config.url + '/rest/v1/rpc/reunion_healthcheck']);
  assert.equal(requests[1].init.method, 'POST');
  assert.equal(requests[1].init.redirect, 'error');
});

test('短暂 503 会重试，缺失函数会明确失败而非虚报保活成功', async () => {
  const { checkSupabase } = await modulePromise;
  let attempts = 0;
  await assert.rejects(checkSupabase({ config, sleep: async () => {}, fetchImpl: async (url) => {
    attempts++;
    if (attempts === 1) return reply({}, 503);
    return url.endsWith('/settings') ? reply({ external: { email: true } }) : reply({}, 404);
  } }), /健康检查函数不存在/);
  assert.equal(attempts, 3);
});

test('禁用 Email provider 和无效数据库响应不能通过巡检', async () => {
  const { checkSupabase } = await modulePromise;
  await assert.rejects(checkSupabase({ config, fetchImpl: async () => reply({ external: { email: false } }) }), /邮箱登录已关闭/);
  await assert.rejects(checkSupabase({ config, fetchImpl: async (url) => reply(url.endsWith('/settings') ? { external: { email: true } } : { ok: true }) }), /响应不符合约定/);
});

test('拒绝管理权限密钥和会传出凭据的项目地址', async () => {
  const { readSupabaseConfig } = await modulePromise;
  const key = 'a.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.b';
  assert.throws(() => readSupabaseConfig({ SUPABASE_URL: config.url, SUPABASE_ANON_KEY: key }), /只允许 anon/);
  assert.throws(() => readSupabaseConfig({ SUPABASE_URL: 'http://example.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_test' }), /HTTPS/);
  assert.throws(() => readSupabaseConfig({ SUPABASE_URL: config.url + '/wrong', SUPABASE_ANON_KEY: 'sb_publishable_test' }), /路径/);
});
