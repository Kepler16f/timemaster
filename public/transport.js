/* ===== 网络传输层：壳内一律走原生桥（绕 CORS），浏览器仅作开发降级 ===== */
(function () {
  'use strict';

  const bridge = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeHttp) || null;

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

  /**
   * request({ method, url, headers, body })
   *   -> Promise<{ status, headers, text }>
   */
  async function request({ method = 'GET', url, headers = {}, body = null }) {
    if (bridge) {
      const r = await bridge.request({ method, url, headers, body });
      if (r.error || !r.status) throw new Error(r.error || '桥接请求失败');
      return { status: r.status, headers: r.headers || {}, text: r.bodyBase64 ? b64ToText(r.bodyBase64) : '' };
    }
    const res = await fetch(url, { method, headers, body: body == null ? undefined : body });
    const hs = {};
    res.headers.forEach((v, k) => (hs[k] = v));
    return { status: res.status, headers: hs, text: await res.text() };
  }

  function basicAuth(user, pass) {
    return 'Basic ' + textToB64(user + ':' + pass);
  }

  window.Transport = { request, basicAuth, isNative: !!bridge };
})();
