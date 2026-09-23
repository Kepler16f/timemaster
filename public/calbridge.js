/* ===== 系统日历桥（仅壳内可用）：Android=Capacitor 插件，鸿蒙=__HarmonyNative 代理 ===== */
(function () {
  'use strict';

  const Cal = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AndroidCalendar) || null;
  const isHar = () => !!(window.Transport && window.Transport.hasHarmony);

  async function ensurePermission() {
    if (Cal) {
      try { await Cal.ensurePermission(); }
      catch (e) {
        const err = new Error('未获得日历权限：请在系统设置 → 应用 → Reunion → 权限中开启「日历」');
        err.needSettings = true;
        throw err;
      }
      return;
    }
    if (isHar()) {
      try { await Transport.harmonyCall('calEnsure', []); }
      catch (e) {
        const err = new Error('未获得日历权限：请在系统设置 → 应用 → Reunion → 权限中开启「日历」');
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
      /* 外来日程的归属：改完要写回它原来所在的那个日历 */
      calAcct: e.calAcct || undefined, calDisp: e.calDisp || undefined,
    };
  }

  /* 系统日程的原生句柄：Android='cal:<日历id>:<事件id>'，鸿蒙='hos:<事件id>'。
     我们自建的日程没有这个前缀，返回 null 表示"改动只留在本应用里" */
  function sysHandle(uid) {
    const s = String(uid || '');
    if (s.indexOf('cal:') === 0) {
      const p = s.split(':');
      return p.length >= 3 ? { calId: p[1], id: p[2] } : null;
    }
    if (s.indexOf('hos:') === 0) {
      const id = s.substring(4);
      return /^\d+$/.test(id) ? { calId: '', id } : null;
    }
    return null;
  }

  /* 把一条外来日程的改动写回原日历：只 update，原生侧不提供删除 */
  async function editSystemEvent(ev, origMs) {
    const h = sysHandle(ev.sourceUid);
    if (!h) return false;
    const payload = {
      evId: h.id, calId: h.calId || '', calAcct: ev.calAcct || '', calDisp: ev.calDisp || '',
      origMs: origMs || 0, title: ev.title || '未命名', date: ev.date,
      endDate: ev.endDate || '', allDay: !!ev.allDay,
      start: ev.start || '', end: ev.end || '',
      desc: ev.desc || '', location: ev.location || '',
    };
    if (Cal) { await Cal.edit(payload); return true; }
    if (isHar()) { await Transport.harmonyCall('calEdit', [JSON.stringify(payload)]); return true; }
    return false;
  }

  /* 我们写回系统日历的条目都带这枚标记；再读回来时据此跳过，免得自己导自己 */
  const OWN_TAG = '[Reunion]';

  /* 拉取系统日程 → 空间事件格式（sourceUid 去重已内建）。
     返回 { events, raw, debug }：debug 是原生侧报来的「扫了哪些日历、各读到几条、哪个报错」，
     读不到东西时靠它定位，不必来回猜真机现场 */
  async function fetchEvents(fromMs, toMs) {
    let events = [], debug = null;
    if (Cal) events = (await Cal.fetchEvents({ from: fromMs, to: toMs })).events || [];
    else if (isHar()) {
      const r = await Transport.harmonyCall('calFetch', [String(fromMs), String(toMs)]);
      events = (r && r.events) || [];
      debug = (r && r.debug) || null;
    } else throw new Error('系统日历同步需在 App 内使用');
    const kept = events.filter((e) => String(e.desc || '').indexOf(OWN_TAG) < 0).map(mapEvent);
    return { events: kept, raw: events.length, debug: debug };
  }

  function wire(ev) {
    const who = ev.ownerName ? String(ev.ownerName) : '';
    const desc = [ev.desc || '', who ? `${OWN_TAG} 创建者：${who}` : ''].filter(Boolean).join('\n');
    return {
      id: ev.id, title: ev.title + (who ? `（${who}）` : ''),
      date: ev.date, endDate: ev.endDate || '',
      allDay: !!ev.allDay, start: ev.start || '', end: ev.end || '',
      desc: desc, location: ev.location || '',
      rruleStr: ev.rrule ? IcsParser.rruleToString(ev.rrule) : '',
    };
  }

  /* 回写：全量 upsert + 删除未传入项（原生侧维护映射，只动本 App 的条目） */
  async function writeBack(events) {
    if (Cal) return Cal.sync({ events: events.map(wire) });
    if (isHar()) return await Transport.harmonyCall('calWrite', [JSON.stringify({ events: events.map(wire) })]);
    throw new Error('系统日历同步需在 App 内使用');
  }

  window.CalBridge = { available: () => !!(Cal || isHar()), isHarmony: isHar, ensurePermission, fetchEvents, writeBack, openSettings, sysHandle, editSystemEvent };
})();
