/* ===== Auth：Supabase(GoTrue) 邮箱验证码登录，零 SDK 直连 REST；登录前后可用本地身份 ===== */
(function () {
  'use strict';

  const SUPA_KEY = 'tm:auth:supa';
  const SESSION_KEY = 'tm:auth:session';

  function cfg() { try { return JSON.parse(localStorage.getItem(SUPA_KEY)) || null; } catch (e) { return null; } }
  function setSupabase(url, anon) {
    if (!/^https?:\/\//i.test(url || '')) url = 'https://' + url;
    localStorage.setItem(SUPA_KEY, JSON.stringify({ url: (url || '').trim().replace(/\/+$/, ''), anon: (anon || '').trim() }));
  }
  function session() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch (e) { return null; } }
  function saveSession(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
  function clear() { localStorage.removeItem(SESSION_KEY); }

  function ready() { const c = cfg(); return !!(c && c.url && c.anon); }

  async function req(path, body, token) {
    if (!ready()) throw new Error('请先填写 Supabase 地址与 anon key');
    const c = cfg();
    const headers = { 'Content-Type': 'application/json', apikey: c.anon };
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = await Transport.request({ method: 'POST', url: c.url + '/auth/v1' + path, headers, body: JSON.stringify(body) });
    let j = null; try { j = JSON.parse(r.text); } catch (e) { /* noop */ }
    if (r.status >= 400) {
      const m = j && (j.error_description || j.msg || (j.error && (j.error.msg || j.error.message))) || ('HTTP ' + r.status);
      throw new Error('登录服务：' + m);
    }
    return j || {};
  }

  /* 发送 6 位邮箱验证码（需 Supabase 控制台 Email 登录勾选 One-time tokens） */
  async function sendOtp(email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) throw new Error('邮箱格式不对');
    return req('/otp', { email: email.toLowerCase(), create_user: true });
  }

  async function verifyOtp(email, token) {
    const j = await req('/verify', { email: (email || '').toLowerCase(), token: (token || '').trim(), type: 'email' });
    if (!j.access_token || !j.user) throw new Error('验证码不正确或已过期');
    const s = { access_token: j.access_token, refresh_token: j.refresh_token, uid: j.user.id, email: (email || '').toLowerCase(), at: Date.now() };
    saveSession(s);
    return s;
  }

  async function refresh() {
    const s = session();
    if (!s) return null;
    try {
      const j = await req('/token?grant_type=refresh_token', { refresh_token: s.refresh_token });
      if (!j.access_token) return s;
      const n = Object.assign({}, s, { access_token: j.access_token, refresh_token: j.refresh_token || s.refresh_token, at: Date.now() });
      saveSession(n);
      return n;
    } catch (e) { return s; } // 弱网时保持现有会话
  }

  /* 空间成员身份键：已登录=账户（跨设备一致），未登录=设备 */
  function memberKey() { const s = session(); return s && s.uid ? 'u:' + s.uid : App.clientId; }
  function loggedIn() { return !!session(); }

  window.Auth = { cfg, setSupabase, ready, sendOtp, verifyOtp, refresh, session, clear, memberKey, loggedIn };
})();
