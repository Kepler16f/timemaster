const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

function auth(request) {
  const saved = new Map();
  const win = {
    App: { clientId: 'device' }, Transport: { request },
    localStorage: { getItem: (k) => saved.get(k) || null, setItem: (k, v) => saved.set(k, v), removeItem: (k) => saved.delete(k) },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(readFileSync(join(__dirname, '../public/auth.js'), 'utf8'), win);
  return win.Auth;
}

test('发送验证码会整理邮箱空白和大小写，发送本身不保存会话', async () => {
  let payload;
  const api = auth(async (req) => { payload = JSON.parse(req.body); return { status: 200, text: '{}' }; });
  await api.sendOtp(' Test@Example.com ');
  assert.equal(payload.email, 'test@example.com');
  assert.equal(api.loggedIn(), false);
});

test('服务休眠、限流、验证码过期均返回可操作的中文提示', async () => {
  for (const [status, body, pattern] of [
    [503, '', /服务暂时不可用.*本机日程.*休眠/],
    [429, '{}', /太频繁/],
    [403, '{"code":"otp_expired"}', /已过期/],
    [500, '{"msg":"SMTP failure"}', /邮件发送配置/],
  ]) {
    const api = auth(async () => ({ status, text: body }));
    await assert.rejects(api.sendOtp('test@example.com'), (error) => error.status === status && pattern.test(error.message));
    assert.equal(api.memberKey(), 'device');
  }
});

test('失败的验证不能保存身份；成功后按账户 uid 标识身份', async () => {
  const bad = auth(async () => ({ status: 200, text: '{}' }));
  await assert.rejects(bad.verifyOtp('test@example.com', '123456'), /验证码不正确/);
  assert.equal(bad.session(), null);
  const good = auth(async () => ({ status: 200, text: JSON.stringify({ access_token: 'test-token', refresh_token: 'refresh', user: { id: 'uid' } }) }));
  await good.verifyOtp(' Test@Example.com ', '123456');
  assert.equal(good.memberKey(), 'u:uid');
  assert.equal(good.session().email, 'test@example.com');
});
