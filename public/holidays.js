/* ===== 法定节假日与调休 =====
   内置数据逐日来自国务院办公厅公告（holiday-cn 项目收录，papers 里是原文链接）：
   2025: https://www.gov.cn/zhengce/zhengceku/202411/content_6986383.htm
   2026: https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
   之后的年份每年 11 月才公布：设置里可以在线更新（走原生桥，无 CORS 限制），
   拉不到就用内置数据顶着——未收录的年份只显示周六日和手工班/休，绝不编造。 */
(function () {
  'use strict';

  /* {年: {off: {'MM-DD': 节日名}, work: {'MM-DD': 调休上班}}} */
  var BUILTIN = {
    2025: {
      off: {
        '01-01': '元旦', '01-28': '春节', '01-29': '春节', '01-30': '春节', '01-31': '春节',
        '02-01': '春节', '02-02': '春节', '02-03': '春节', '02-04': '春节',
        '04-04': '清明节', '04-05': '清明节', '04-06': '清明节',
        '05-01': '劳动节', '05-02': '劳动节', '05-03': '劳动节', '05-04': '劳动节', '05-05': '劳动节',
        '05-31': '端午节', '06-01': '端午节', '06-02': '端午节',
        '10-01': '国庆节·中秋节', '10-02': '国庆节·中秋节', '10-03': '国庆节·中秋节', '10-04': '国庆节·中秋节',
        '10-05': '国庆节·中秋节', '10-06': '国庆节·中秋节', '10-07': '国庆节·中秋节', '10-08': '国庆节·中秋节',
      },
      work: { '01-26': '春节', '02-08': '春节', '04-27': '劳动节', '09-28': '国庆节·中秋节', '10-11': '国庆节·中秋节' },
    },
    2026: {
      off: {
        '01-01': '元旦', '01-02': '元旦', '01-03': '元旦',
        '02-15': '春节', '02-16': '春节', '02-17': '春节', '02-18': '春节', '02-19': '春节',
        '02-20': '春节', '02-21': '春节', '02-22': '春节', '02-23': '春节',
        '04-04': '清明节', '04-05': '清明节', '04-06': '清明节',
        '05-01': '劳动节', '05-02': '劳动节', '05-03': '劳动节', '05-04': '劳动节', '05-05': '劳动节',
        '06-19': '端午节', '06-20': '端午节', '06-21': '端午节',
        '09-25': '中秋节', '09-26': '中秋节', '09-27': '中秋节',
        '10-01': '国庆节', '10-02': '国庆节', '10-03': '国庆节', '10-04': '国庆节',
        '10-05': '国庆节', '10-06': '国庆节', '10-07': '国庆节',
      },
      work: { '01-04': '元旦', '02-14': '春节', '02-28': '春节', '05-09': '劳动节', '09-20': '国庆节', '10-10': '国庆节' },
    },
  };

  var STORE_KEY = 'tm:holidays:';
  var cache = {}; // '2026' -> {off:{}, work:{}, src:'builtin'|'net'}

  function stored(year) {
    try {
      const t = JSON.parse(localStorage.getItem(STORE_KEY + year) || 'null');
      return t && (t.off || t.work) ? t : null;
    } catch (e) { return null; }
  }

  function yearData(year) {
    const key = String(year);
    if (cache[key]) return cache[key];
    const net = stored(year);
    if (net) { cache[key] = Object.assign({ src: 'net' }, net); return cache[key]; }
    const b = BUILTIN[year];
    cache[key] = b ? Object.assign({ src: 'builtin' }, b) : null;
    return cache[key];
  }

  /* '2026-10-01' -> {name, off:true|false}；未收录返回 null */
  function get(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!m) return null;
    const yd = yearData(m[1]);
    if (!yd) return null;
    const md = m[2] + '-' + m[3];
    if (yd.off && yd.off[md]) return { name: yd.off[md], off: true };
    if (yd.work && yd.work[md]) return { name: yd.work[md], off: false };
    return null;
  }

  function years() {
    const set = new Set(Object.keys(BUILTIN));
    Object.keys(localStorage).forEach((k) => {
      if (k.indexOf(STORE_KEY) === 0) set.add(k.slice(STORE_KEY.length));
    });
    return Array.from(set).map(Number).sort();
  }

  function sourceLabel(year) {
    const net = stored(year) ? '在线数据' : (BUILTIN[year] ? '内置数据' : '');
    return net;
  }

  /* holiday-cn 的 JSON -> 本地形状。数据按原样校验：isOffDay 假 = 调休上班 */
  function normalize(raw) {
    if (!raw || !Array.isArray(raw.days) || !raw.days.length) throw new Error('数据格式不对');
    const out = { off: {}, work: {} };
    raw.days.forEach((d) => {
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) return;
      const md = d.date.slice(5);
      if (d.isOffDay) out.off[md] = d.name || '节假日';
      else out.work[md] = d.name || '调休';
    });
    return out;
  }

  var CHECK_KEY = 'tm:holidayLastCheck';
  /* 启动时的静默检查：来年的安排每年 11 月中旬公布——11/12 月顺手查一次下一年，
     跨年还没手动更新过的（1–6 月、本机数据缺今年）也补查。7 天节流，失败不吭声。 */
  async function autoCheck() {
    const now = new Date(), y = now.getFullYear(), m = now.getMonth() + 1;
    const latest = years().reduce((a, b) => Math.max(a, b), 0);
    const wantNext = (m === 11 && now.getDate() >= 15) || m === 12 || (m >= 1 && m <= 6 && latest < y);
    if (!wantNext) return null;
    try { if (Date.now() - (+(localStorage.getItem(CHECK_KEY) || 0)) < 7 * 86400000) return null; } catch (e) { /* 读不了就算了 */ }
    try { localStorage.setItem(CHECK_KEY, String(Date.now())); } catch (e) { /* 存不了下次照样节流重试 */ }
    return refresh();
  }

  /* 拉指定年份（缺省 = 已收录年份里最新的下一年 + 当前年）；成功存 localStorage 并清缓存。
     返回 {saved:[年], failed:[年]}；离线/超时不算错误路径，调用方据此提示即可 */
  async function refresh(onlyYear) {
    const list = onlyYear ? [Number(onlyYear)] : years().concat(new Date().getFullYear() + 1)
      .filter((y, i, a) => a.indexOf(y) === i).sort((a, b) => b - a).slice(0, 2);
    const out = { saved: [], failed: [] };
    for (const y of list) {
      try {
        const r = await Transport.request({
          method: 'GET',
          url: 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/' + y + '.json',
        });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        const data = normalize(JSON.parse(r.text));
        localStorage.setItem(STORE_KEY + y, JSON.stringify(data));
        delete cache[String(y)];
        out.saved.push(y);
      } catch (e) { out.failed.push(y); }
    }
    return out;
  }

  window.Holidays = { get, years, refresh, autoCheck, sourceLabel, normalize };
})();
