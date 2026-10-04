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
      r.until = `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`;
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
    let inEvent = false, inAlarm = false, cur = null;
    for (const line of lines) {
      if (/^BEGIN:VEVENT$/i.test(line)) {
        inEvent = true;
        cur = { title: '未命名日程', desc: '', location: '', type: null, rrule: null, uid: null, start: null, end: null, rem: 0 };
        continue;
      }
      if (/^END:VEVENT$/i.test(line)) {
        if (inEvent && cur && cur.start) {
          const ev = {
            title: cur.title, date: cur.start.date, allDay: cur.start.allDay,
            start: cur.start.allDay ? '' : cur.start.time,
            end: cur.start.allDay ? '' : (cur.end ? cur.end.time : ''),
            desc: cur.desc, location: cur.location, rrule: cur.rrule, sourceUid: cur.uid,
            type: cur.type === 'work' || cur.type === 'rest' ? cur.type : 'normal',
          };
          if (cur.rem > 0) ev.rem = cur.rem;
          // 全天跨多日：记录结束日（DTEND 排他），供渲染逐日出现
          if (cur.start.allDay && cur.end && cur.end.allDay) {
            const e = parseDate(cur.end.date); e.setDate(e.getDate() - 1);
            if (e > parseDate(cur.start.date)) ev.endDate = dstr(e);
          }
          events.push(ev);
        }
        inEvent = false; cur = null; continue;
      }
      if (/^BEGIN:VALARM$/i.test(line)) { inAlarm = true; continue; }
      if (/^END:VALARM$/i.test(line)) { inAlarm = false; continue; }
      if (!inEvent || !cur) continue;
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const head = line.slice(0, idx), key = head.split(';')[0].toUpperCase(), val = line.slice(idx + 1);
      if (inAlarm) {
        /* 只认「提前 n 分钟」的负时长提醒（-PT30M / -P1D 都收成分钟）；
           开始之后的提醒没有意义，正时长一律忽略 */
        if (key === 'TRIGGER') cur.rem = Math.max(0, triggerMinutes(val));
        continue;
      }
      if (key === 'SUMMARY') cur.title = icalUnesc(val) || '未命名日程';
      else if (key === 'DESCRIPTION') cur.desc = icalUnesc(val);
      else if (key === 'LOCATION') cur.location = icalUnesc(val);
      else if (key === 'X-REUNION-TYPE') cur.type = val.trim().toLowerCase();
      else if (key === 'UID') cur.uid = val;
      else if (key === 'RRULE') cur.rrule = parseRRule(val);
      else if (key === 'DTSTART') cur.start = parseDt(val, head);
      else if (key === 'DTEND') cur.end = parseDt(val, head);
    }
    return events;
  }

  /* 渲染期展开：给定原始事件与日期区间 [from,to]（含），返回出现的日期列表。
     按日/周/月/年匹配，UNTIL 与 COUNT 都生效；实例数另受 400 次上限兜住，
     免得「每天」的日程一路展开到几年后的月份里去看不到、还白扫上千次。 */
  const DAYMAP = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  /* UNTIL 在云端 JSON 里往返过一次就是 ISO 字符串（'2026-12-31T00:00:00.000Z'），
     本机新建的是 'YYYY-MM-DD'，老数据里还可能有 Date 对象 —— 三种都收成 'YYYY-MM-DD'。
     收成字符串后再比大小才是对的：Date 对象和字符串用 < 比会走数值转换得出 NaN，
     结果「直到某天」在同步过的设备上悄悄不生效，日程一路展开到天荒地老。 */
  function untilStr(u) {
    if (!u) return null;
    // 认 Date 不能靠 instanceof：鸿蒙/安卓的 WebView 与宿主脚本可能不同 realm，instanceof 直接失认
    if (typeof u === 'object' && typeof u.getFullYear === 'function') return dstr(u);
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(u));
    return m ? m[0] : null;
  }

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
    const until = untilStr(r.until);
    if (until && until < fromStr) return out;
    const effTo = until && until < toStr ? parseDate(until) : to;
    const interval = r.interval || 1;
    const count = r.count ? parseInt(r.count, 10) : 0;
    const startWeekday = start.getDay();
    const monday = new Date(start); monday.setDate(monday.getDate() - ((startWeekday + 6) % 7));
    // 从 max(start, from - 400天) 向后扫描，日频以上限 400 次实例
    const scanFrom = new Date(Math.max(start, from.getTime() - 400 * 86400000));
    let n = 0, seen = 0;
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
        if (r.lunar && window.Lunar) {
          /* 农历每年：把两端公历都转成农历月日再比对。闰月出生的人只在有同序号闰月的年份过生日，
             平年直接不过——宁可空着也不挪到别的日子。相邻两次出现的公历年份恰好都差 1，
             所以 interval 按「公历年份差」数与按农历年数完全等价 */
          const ls = Lunar.solar2lunar(start.getFullYear(), start.getMonth() + 1, start.getDate());
          const lc = ls ? Lunar.solar2lunar(d.getFullYear(), d.getMonth() + 1, d.getDate()) : null;
          hit = !!ls && !!lc && lc.m === ls.m && lc.d === ls.d && lc.leap === ls.leap
            && d.getFullYear() >= start.getFullYear()
            && (d.getFullYear() - start.getFullYear()) % interval === 0;
        } else {
          hit = d.getMonth() === start.getMonth() && d.getDate() === start.getDate()
            && (d.getFullYear() - start.getFullYear()) % interval === 0;
        }
      }
      if (!hit || d < start) continue;
      // COUNT 从最初那次出现数起，不是从当前窗口数起：窗口外的历史出现照样占名额，
      // 否则翻到后面的月份时，一条「共 10 次」的日程又活过来了
      seen++;
      if (count && seen > count) break;
      if (d >= from) { out.push(dstr(d)); n++; }
    }
    return out;
  }
  function daysInMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); }

  /* ---------- 序列化回 .ics（导出用）----------
     形状与 parseICS 读的保持一致：自家导出再导回，日程不该变形。
     定时事件写 TZID=<本机时区>，这样「09:00」在别人家的日历里还是 09:00；
     取不到时区（老 WebView 没有 Intl）就整体退成 UTC，绝不写个不认的时区名。 */
  function localZone() {
    try { return (Intl.DateTimeFormat().resolvedOptions().timeZone || '').trim(); } catch (e) { return ''; }
  }
  function ymd(s) { return String(s).replace(/-/g, ''); }
  function byteLen(ch) {
    const c = ch.codePointAt(0);
    return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  function icalEsc(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }
  /* 反解一次搞定：\\ \; \, 还原成本体，\n 换成换行 */
  function icalUnesc(s) {
    return String(s == null ? '' : s).replace(/\\([\\;,nN])/g, (m, c) => (c === 'n' || c === 'N') ? '\n' : c);
  }
  /* RFC 5545 每行不超过 75 字节：中文一个字占 3 字节，得按字节折行，
     又不能把一个多字节字劈成两半，所以逐字累加而不是按字符数切。 */
  function foldLines(lines) {
    const out = [];
    lines.forEach((line) => {
      let cur = '', used = 0, limit = 74;
      for (const ch of String(line)) {
        const b = byteLen(ch);
        if (used + b > limit) { out.push(cur); cur = ' ' + ch; used = 1 + b; limit = 74; }
        else { cur += ch; used += b; }
      }
      out.push(cur);
    });
    return out;
  }
  function buildICS(events, meta) {
    const tz = localZone();
    const stamp = utcCompact(new Date());
    const name = (meta && meta.name) || 'Reunion';
    const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Reunion//TimeMaster//CN',
      'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:' + icalEsc(name)];
    if (tz) L.push('X-WR-TIMEZONE:' + tz);
    (events || []).forEach((ev, i) => {
      if (!ev || !ev.date) return;
      const v = ['BEGIN:VEVENT',
        'UID:' + icalEsc((ev.sourceUid || ev.id || ('x' + i)) + '@reunion'),
        'DTSTAMP:' + stamp,
        'SUMMARY:' + icalEsc(ev.title || '未命名日程')];
      if (ev.allDay || !ev.start) {
        /* DTEND 是排他的：全天到 10 月 3 日要写成 10 月 4 日；没填时间的也按全天走 */
        v.push('DTSTART;VALUE=DATE:' + ymd(ev.date),
          'DTEND;VALUE=DATE:' + ymd(shiftDateStr(ev.endDate || ev.date, 1)));
      } else {
        v.push(tz ? 'DTSTART;TZID=' + tz + ':' + ymd(ev.date) + 'T' + hms(ev.start)
          : 'DTSTART:' + localToUtc(ev.date, ev.start));
        if (ev.end) v.push(tz ? 'DTEND;TZID=' + tz + ':' + ymd(ev.endDate || ev.date) + 'T' + hms(ev.end)
          : 'DTEND:' + localToUtc(ev.endDate || ev.date, ev.end));
      }
      if (ev.location) v.push('LOCATION:' + icalEsc(ev.location));
      if (ev.desc) v.push('DESCRIPTION:' + icalEsc(ev.desc));
      if (ev.rrule) v.push('RRULE:' + rruleOut(ev.rrule, tz));
      if (ev.rem > 0) v.push('BEGIN:VALARM', 'ACTION:DISPLAY',
        'TRIGGER:-PT' + Math.round(ev.rem) + 'M',
        'DESCRIPTION:' + icalEsc(ev.title || '日程提醒'), 'END:VALARM');
      if (ev.type === 'work' || ev.type === 'rest') v.push('CATEGORIES:' + (ev.type === 'work' ? '班' : '休'), 'X-REUNION-TYPE:' + ev.type);
      v.push('END:VEVENT');
      L.push.apply(L, foldLines(v));
    });
    L.push('END:VCALENDAR');
    return L.join('\r\n') + '\r\n';
  }
  function hms(t) { return String(t || '00:00').replace(/:/g, '') + '00'; }
  /* RFC 5545 时长：-P1DT1H30M / -PT90M → 分钟。认不得的形状返回 0（不提醒） */
  function triggerMinutes(val) {
    const m = /^-?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/i.exec(String(val || '').trim());
    if (!m) return 0;
    const neg = String(val).trim().charAt(0) === '-';
    const min = ((+m[1] || 0) * 10080) + ((+m[2] || 0) * 1440) + ((+m[3] || 0) * 60) + (+m[4] || 0);
    return neg ? min : 0;
  }
  function shiftDateStr(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return dstr(d); }
  function utcCompact(d) {
    return '' + d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate())
      + 'T' + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z';
  }
  function localToUtc(dateStr, time) {
    const hm = String(time || '00:00').split(':');
    const d = parseDate(dateStr);
    d.setHours(+hm[0] || 0, +hm[1] || 0, 0, 0);
    return utcCompact(d);
  }
  /* 导出时的 RRULE：UNTIL 必须带 Z 且为 UTC（和 DTSTART 同一坐标系），
     界面上存的「直到某天」是本机日期的 23:59:59，转一次才不越界。 */
  function rruleOut(r, tz) {
    let s = rruleToString(r).replace(/;UNTIL=\d{8}T\d{6}$/, '');
    const u = untilStr(r.until);
    if (u) s += ';UNTIL=' + (tz ? localToUtc(u, '23:59') : u.replace(/-/g, '') + 'T235959Z');
    return s;
  }

  window.IcsParser = { parseICS, parseRRule, rruleToString, expandOccurrences, dstr, parseDate, untilStr, DAYMAP, buildICS, localZone };

  function rruleToString(r) {
    if (!r) return '';
    let s = 'FREQ=' + r.freq + ';INTERVAL=' + (r.interval || 1);
    if (r.byDay && r.byDay.length) s += ';BYDAY=' + r.byDay.join(',');
    if (r.byMonthDay && r.byMonthDay.length) s += ';BYMONTHDAY=' + r.byMonthDay.join(',');
    if (r.count) s += ';COUNT=' + r.count;
    const u = untilStr(r.until);
    if (u) s += ';UNTIL=' + u.replace(/-/g, '') + 'T235959';
    return s;
  }
})();
