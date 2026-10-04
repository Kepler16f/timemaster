/* ===== 变更通知桥：把「别人改了日程」送到系统通知 =====
   Android=NativeNotify 插件；鸿蒙=__HarmonyNative.notify；桌面=Tauri 自定义 command；
   浏览器=Web Notification。任何一步不可用都安静返回 false，绝不打扰。 */
(function () {
  'use strict';

  function tauriInvoke() {
    const c = window.__TAURI__ && window.__TAURI__.core;
    return c && typeof c.invoke === 'function' ? c.invoke : null;
  }
  function capPlugin() {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeNotify) || null;
  }
  function harmony() {
    const o = window.__HarmonyNative;
    return o && typeof o.notify === 'function' ? o : null;
  }

  async function notify({ title, body, tag }) {
    const t = String(title || ''), b = String(body || ''), g = String(tag || 'reunion');
    try {
      const cap = capPlugin();
      if (cap) { await cap.show({ title: t, body: b, tag: g }); return true; }
      const h = harmony();
      if (h) { await window.Transport.harmonyCall('notify', [JSON.stringify({ title: t, body: b, tag: g })]); return true; }
      const inv = tauriInvoke();
      if (inv) { await inv('notify', { title: t, body: b }); return true; }
      if (typeof Notification !== 'undefined') {
        if (Notification.permission === 'granted') { new Notification(t, { body: b, tag: g }); return true; }
        if (Notification.permission === 'denied') return false;
        try {
          const r = await Notification.requestPermission();
          if (r !== 'granted') return false;
          new Notification(t, { body: b, tag: g }); return true;
        } catch (e) { return false; }
      }
    } catch (e) { /* 通知是锦上添花，失败保持安静 */ }
    return false;
  }

  window.Notify = {
    notify,
    available: () => !!(capPlugin() || harmony() || tauriInvoke() || (typeof Notification !== 'undefined')),
  };
})();
