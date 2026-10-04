/* ===== 小组件数据推送：把「今天的日程」交给原生壳画在桌面卡片上 =====
   Android=NativeWidget 插件（存偏好 + 重画 RemoteViews）；
   鸿蒙=__HarmonyNative.widgetData（存偏好 + formProvider 刷新服务卡片）；
   浏览器里没有壳，payload 只落在 localStorage 备查。推送失败一律安静。 */
(function () {
  'use strict';

  function capPlugin() {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeWidget) || null;
  }
  function harmony() {
    const o = window.__HarmonyNative;
    return o && typeof o.widgetData === 'function' ? o : null;
  }

  /* payload: { date:'10月4日 周日', space:'家', items:[{time:'09:00', title:'晨会', color:'#f0463a'}] } */
  async function push(payload) {
    const p = payload || { items: [] };
    try {
      const cap = capPlugin();
      if (cap) { await cap.update({ payload: JSON.stringify(p) }); return true; }
      const h = harmony();
      if (h) { await window.Transport.harmonyCall('widgetData', [JSON.stringify(p)]); return true; }
    } catch (e) { /* 卡片是附赠品，失败不影响主流程 */ }
    try { localStorage.setItem('tm:widgetPayload', JSON.stringify(p)); } catch (e) { /* noop */ }
    return false;
  }

  window.Widget = { push };
})();
