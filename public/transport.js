/* ===== 网络传输层：壳内一律走原生桥（绕 CORS），浏览器仅作开发降级 ===== */
(function () {
  'use strict';

  const cap = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeHttp) || null;
  const har = (window.__HarmonyNative && typeof window.__HarmonyNative.httpRequest === 'function') ? window.__HarmonyNative : null;

  function b64ToText(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  }
  function textToB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin);
  }

  /* 鸿蒙 ArkWeb javaScriptProxy 桥：原生同步方法只收字符串，结果经全局回调异步回传 */
  const pending = {};
  let seq = 0;
  window.__harmonyNativeCb = function (id, err, resJson) {
    const p = pending[id];
    if (!p) return;
    delete pending[id];
    if (err) p.reject(new Error(err));
    else { try { p.resolve(resJson == null ? null : JSON.parse(resJson)); } catch (e) { p.reject(e); } }
  };
  function harmonyCall(method, args) {
    return new Promise((resolve, reject) => {
      const id = 'c' + (++seq);
      pending[id] = { resolve, reject };
      try { har[method].apply(har, [id].concat(args || [])); }
      catch (e) { delete pending[id]; reject(e); }
    });
  }

  /**
   * request({ method, url, headers, body })
   *   -> Promise<{ status, headers, text }>
   */
  async function request({ method = 'GET', url, headers = {}, body = null }) {
    let r;
    if (cap) r = await cap.request({ method, url, headers, body });
    else if (har) r = await harmonyCall('httpRequest', [JSON.stringify({ method, url, headers, body })]);
    else {
      const res = await fetch(url, { method, headers, body: body == null ? undefined : body });
      const hs = {};
      res.headers.forEach((v, k) => (hs[k] = v));
      return { status: res.status, headers: hs, text: await res.text() };
    }
    if (!r || r.error || !r.status) throw new Error((r && r.error) || '桥接请求失败');
    return { status: r.status, headers: r.headers || {}, text: r.bodyBase64 ? b64ToText(r.bodyBase64) : '' };
  }

  function basicAuth(user, pass) {
    return 'Basic ' + textToB64(user + ':' + pass);
  }

  window.Transport = { request, basicAuth, isNative: !!(cap || har), hasHarmony: !!har, harmonyCall };
})();
