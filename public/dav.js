/* ===== WebDAV 客户端（坚果云等，走 Transport 原生桥）=====
   网盘配置不再只有一个全局账号：本机默认账号（设置页表单）用来新建空间，
   每个空间另有一份绑定（tm:davBySpace）。家人用配置码进来时，只把配置码里的
   账号绑到那个空间上，不会把本机账号顶掉——否则一粘配置码，自己原来的空间
   就读不到了（表现为「同步不上新加入的人」）。 */
(function () {
  'use strict';

  const LS_KEY = 'tm:davConfig';     // 本机默认账号
  const LS_SPACE = 'tm:davBySpace';  // code -> 该空间实际存放的账号
  const LS_ACCTS = 'tm:davAccounts'; // baseUrl|user -> 用过的账号（含密码），供跨设备空间扫描复用

  function normalizeBase(u) {
    u = (u || '').trim();
    if (!u) return u;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
    u = u.replace(/\/+$/, '');
    // 有人习惯把同步目录本身贴进地址栏，去掉以免出现 /shared-calendar/shared-calendar
    return u.replace(/\/shared-calendar$/i, '');
  }
  function clean(c) {
    return c ? { baseUrl: normalizeBase(c.baseUrl), user: (c.user || '').trim(), pass: c.pass || '' } : c;
  }
  function usable(c) { return !!(c && c.baseUrl && c.user && c.pass); }

  function cfg() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || null; } catch (e) { return null; }
  }
  function saveConfig(c) {
    c = clean(c);
    localStorage.setItem(LS_KEY, JSON.stringify(c));
    rememberAccount(c);
  }

  function spaceMap() {
    try { return JSON.parse(localStorage.getItem(LS_SPACE)) || {}; } catch (e) { return {}; }
  }
  function saveSpaceMap(m) { localStorage.setItem(LS_SPACE, JSON.stringify(m)); }

  /* 空间存在哪个网盘上：有绑定用绑定，没有（老版本加入的）退回本机默认账号 */
  function spaceCfg(code) {
    const c = code && spaceMap()[String(code).toUpperCase()];
    return c || cfg();
  }
  function bindSpace(code, c) {
    if (!code || !usable(c)) return;
    const m = spaceMap(); const k = String(code).toUpperCase();
    const next = clean(c);
    const cur = m[k];
    if (cur && cur.baseUrl === next.baseUrl && cur.user === next.user) return;
    m[k] = next;
    saveSpaceMap(m);
    rememberAccount(next);
  }
  /* 首次同步成功时把自己当时用的账号钉住：之后用户改默认账号也不会把这个空间带走 */
  function autoBind(code) {
    const k = code && String(code).toUpperCase();
    if (!k || spaceMap()[k]) return;
    bindSpace(k, cfg());
  }
  function unbindSpace(code) {
    const m = spaceMap(); delete m[String(code).toUpperCase()]; saveSpaceMap(m);
  }
  function isDefaultAcct(code) { // 该空间就用本机默认账号，无需在界面上特别标注
    const c = spaceMap()[String((code || '').toUpperCase())];
    if (!c) return true;
    const d = cfg() || {};
    return c.baseUrl === normalizeBase(d.baseUrl) && c.user === (d.user || '');
  }
  function sameAccount(a, b) {
    if (!a || !b) return false;
    return normalizeBase(a.baseUrl) === normalizeBase(b.baseUrl) && (a.user || '') === (b.user || '');
  }
  /* 界面上一眼认出「这份数据在哪个网盘账号上」：用户名 + 网盘主机名里最能代表服务的那一段
     （dav.jianguoyun.com 只写 jianguoyun，写成 me@x.com@dav 谁看得懂） */
  function hostLabel(u) {
    const parts = String(u || '').replace(/^https?:\/\//i, '').split('/')[0].split('.');
    let i = 0;
    while(/^(dav|www|api|web)$/i.test(parts[i]) && parts.length - i > 2) i++;
    return parts[i] || '?';
  }
  function acctLabelOf(c) { return ((c && c.user) || '?') + '@' + hostLabel(c && c.baseUrl); }
  function acctLabel(code) { return acctLabelOf(spaceCfg(code) || {}); }
  /* 账号的稳定身份标识：写进成员记录，用来认「谁和创建者用的是同一个网盘账号」。
     取哈希而不是原文——成员表是所有人都能读的，别把账号名再抄一份进去 */
  function acctId(code) {
    const c = spaceCfg(code);
    if (!usable(c)) return '';
    const s = normalizeBase(c.baseUrl).toLowerCase() + '|' + String(c.user).toLowerCase();
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x1000193) >>> 0; }
    return 'a' + h.toString(16);
  }

  function accounts() {
    try { return JSON.parse(localStorage.getItem(LS_ACCTS)) || {}; } catch (e) { return {}; }
  }
  function acctKey(c) { return (normalizeBase(c.baseUrl) + '|' + (c.user || '')).toLowerCase(); }
  function rememberAccount(c) {
    if (!usable(c)) return;
    const m = accounts(); const k = acctKey(c);
    m[k] = Object.assign(m[k] || {}, clean(c));
    localStorage.setItem(LS_ACCTS, JSON.stringify(m));
  }
  /* 去重后的全部已知账号：默认账号排在前，扫描空间时先试自己的 */
  function knownAccounts() {
    const out = []; const seen = {};
    [cfg()].concat(Object.keys(accounts()).map((k) => accounts()[k])).forEach((c) => {
      if (!usable(c)) return;
      const k = acctKey(c);
      if (seen[k]) return;
      seen[k] = 1; out.push(clean(c));
    });
    return out;
  }

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

  function needCfg(c) {
    if (!usable(c)) throw new Error('还没配置网盘账号（设置 → 网盘同步，或粘贴家人的配置码）');
    return c;
  }
  function urlFor(c, path) {
    const base = (needCfg(c).baseUrl || '').replace(/\/+$/, '');
    return base + path.split('/').map(encodeURIComponent).join('/');
  }
  function authHeaders(c) {
    const c2 = needCfg(c);
    return { Authorization: Transport.basicAuth(c2.user, c2.pass) };
  }

  /* GET：带 If-None-Match 时可能返回 304（零流量） */
  async function get(code, etag) {
    const c = spaceCfg(code);
    const headers = authHeaders(c);
    if (etag) headers['If-None-Match'] = etag;
    const r = await safeRequest({ method: 'GET', url: urlFor(c, '/shared-calendar/' + code + '.json'), headers });
    if (r.status === 404) return { status: 404 };
    if (r.status === 304) return { status: 304 };
    if (r.status === 401) throw new Error('网盘账号或应用密码错误（401）：' + acctLabel(code));
    if (r.status !== 200) throw new Error('读取网盘失败 HTTP ' + r.status);
    return { status: 200, etag: findHeader(r.headers, 'etag'), text: r.text };
  }

  /* PUT：etag 传字符串=If-Match 防覆盖；传 null=仅新建(If-None-Match: *)；传 undefined=无条件覆盖 */
  async function put(code, text, etag) {
    const c = spaceCfg(code);
    const headers = Object.assign(authHeaders(c), { 'Content-Type': 'application/json; charset=utf-8' });
    if (etag === null) headers['If-None-Match'] = '*';
    else if (etag) headers['If-Match'] = etag;
    const r = await safeRequest({
      method: 'PUT', url: urlFor(c, '/shared-calendar/' + code + '.json'), headers, body: text,
    });
    if (r.status === 412) return { status: 412 };           // 冲突：他端已更新
    if (r.status === 401) throw new Error('网盘账号或应用密码错误（401）：' + acctLabel(code));
    if (r.status === 409) { await ensureDir(code); return put(code, text, etag); } // 目录不存在则补建重试
    if (r.status !== 200 && r.status !== 201 && r.status !== 204) throw new Error('写入网盘失败 HTTP ' + r.status);
    return { status: r.status, etag: findHeader(r.headers, 'etag') };
  }

  async function ensureDir(code) {
    const c = spaceCfg(code);
    await safeRequest({ method: 'MKCOL', url: urlFor(c, '/shared-calendar/'), headers: authHeaders(c) });
  }

  /* 删除云端空间文件（清空原有数据） */
  async function remove(code) {
    const c = spaceCfg(code);
    const r = await safeRequest({ method: 'DELETE', url: urlFor(c, '/shared-calendar/' + code + '.json'), headers: authHeaders(c) });
    if (r.status === 401) throw new Error('网盘鉴权失败 (401)');
    if (r.status !== 200 && r.status !== 202 && r.status !== 204 && r.status !== 205 && r.status !== 404) {
      throw new Error('清空云端失败 HTTP ' + r.status);
    }
    return true;
  }

  /* 连接测试：MKCOL(容忍405) + PROPFIND 根目录；code 传入时测的是那个空间绑定的账号 */
  async function test(code) {
    const c = code ? spaceCfg(code) : cfg();
    const r = await safeRequest({
      method: 'PROPFIND', url: urlFor(c, '/'),
      headers: Object.assign(authHeaders(c), { Depth: '0' }),
    });
    if (r.status === 401) throw new Error('账号或应用密码错误 (401)');
    if (r.status !== 207 && r.status !== 405) throw new Error('网盘连接失败 HTTP ' + r.status);
    await ensureDir(code);
    return true;
  }

  /* 列出同步目录下的空间文件名（PROPFIND Depth:1，只看一层） */
  async function listCodes(c) {
    const r = await safeRequest({
      method: 'PROPFIND', url: urlFor(c, '/shared-calendar/'),
      headers: Object.assign(authHeaders(c), { Depth: '1' }),
    });
    if (r.status === 401 || r.status === 403) throw new Error('网盘账号或应用密码错误（401）');
    if (r.status !== 207 && r.status !== 405) throw new Error('列目录失败 HTTP ' + r.status);
    const out = [];
    /* 坚果云返回 <d:href>/dav/shared-calendar/AB12CD34.json，域名不同、前缀不同，只认末段文件名 */
    const re = /<(?:\w+:)?href[^>]*>([^<]*)<\/(?:\w+:)?href>/gi;
    let m;
    while ((m = re.exec(r.text || ''))) {
      const tail = decodeURIComponent(m[1].replace(/\/+$/, '').split('/').pop() || '');
      const mm = /^([0-9A-Za-z_-]{4,32})\.json$/.exec(tail);
      if (mm && out.indexOf(mm[1].toUpperCase()) < 0) out.push(mm[1].toUpperCase());
    }
    return out;
  }

  /* 本机已知账号能读到的全部空间码（去重），失败的那个账号跳过而不是整体报错 */
  async function scanCodes(onProgress) {
    const found = {};
    const errs = [];
    for (const c of knownAccounts()) {
      try {
        const list = await listCodes(c);
        list.forEach((code) => { if (!(code in found)) found[code] = c; });
        if (onProgress) onProgress(c, Object.keys(found).length);
      } catch (e) { errs.push(acctLabelOf(c) + '：' + e.message); }
    }
    return { codes: found, errors: errs };
  }

  /* 用某个已知账号读一个空间（临时切过去读，不动本机绑定） */
  async function getWith(c, code) {
    const r = await safeRequest({
      method: 'GET', url: urlFor(c, '/shared-calendar/' + code + '.json'), headers: authHeaders(c),
    });
    if (r.status !== 200) throw new Error('读取网盘失败 HTTP ' + r.status);
    return { status: 200, etag: findHeader(r.headers, 'etag'), text: r.text };
  }
  async function saveWith(c, code, text) {
    const headers = Object.assign(authHeaders(c), { 'Content-Type': 'application/json; charset=utf-8' });
    const r = await safeRequest({ method: 'PUT', url: urlFor(c, '/shared-calendar/' + code + '.json'), headers, body: text });
    if (r.status !== 200 && r.status !== 201 && r.status !== 204) throw new Error('写入网盘失败 HTTP ' + r.status);
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
    const c = spaceCfg(spaceCode);
    if (!usable(c)) throw new Error('请先填全网盘配置');
    const o = { b: c.baseUrl, u: c.user, p: c.pass };
    if (spaceCode) o.c = spaceCode;
    return 'TM1:' + b64encode(JSON.stringify(o));
  }

  /* 只解析、不落盘：是否设为本机默认账号、绑到哪个空间由调用方决定（见 app.js） */
  function parseCode(text) {
    let s = (text || '').trim();
    if (s.startsWith('TM1:')) s = s.slice(4);
    let o = null;
    try { o = JSON.parse(b64decode(s)); } catch (e) { /* fallthrough */ }
    if (!o || !o.b || !o.u || !o.p) throw new Error('配置码无法识别，请确认完整粘贴');
    return { cfg: clean({ baseUrl: o.b, user: o.u, pass: o.p }), spaceCode: (o.c || '').toUpperCase() || null };
  }
  /* 老版本行为：直接把配置码写成本机默认账号（保留给外部调用，内部不再用） */
  function importCode(text) {
    const r = parseCode(text);
    saveConfig(r.cfg);
    return { spaceCode: r.spaceCode };
  }

  window.Dav = {
    cfg, saveConfig, get, put, remove, ensureDir, test, exportCode, importCode, parseCode,
    spaceCfg, bindSpace, unbindSpace, autoBind, isDefaultAcct, acctLabel, sameAccount,
    knownAccounts, rememberAccount, listCodes, scanCodes, getWith, saveWith, usable, acctLabelOf, acctId, normalizeBase,
  };
})();
