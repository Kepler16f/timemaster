/* 自动回写按空间管理，系统日历负责离线提醒；失败状态留在本机供界面明确展示。 */
(function () {
  'use strict';
  const KEY = 'tm:calendarSync';
  const running = {}, timers = {}, signatures = {}, again = {};
  function settings() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } }
  function status(code) { return Object.assign({ enabled: false, lastSync: 0, error: '' }, settings()[code] || {}, { syncing: !!running[code], available: CalBridge.available() }); }
  function save(code, patch) { const all = settings(); all[code] = Object.assign(all[code] || {}, patch); localStorage.setItem(KEY, JSON.stringify(all)); }
  function eventsFor(code, now) {
    const data = Store.get(code); if (!data) return [];
    const start = new Date(now || Date.now()); start.setDate(start.getDate() - 1);
    const end = new Date(start); end.setFullYear(end.getFullYear() + 1);
    const out = [];
    Object.values(data.events || {}).forEach((ev) => {
      if (ev.type === 'work' || ev.type === 'rest' || CalBridge.sysHandle(ev.sourceUid)) return;
      const m = data.members[Store.resolve(data, ev.ownerId)] || {};
      if (ev.rrule && (ev.rrule.lunar || Object.keys(ev.exceptions || {}).length)) {
        IcsParser.expandEvents(ev, IcsParser.dstr(start), IcsParser.dstr(end)).forEach((item) => {
          out.push(Object.assign({}, item, { id: ev.id + ':' + item.occurrenceDate, date: item.displayDate,
            endDate: null, rrule: null, ownerName: m.name || '成员' }));
        });
      } else out.push(Object.assign({}, ev, { ownerName: m.name || '成员' }));
    });
    return out;
  }
  async function sync(code, interactive) {
    if (running[code]) { again[code] = true; return running[code]; }
    if (!CalBridge.available()) throw new Error('此设备暂不支持写入系统日历，请在 Android 或 HarmonyOS App 中使用');
    if (!Store.get(code)) throw new Error('请先进入一个已有本机数据的空间');
    running[code] = (async () => {
      await Promise.resolve();
      try {
        if (interactive) await CalBridge.ensurePermission();
        const list = eventsFor(code);
        if (CalBridge.isHarmony() && list.some((ev) => ev.rem === 0)) throw new Error('此设备暂不支持准时提醒，请把提醒改成提前 10 分钟或更早');
        const signature = JSON.stringify(list);
        const result = await CalBridge.writeBack(list, code);
        if (result && (result.failed || result.upserted < list.length)) throw new Error(result.error || '部分日程未能写入，请检查日历权限后重试');
        signatures[code] = signature;
        save(code, { lastSync: Date.now(), error: '', needSettings: false });
        return result;
      } catch (e) {
        save(code, { error: e.message, needSettings: !!e.needSettings });
        throw e;
      } finally {
        delete running[code];
        if (again[code]) { delete again[code]; schedule(code); }
        if (typeof window.onReminderStatus === 'function') window.onReminderStatus(code);
      }
    })();
    return running[code];
  }
  function schedule(code) {
    if (!status(code).enabled) return;
    clearTimeout(timers[code]);
    timers[code] = setTimeout(() => {
      const data = Store.get(code);
      if (!data || data.dissolved || Store.kickedOut(code)) return;
      if (JSON.stringify(eventsFor(code)) === signatures[code]) return;
      sync(code, false).catch(() => {});
    }, 1200);
  }
  async function enable(code, enabled) {
    if (!enabled) { save(code, { enabled: false }); clearTimeout(timers[code]); return; }
    try { await CalBridge.ensurePermission(); }
    catch (e) { save(code, { error: e.message, needSettings: !!e.needSettings }); throw e; }
    save(code, { enabled: true });
    return sync(code, false);
  }
  Store.onChange(schedule);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) Store.listSpaces().forEach((s) => schedule(s.code)); });
  window.ReminderSync = { status, enable, sync: (code) => sync(code, true), schedule, eventsFor,
    current: (code) => !!signatures[code] && signatures[code] === JSON.stringify(eventsFor(code)) };
})();
