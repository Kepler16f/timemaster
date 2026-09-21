/* ===== 系统日历桥（仅壳内可用）：Android=Capacitor 插件，鸿蒙=__HarmonyNative 代理 ===== */
(function () {
  'use strict';

  const Cal = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AndroidCalendar) || null;
  const isHar = () => !!(window.Transport && window.Transport.hasHarmony);

  async function ensurePermission() {
    if (Cal) {
      try { await Cal.ensurePermission(); }
      catch (e) {
        const err = new Error('未获得日历权限：请在系统设置 → 应用 → 时间管理大师 → 权限中开启「日历」');
        err.needSettings = true;
        throw err;
      }
      return;
    }
    if (isHar()) {
      try { await Transport.harmonyCall('calEnsure', []); }
      catch (e) {
        const err = new Error('未获得日历权限：请在系统设置 → 应用 → 时间管理大师 → 权限中开启「日历」');
        err.needSettings = true;
        throw err;
      }
      return;
    }
    throw new Error('系统日历同步需在 App 内使用');
  }

  function openSettings() {
    if (Cal) { Cal.openSettings(); return; }
    if (isHar()) Transport.harmonyCall('calOpen', []).catch(() => {});
  }

  function mapEvent(e) {
    return {
      title: e.title, date: e.date, endDate: e.endDate || undefined,
      allDay: !!e.allDay, start: e.start || '', end: e.end || '',
      desc: e.desc || '', location: e.location || '',
      rrule: e.rruleStr ? IcsParser.parseRRule(e.rruleStr) : undefined,
      sourceUid: e.sourceUid,
    };
  }

  /* 拉取系统日程 → 空间事件格式（sourceUid 去重已内建） */
  async function fetchEvents(fromMs, toMs) {
    let events;
    if (Cal) events = (await Cal.fetchEvents({ from: fromMs, to: toMs })).events || [];
    else if (isHar()) {
      const r = await Transport.harmonyCall('calFetch', [String(fromMs), String(toMs)]);
      events = (r && r.events) || [];
    } else throw new Error('系统日历同步需在 App 内使用');
    return events.map(mapEvent);
  }

  function wire(ev) {
    return {
      id: ev.id, title: ev.title, date: ev.date, endDate: ev.endDate || '',
      allDay: !!ev.allDay, start: ev.start || '', end: ev.end || '',
      desc: ev.desc || '', location: ev.location || '',
      rruleStr: ev.rrule ? IcsParser.rruleToString(ev.rrule) : '',
    };
  }

  /* 回写：全量 upsert + 删除未传入项（原生侧维护映射，只动本 App 的条目） */
  async function writeBack(events) {
    if (Cal) return Cal.sync({ events: events.map(wire) });
    if (isHar()) return await Transport.harmonyCall('calWrite', [JSON.stringify({ events: events.map(wire) })]);
    throw new Error('系统日历同步需在 App 内使用');
  }

  window.CalBridge = { available: () => !!(Cal || isHar()), ensurePermission, fetchEvents, writeBack, openSettings };
})();
