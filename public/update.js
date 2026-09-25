/* ===== 应用内更新：GitHub Releases 检查 → 原生后台下载 → 唤起系统安装 ===== */
(function () {
  'use strict';

  const REPO = 'Kepler16f/timemaster';
  const API = 'https://api.github.com/repos/' + REPO + '/releases/latest';
  const READY_KEY = 'tm:updateReady';
  const FILE_NAME = 'reunion-update.apk';
  /* 大陆直连 github.com 的 release 附件经常几十 KB/s 甚至握手不上，而安装包才 4 MB，
     慢在这一步而不是「检查更新」。这几个公共反代只转发 github.com/**（不代理 api.github.com），
     默认直连优先、连不上再逐个换，全程不打扰用户；哪个通了记在本地，下次从它开始试 */
  const MIRRORS = ['https://ghfast.top/', 'https://gh-proxy.com/', 'https://gh.llkk.cc/', 'https://ghproxy.net/'];
  const CHANNEL_KEY = 'tm:ghChannel';

  function dlUrls(url) {
    const saved = localStorage.getItem(CHANNEL_KEY) || '';
    const rest = MIRRORS.filter((p) => p !== saved).map((p) => p + url);
    return saved ? [saved + url, url].concat(rest) : [url].concat(rest);
  }
  function rememberChannel(u) {
    const hit = MIRRORS.find((p) => u.indexOf(p) === 0);
    if (hit) localStorage.setItem(CHANNEL_KEY, hit);
    else localStorage.removeItem(CHANNEL_KEY);
  }

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

  /* 状态码要分开说：404 多半是仓库/发布被设成私有，403 是不登录被限流（匿名 60 次/小时），
     这三种在手机上表现一模一样，用户只看到「检查失败」，说清楚才知道下一步该干什么 */
  function apiError(status, res) {
    if (status === 404) return '检查更新失败：GitHub 上找不到这个发布（HTTP 404）。仓库或 Release 被设成私有时就会出现，把仓库设为公开即可';
    if (status === 403 || status === 429) {
      const back = res && res.headers && res.headers.get && res.headers.get('x-ratelimit-reset');
      const mins = back ? Math.max(1, Math.round((Number(back) * 1000 - Date.now()) / 60000)) : 0;
      return '检查更新太频繁，GitHub 暂时限流了' + (mins ? '，大约 ' + mins + ' 分钟后再试' : '') + '（HTTP ' + status + '）';
    }
    return '检查更新失败 HTTP ' + status;
  }

  async function getJson(url) {
    if (window.Transport && (Transport.isNative || Transport.hasHarmony)) {
      const r = await Transport.request({ method: 'GET', url, headers: { Accept: 'application/vnd.github+json' } });
      if (r.status !== 200) throw new Error(apiError(r.status));
      return JSON.parse(r.text);
    }
    const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(apiError(r.status, r));
    return r.json();
  }

  /* GitHub 现在会在资产上直接给 `digest: sha256:...`，走第三方反代时拿它校一遍，
     被换包/半路截断都能当场发现，而不是等系统安装器报「解析包出错」 */
  /* 桌面四目标资产命名（desktop.yml 产出）：
     reunion-<ver>-win-x64-setup.exe / -win-arm64 / reunion_<ver>_amd64.deb / -linux-x64.AppImage … */
  function desktopAsset(list) {
    const ua = navigator.userAgent;
    const arch = /aarch64|arm64/i.test(ua) ? 'arm64' : 'x64';
    const re = /Windows/i.test(ua) ? new RegExp('-win-' + arch + '\\b', 'i')
      : new RegExp('(-linux-|_)' + arch + '\\b', 'i');
    return list.find((a) => re.test(a.name || '')) || list.find((a) => re.test(a.browser_download_url || ''));
  }

  function pickAsset(assets) {
    const list = assets || [];
    const isDesktop = !!(window.Transport && Transport.isDesktop);
    const want = isDesktop ? null : isHarmony() ? /\.hap(\?|$)/i : /\.apk(\?|$)/i;
    const hit = isDesktop ? desktopAsset(list)
      : (list.find((a) => want.test(a.name || '')) || list.find((a) => want.test(a.browser_download_url || '')));
    const url = hit ? hit.browser_download_url : (list[0] ? list[0].browser_download_url : null);
    return url ? { url, sha256: hit && /^sha256:/i.test(hit.digest || '') ? hit.digest.slice(7) : '' } : null;
  }

  function ready() { try { return JSON.parse(localStorage.getItem(READY_KEY)) || null; } catch (e) { return null; } }
  function markReady(ver, path) { localStorage.setItem(READY_KEY, JSON.stringify({ ver, path })); }
  function clearReady() { localStorage.removeItem(READY_KEY); }

  async function check(cur) {
    const j = await getJson(API);
    const latest = String(j.tag_name || j.name || '').replace(/^v/i, '');
    const r = ready();
    const asset = pickAsset(j.assets);
    return {
      cur, latest,
      hasUpdate: !!latest && cmp(latest, cur) > 0,
      notes: j.body || '',
      url: asset ? asset.url : null,
      sha256: asset ? asset.sha256 : '',
      urls: asset ? dlUrls(asset.url) : [],
      page: j.html_url || '',
      downloaded: !!(r && latest && r.ver === latest),
      path: r ? r.path : '',
    };
  }

  /* 下载走原生 socket：WebView 自己打不开 apk 链接，也不会边下边让出界面。
     一组候选地址交给原生逐个试（反代只转发 github.com/**，api.github.com 它不代理，
     所以「检查」这一步没有替代通道，只有下载能量级受益），校验不过就换下一个 */
  let progCb = null, progBound = false;
  async function download(info, onProgress) {
    const p = capUpdate();
    if (!p) {
      if (window.Transport && Transport.isDesktop) throw new Error('桌面端暂不支持壳内自动安装，请到发布页下载');
      throw new Error(isHarmony() ? '鸿蒙暂不支持自装 HAP，请到发布页手动签名安装' : '请在 App 内使用更新功能');
    }
    const urls = (info && info.urls && info.urls.length) ? info.urls : [info && info.url];
    progCb = onProgress || null;
    if (!progBound && p.addListener) {
      progBound = true; // 只绑一次，避免每下一次就多一个监听、进度被重复回调
      try { p.addListener('progress', (e) => { if (progCb) progCb(e); }); } catch (e) { progBound = false; }
    }
    const r = await p.download({ urls, url: urls[0], sha256: (info && info.sha256) || '', name: FILE_NAME });
    if (r && r.used) rememberChannel(r.used);
    return (r && r.path) || '';
  }

  async function install(path) {
    const p = capUpdate();
    if (!p) throw new Error('当前平台不支持自动安装');
    await p.install({ path });
  }

  window.Update = { check, download, install, cmp, ready, markReady, clearReady, get canAutoInstall() { return !!capUpdate(); } };
})();
