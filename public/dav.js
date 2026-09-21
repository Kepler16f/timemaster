/* ===== WebDAV 客户端（坚果云等，走 Transport 原生桥）===== */
(function () {
  'use strict';

  const LS_KEY = 'tm:davConfig';

  function normalizeBase(u) {
    u = (u || '').trim();
    if (!u) return u;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
    return u.replace(/\/+$/, '');
  }

  function cfg() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || null; } catch (e) { return null; }
  }
  function saveConfig(c) { c = Object.assign({}, c, { baseUrl: normalizeBase(c.baseUrl) }); localStorage.setItem(LS_KEY, JSON.stringify(c)); }

  /* 网络错误 → 中文可读信息；DNS 失败时探测整机网络以区分原因 */
  async function friendly(e) {
    const m = String((e && e.message) || e || '');
    if (/resolve host|No address|ENONAME|EAI_|getaddrinfo/i.test(m)) {
      let net = false;
      try { const r = await Transport.request({ method: 'GET', url: 'https://www.baidu.com', headers: {} }); net = r.status > 0; } catch (err) { /* noop */ }
      return net
        ? '手机能上网，但解析不了网盘域名——请更换 DNS（如 223.5.5.5）或稍后重试'
        : '手机当前无法联网——请检查 WiFi/移动数据，或尝试关闭 VPN 后重试';
    }
    if (/connect|timed out|timeout|Socket/i.test(m)) return '网盘连接超时，请检查网络后重试';
    if (/CORS|NetworkError|Failed to fetch/i.test(m)) return '请求被拦截：请使用 App 内连接（原生桥不可用）';
    return m;
  }
  async function safeRequest(opts) {
    try { return await Transport.request(opts); }
    catch (e) { throw new Error(await friendly(e)); }
  }

  function urlFor(path) {
    const base = (cfg().baseUrl || '').replace(/\/+$/, '');
    return base + path.split('/').map(encodeURIComponent).join('/');
  }
  function authHeaders() {
    const c = cfg();
    const h = { Authorization: Transport.basicAuth(c.user, c.pass) };
    return h;
  }

  /* GET：带 If-None-Match 时可能返回 304（零流量） */
  async function get(code, etag) {
    const headers = authHeaders();
    if (etag) headers['If-None-Match'] = etag;
    const r = await safeRequest({ method: 'GET', url: urlFor('/shared-calendar/' + code + '.json'), headers });
    if (r.status === 404) return { status: 404 };
    if (r.status === 304) return { status: 304 };
    if (r.status !== 200) throw new Error('读取网盘失败 HTTP ' + r.status);
    return { status: 200, etag: findHeader(r.headers, 'etag'), text: r.text };
  }

  /* PUT：If-Match 防覆盖；新建用 If-None-Match: * */
  async function put(code, text, etag) {
    const headers = Object.assign(authHeaders(), { 'Content-Type': 'application/json; charset=utf-8' });
    if (etag) headers['If-Match'] = etag;
    else headers['If-None-Match'] = '*';
    const r = await safeRequest({
      method: 'PUT', url: urlFor('/shared-calendar/' + code + '.json'), headers, body: text,
    });
    if (r.status === 412) return { status: 412 };           // 冲突：他端已更新
    if (r.status === 409) { await ensureDir(); return put(code, text, etag); } // 目录不存在则补建重试
    if (r.status !== 200 && r.status !== 201 && r.status !== 204) throw new Error('写入网盘失败 HTTP ' + r.status);
    return { status: r.status, etag: findHeader(r.headers, 'etag') };
  }

  async function ensureDir() {
    await safeRequest({ method: 'MKCOL', url: urlFor('/shared-calendar/'), headers: authHeaders() });
  }

  /* 连接测试：MKCOL(容忍405) + PROPFIND 根目录 */
  async function test() {
    const r = await safeRequest({
      method: 'PROPFIND', url: urlFor('/'),
      headers: Object.assign(authHeaders(), { Depth: '0' }),
    });
    if (r.status === 401) throw new Error('账号或应用密码错误 (401)');
    if (r.status !== 207 && r.status !== 405) throw new Error('网盘连接失败 HTTP ' + r.status);
    await ensureDir();
    return true;
  }

  function findHeader(headers, name) {
    for (const k in headers) if (k.toLowerCase() === name) return headers[k];
    return null;
  }

  /* ---------- 配置码（方式 C）：打包 WebDAV 配置一键分享给家人 ---------- */
  function b64encode(s) { return btoa(String.fromCharCode(...new TextEncoder().encode(s))); }
  function b64decode(s) { return new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0))); }

  function exportCode(spaceCode) {
    const c = cfg();
    if (!c || !c.baseUrl || !c.user || !c.pass) throw new Error('请先填全网盘配置');
    const o = { b: c.baseUrl, u: c.user, p: c.pass };
    if (spaceCode) o.c = spaceCode;
    return 'TM1:' + b64encode(JSON.stringify(o));
  }

  /* 返回 { spaceCode } 或抛错；成功后配置已保存 */
  function importCode(text) {
    let s = (text || '').trim();
    if (s.startsWith('TM1:')) s = s.slice(4);
    let o = null;
    try { o = JSON.parse(b64decode(s)); } catch (e) { /* fallthrough */ }
    if (!o || !o.b || !o.u || !o.p) throw new Error('配置码无法识别，请确认完整粘贴');
    saveConfig({ baseUrl: o.b, user: o.u, pass: o.p });
    return { spaceCode: o.c || null };
  }

  window.Dav = { cfg, saveConfig, get, put, ensureDir, test, exportCode, importCode };
})();
