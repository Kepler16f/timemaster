/* ===== ICS 解析（前移自 server.js）：保存原始事件 + RRULE，渲染时按月展开，控制网盘文件体积 ===== */
(function () {
  'use strict';

  function pad2(n) { return String(n).padStart(2, '0'); }
  function dstr(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }

  function parseDt(val, params) {
    let v = (val || '').trim();
    const isUTC = v.endsWith('Z');
    const v2 = v.replace(/Z$/, '');
    const isDate = /VALUE=DATE/i.test(params || '') || /^\d{8}$/.test(v2);
    if (isDate) {
      return { date: `${v2.slice(0, 4)}-${v2.slice(4, 6)}-${v2.slice(6, 8)}`, time: '', allDay: true };
    }
    const y = +v2.slice(0, 4), mo = +v2.slice(4, 6), d = +v2.slice(6, 8);
    const hh = +v2.slice(9, 11), mm = +v2.slice(11, 13);
    if (isUTC) {
      const dt = new Date(Date.UTC(y, mo - 1, d, hh, mm, +(v2.slice(13, 15) || '00')));
      return { date: dstr(dt), time: `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`, allDay: false };
    }
    return { date: `${y}-${pad2(mo)}-${pad2(d)}`, time: `${pad2(hh)}:${pad2(mm)}`, allDay: false };
  }

  function parseRRule(line) {
    const o = {};
    (line || '').split(';').forEach((p) => {
      const i = p.indexOf('=');
      if (i > -1) o[p.slice(0, i).toUpperCase()] = p.slice(i + 1);
    });
    if (!o.FREQ) return null;
    const r = {
      freq: o.FREQ.toUpperCase(),
      interval: parseInt(o.INTERVAL || '1', 10) || 1,
      count: o.COUNT ? parseInt(o.COUNT, 10) : null,
      until: null, byDay: null, byMonthDay: null,
    };
    if (o.UNTIL) {
      const u = o.UNTIL.replace(/Z$/, '');
      r.until = parseDate(u.slice(0, 4) + '-' + u.slice(4, 6) + '-' + u.slice(6, 8));
    }
    if (o.BYDAY) r.byDay = o.BYDAY.split(',').map((s) => s.replace(/^[+-]?\d+/, ''));
    if (o.BYMONTHDAY) r.byMonthDay = o.BYMONTHDAY.split(',').map(Number);
    return r;
  }

  /* 解析 .ics 文本 → 原始事件数组（不展开循环） */
  function parseICS(text) {
    const lines = [];
    (text || '').split(/\r\n|\n|\r/).forEach((raw) => {
      if (/^[ \t]/.test(raw) && lines.length) lines[lines.length - 1] += raw.slice(1);
      else if (raw.trim() !== '') lines.push(raw);
    });
    const events = [];
    let inEvent = false, cur = null;
    for (const line of lines) {
      if (/^BEGIN:VEVENT$/i.test(line)) {
        inEvent = true;
        cur = { title: '未命名日程', desc: '', location: '', rrule: null, uid: null, start: null, end: null };
        continue;
      }
      if (/^END:VEVENT$/i.test(line)) {
        if (inEvent && cur && cur.start) {
          const ev = {
            title: cur.title, date: cur.start.date, allDay: cur.start.allDay,
            start: cur.start.allDay ? '' : cur.start.time,
            end: cur.start.allDay ? '' : (cur.end ? cur.end.time : ''),
            desc: cur.desc, location: cur.location, rrule: cur.rrule, sourceUid: cur.uid,
          };
          // 全天跨多日：记录结束日（DTEND 排他），供渲染逐日出现
          if (cur.start.allDay && cur.end && cur.end.allDay) {
            const e = parseDate(cur.end.date); e.setDate(e.getDate() - 1);
            if (e > parseDate(cur.start.date)) ev.endDate = dstr(e);
          }
          events.push(ev);
        }
        inEvent = false; cur = null; continue;
      }
      if (!inEvent || !cur) continue;
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const head = line.slice(0, idx), key = head.split(';')[0].toUpperCase(), val = line.slice(idx + 1);
      if (key === 'SUMMARY') cur.title = val.replace(/\\[nN]/g, '\n') || '未命名日程';
      else if (key === 'DESCRIPTION') cur.desc = val.replace(/\\[nN]/g, '\n');
      else if (key === 'LOCATION') cur.location = val;
      else if (key === 'UID') cur.uid = val;
      else if (key === 'RRULE') cur.rrule = parseRRule(val);
      else if (key === 'DTSTART') cur.start = parseDt(val, head);
      else if (key === 'DTEND') cur.end = parseDt(val, head);
    }
    return events;
  }

  /* 渲染期展开：给定原始事件与日期区间 [from,to]（含），返回出现的日期列表。
     仅按日/周/月/年粗匹配，忽略 COUNT 的精确截断（以 until 与 400 天上限兜底）。 */
  const DAYMAP = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  function expandOccurrences(ev, fromStr, toStr) {
    const out = [];
    const from = parseDate(fromStr), to = parseDate(toStr);
    const start = parseDate(ev.date);
    const r = ev.rrule;
    if (!r) {
      const spanEnd = parseDate(ev.endDate || ev.date);
      for (let d = new Date(Math.max(start, from)); d <= spanEnd && d <= to; d.setDate(d.getDate() + 1)) {
        out.push(dstr(d));
      }
      return out;
    }
    if (r.until && r.until < from) return out;
    const effTo = r.until && r.until < to ? r.until : to;
    const interval = r.interval || 1;
    const startWeekday = start.getDay();
    const monday = new Date(start); monday.setDate(monday.getDate() - ((startWeekday + 6) % 7));
    // 从 max(start, from - 400天) 向后扫描，日频以上限 400 次实例
    const scanFrom = new Date(Math.max(start, from.getTime() - 400 * 86400000));
    let n = 0;
    for (let d = new Date(scanFrom); d <= effTo && n < 400; d.setDate(d.getDate() + 1)) {
      let hit = false;
      if (r.freq === 'DAILY') {
        hit = Math.round((d - start) / 86400000) % interval === 0;
      } else if (r.freq === 'WEEKLY') {
        const dm = new Date(d); dm.setDate(dm.getDate() - ((dm.getDay() + 6) % 7));
        const weeks = Math.round((dm - monday) / (7 * 86400000));
        if (weeks >= 0 && weeks % interval === 0) {
          hit = r.byDay ? r.byDay.some((b) => DAYMAP[b] === d.getDay()) : d.getDay() === startWeekday;
        }
      } else if (r.freq === 'MONTHLY') {
        if (r.byMonthDay) hit = r.byMonthDay.some((md) => md > 0 && d.getDate() === Math.min(md, daysInMonth(d)));
        else hit = d.getDate() === start.getDate();
        const months = (d.getFullYear() - start.getFullYear()) * 12 + (d.getMonth() - start.getMonth());
        if (hit && months % interval !== 0) hit = false;
      } else if (r.freq === 'YEARLY') {
        hit = d.getMonth() === start.getMonth() && d.getDate() === start.getDate()
          && (d.getFullYear() - start.getFullYear()) % interval === 0;
      }
      if (hit && d >= start && d >= from) { out.push(dstr(d)); n++; }
    }
    return out;
  }
  function daysInMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); }

  window.IcsParser = { parseICS, parseRRule, rruleToString, expandOccurrences, dstr, parseDate };

  function rruleToString(r) {
    if (!r) return '';
    let s = 'FREQ=' + r.freq + ';INTERVAL=' + (r.interval || 1);
    if (r.byDay && r.byDay.length) s += ';BYDAY=' + r.byDay.join(',');
    if (r.byMonthDay && r.byMonthDay.length) s += ';BYMONTHDAY=' + r.byMonthDay.join(',');
    if (r.count) s += ';COUNT=' + r.count;
    if (r.until) s += ';UNTIL=' + IcsParser.dstr(r.until) + 'T235959';
    return s;
  }
})();
