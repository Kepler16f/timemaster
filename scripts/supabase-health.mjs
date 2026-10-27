import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './version.mjs';

export function readSupabaseConfig(env = process.env) {
  // 复用客户端的公开配置，避免保活任务仍指向已经弃用的项目。
  const source = readFileSync(join(root, 'public/auth.js'), 'utf8');
  const defaults = source.match(/const DEFAULT_SUPA\s*=\s*\{([\s\S]*?)\n\s*\};/)?.[1] || '';
  const url = (env.SUPABASE_URL || defaults.match(/\burl:\s*'([^']+)'/)?.[1] || '').replace(/\/+$/, '');
  const key = env.SUPABASE_ANON_KEY || defaults.match(/\banon:\s*'([^']+)'/)?.[1] || '';
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('SUPABASE_URL 必须是不含凭据、路径或查询参数的 HTTPS 项目地址');
  }
  // 保活只需要公开 anon/publishable key，明确拒绝误填管理权限密钥。
  let publicKey = key.startsWith('sb_publishable_');
  if (!publicKey && key.split('.').length === 3) {
    try { publicKey = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role === 'anon'; } catch { /* invalid key */ }
  }
  if (!publicKey) throw new Error('保活只允许 anon/publishable key，请勿使用 service_role、secret key 或管理令牌');
  return { url, key };
}

export async function checkSupabase({
  config = readSupabaseConfig(), fetchImpl = fetch, authOnly = false,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)), retries = 2,
} = {}) {
  async function request(path, init = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetchImpl(config.url + path, {
          ...init, redirect: 'error', signal: AbortSignal.timeout(15000),
          headers: { apikey: config.key, Authorization: 'Bearer ' + config.key, ...init.headers },
        });
        if ((response.status === 429 || response.status >= 500) && attempt < retries) {
          await response.text();
          await sleep(1000 * (attempt + 1));
          continue;
        }
        if (!response.ok) {
          if (response.status === 404 && path.includes('/rpc/')) {
            throw new Error('健康检查函数不存在：请在 Supabase SQL Editor 执行 supabase/migrations/20261027000000_reunion_healthcheck.sql');
          }
          if (response.status === 401 || response.status === 403) throw new Error('Supabase 拒绝公开密钥或函数权限，请检查项目配置与 SQL 授权');
          throw new Error(`Supabase ${path} 返回 HTTP ${response.status}；请在控制台检查休眠、恢复进度或服务故障`);
        }
        try { return await response.json(); }
        catch { throw new Error('Supabase 返回了无效 JSON，不能确认服务健康'); }
      } catch (error) {
        // 只重试网络失败；HTTP 错误与配置错误保留明确诊断，不打印请求头或响应正文。
        if ((error.name === 'TimeoutError' || error.name === 'TypeError') && attempt < retries) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        if (error.name === 'TimeoutError' || error.name === 'TypeError') throw new Error('无法连接 Supabase（网络或超时），请检查网络与项目控制台');
        throw error;
      }
    }
  }
  const auth = await request('/auth/v1/settings');
  if (!auth || typeof auth !== 'object' || typeof auth.external?.email !== 'boolean') {
    throw new Error('Auth 配置响应不完整，不能确认邮箱登录状态');
  }
  if (!auth.external.email) throw new Error('Supabase 邮箱登录已关闭，请检查 Authentication 的 Email provider');
  if (authOnly) return { auth: true, database: false };
  const database = await request('/rest/v1/rpc/reunion_healthcheck', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  if (database?.ok !== true || !Number.isFinite(Date.parse(database.checked_at))) {
    throw new Error('数据库健康检查响应不符合约定，不能确认保活成功');
  }
  return { auth: true, database: true, checkedAt: database.checked_at };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkSupabase({ authOnly: process.argv.includes('--auth-only') });
    console.log(result.database ? `Supabase Auth 与数据库检查通过：${result.checkedAt}` : 'Auth 可用；未检查数据库，这次不能视为数据库保活成功');
    console.log('此检查不发送验证码，也不代表 SMTP 投递已经验证。');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
