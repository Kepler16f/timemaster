/* ===== 共同空闲计算：数据全在本机，纯函数，无 UI 依赖 =====
   口径（界面提示里写明）：只统计「普通日程」占用——班/休标记是出勤标注不是占用；
   全天日程视为占满整个时间窗；一条空档 = 所选成员此刻都没事。 */
(function () {
  'use strict';

  function toMin(hm) {
    const p = String(hm || '').split(':');
    return (+p[0] || 0) * 60 + (+p[1] || 0);
  }

  /* 一个空间里选中成员的忙碌区间：[{date, s, e}]（分钟）。归属判定顺着退休记录走 */
  function busyOf(data, fromStr, toStr, memberIds, winStart, winEnd) {
    const busy = [];
    if (!data || !data.events) return busy;
    const want = new Set((memberIds || []).map(String));
    if (!want.size) return busy;
    const resolve = (window.Store && Store.resolve) ? (d, id) => Store.resolve(d, id) : (d, id) => id;
    Object.keys(data.events).forEach((id) => {
      const ev = data.events[id];
      if (!want.has(String(resolve(data, ev.ownerId)))) return;
      if (ev.type === 'work' || ev.type === 'rest') return; // 假勤标记不算占用
      IcsParser.expandOccurrences(ev, fromStr, toStr).forEach((ds) => {
        if (ev.allDay || !ev.start) {
          busy.push({ date: ds, s: winStart, e: winEnd });
          return;
        }
        const s = toMin(ev.start);
        let e = ev.end ? toMin(ev.end) : Math.min(s + 60, 1440);
        if (e <= s) e = 1440; // 跨零点画到当天末尾（与时间轴同口径）
        busy.push({ date: ds, s, e });
      });
    });
    return busy;
  }

  /* spaces: [{data, members:[身份键]}]；opts: {from, to, dayStart, dayEnd, minDur}
     返回 [{date, slots:[{s,e,sMin,eMin}]}]（只有天窗口内的空档，短于 minDur 的被滤掉） */
  function slots(spaces, opts) {
    const dayStart = opts.dayStart != null ? opts.dayStart : 8 * 60;
    const dayEnd = opts.dayEnd != null ? opts.dayEnd : 22 * 60;
    const minDur = opts.minDur || 30;
    const dates = [];
    for (let d = IcsParser.parseDate(opts.from); IcsParser.dstr(d) <= opts.to; d.setDate(d.getDate() + 1)) {
      dates.push(IcsParser.dstr(d));
      if (dates.length > 62) break; // 两个月的窗口到顶，防误操作
    }
    let busy = [];
    (spaces || []).forEach((sp) => { busy = busy.concat(busyOf(sp.data, opts.from, opts.to, sp.members, dayStart, dayEnd)); });
    return dates.map((ds) => {
      const day = busy.filter((b) => b.date === ds)
        .map((b) => [Math.max(b.s, dayStart), Math.min(b.e, dayEnd)])
        .filter((iv) => iv[1] > iv[0])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const merged = [];
      day.forEach((iv) => {
        const last = merged[merged.length - 1];
        if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
        else merged.push([iv[0], iv[1]]);
      });
      const out = [];
      let cur = dayStart;
      merged.forEach(([s, e]) => {
        if (s > cur) out.push([cur, s]);
        cur = Math.max(cur, e);
      });
      if (cur < dayEnd) out.push([cur, dayEnd]);
      return {
        date: ds,
        slots: out
          .filter(([s, e]) => e - s >= minDur)
          .map(([s, e]) => ({ sMin: s, eMin: e, s: hm(s), e: hm(e) })),
      };
    });
  }

  function hm(min) { return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }

  window.FreeTime = { slots, busyOf };
})();
