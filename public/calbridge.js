/* ===== 系统日历桥（仅壳内可用）：协议见 ROADMAP 第三节 ===== */
(function () {
  'use strict';

  const Cal = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AndroidCalendar) || null;

  async function ensurePermission() {
    if (!Cal) throw new Error('系统日历同步需在 App 内使用');
    try {
      await Cal.ensurePermission();
    } catch (e) {
      const err = new Error('未获得日历权限：请在系统设置 → 应用 → 时间管理大师 → 权限中开启「日历」');
      err.needSettings = true;
      throw err;
    }
  }

  function openSettings() { if (Cal) Cal.openSettings(); }

  /* 拉取系统日程 → 空间事件格式（sourceUid 去重已内建） */
  async function fetchEvents(fromMs, toMs) {
    const r = await Cal.fetchEvents({ from: fromMs, to: toMs });
    return (r.events || []).map((e) => ({
      title: e.title, date: e.date, endDate: e.endDate || undefined,
      allDay: !!e.allDay, start: e.start || '', end: e.end || '',
      desc: e.desc || '', location: e.location || '',
      rrule: e.rruleStr ? IcsParser.parseRRule(e.rruleStr) : undefined,
      sourceUid: e.sourceUid,
    }));
  }

  /* 回写：全量 upsert + 删除未传入项（原生侧维护映射，只动本 App 的条目） */
  async function writeBack(events) {
    return Cal.sync({
      events: events.map((e) => ({
        id: e.id, title: e.title, date: e.date, endDate: e.endDate || '',
        allDay: !!e.allDay, start: e.start || '', end: e.end || '',
        desc: e.desc || '', location: e.location || '',
        rruleStr: e.rrule ? IcsParser.rruleToString(e.rrule) : '',
      })),
    });
  }

  window.CalBridge = { available: () => !!Cal, ensurePermission, fetchEvents, writeBack, openSettings };
})();
