/* ===== 应用内更新：GitHub Releases 检查 → 原生后台下载 → 唤起系统安装 ===== */
(function () {
  'use strict';

  const REPO = 'Kepler16f/timemaster';
  const API = 'https://api.github.com/repos/' + REPO + '/releases/latest';
  const READY_KEY = 'tm:updateReady';
  const FILE_NAME = 'reunion-update.apk';

  const capUpdate = () => (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeUpdate) || null;
  const isHarmony = () => !!(window.__HarmonyNative && typeof window.__HarmonyNative.httpRequest === 'function');

  function num(v) { return String(v || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0); }
  function cmp(a, b) {
    const x = num(a), y = num(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  async function getJson(url) {
    if (window.Transport && (Transport.isNative || Transport.hasHarmony)) {
      const r = await Transport.request({ method: 'GET', url, headers: { Accept: 'application/vnd.github+json' } });
      if (r.status !== 200) throw new Error('检查更新失败 HTTP ' + r.status);
      return JSON.parse(r.text);
    }
    const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error('检查更新失败 HTTP ' + r.status);
    return r.json();
  }

  function pickUrl(assets) {
    const list = assets || [];
    const want = isHarmony() ? /\.hap(\?|$)/i : /\.apk(\?|$)/i;
    const hit = list.find((a) => want.test(a.name || '')) || list.find((a) => want.test(a.browser_download_url || ''));
    return hit ? hit.browser_download_url : (list[0] ? list[0].browser_download_url : null);
  }

  function ready() { try { return JSON.parse(localStorage.getItem(READY_KEY)) || null; } catch (e) { return null; } }
  function markReady(ver, path) { localStorage.setItem(READY_KEY, JSON.stringify({ ver, path })); }
  function clearReady() { localStorage.removeItem(READY_KEY); }

  async function check(cur) {
    const j = await getJson(API);
    const latest = String(j.tag_name || j.name || '').replace(/^v/i, '');
    const r = ready();
    return {
      cur, latest,
      hasUpdate: !!latest && cmp(latest, cur) > 0,
      notes: j.body || '',
      url: pickUrl(j.assets),
      page: j.html_url || '',
      downloaded: !!(r && latest && r.ver === latest),
      path: r ? r.path : '',
    };
  }

  /* 下载走原生 socket：WebView 自己打不开 apk 链接，也不会边下边让出界面 */
  async function download(url, onProgress) {
    const p = capUpdate();
    if (!p) {
      throw new Error(isHarmony() ? '鸿蒙暂不支持自装 HAP，请到发布页手动签名安装' : '请在 App 内使用更新功能');
    }
    if (p.addListener) { try { p.addListener('progress', (e) => { if (onProgress) onProgress(e); }); } catch (e) { /* noop */ } }
    const r = await p.download({ url, name: FILE_NAME });
    return (r && r.path) || '';
  }

  async function install(path) {
    const p = capUpdate();
    if (!p) throw new Error('当前平台不支持自动安装');
    await p.install({ path });
  }

  window.Update = { check, download, install, cmp, ready, markReady, clearReady, get canAutoInstall() { return !!capUpdate(); } };
})();
