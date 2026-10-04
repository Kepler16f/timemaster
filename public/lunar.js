/* ===== 农历换算（1900–2049）：公历→农历月日/干支/生肖，供月历显示与「农历每年重复」展开 =====
   压缩表是历法界流传最广的那一份（每年一个整数：低 4 位=闰月月份，0x10000=闰月大小，
   其余 12 位自高到低是正月至腊月各自大小月）。范围外返回 null，界面留空、不猜。 */
(function () {
  'use strict';

  var LUNAR_INFO = [
    0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, /* 1900-1909 */
    0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, /* 1910-1919 */
    0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, /* 1920-1929 */
    0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, /* 1930-1939 */
    0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, /* 1940-1949 */
    0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, /* 1950-1959 */
    0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, /* 1960-1969 */
    0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6, /* 1970-1979 */
    0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, /* 1980-1989 */
    0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0, /* 1990-1999 */
    0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, /* 2000-2009 */
    0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, /* 2010-2019 */
    0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, /* 2020-2029 */
    0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, /* 2030-2039 */
    0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0  /* 2040-2049 */
  ];
  var YEAR_MIN = 1900, YEAR_MAX = 1900 + LUNAR_INFO.length - 1;

  function leapMonth(y) { return LUNAR_INFO[y - YEAR_MIN] & 0xf; }
  function leapDays(y) { return leapMonth(y) ? ((LUNAR_INFO[y - YEAR_MIN] & 0x10000) ? 30 : 29) : 0; }
  function monthDays(y, m) { return (LUNAR_INFO[y - YEAR_MIN] & (0x10000 >> m)) ? 30 : 29; }
  function yearDays(y) {
    var sum = 348;
    for (var i = 0x8000; i > 0x8; i >>= 1) sum += (LUNAR_INFO[y - YEAR_MIN] & i) ? 1 : 0;
    return sum + leapDays(y);
  }

  var MONTH_ZH = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '腊'];
  var DAY_TENS = ['初', '十', '廿', '三'];
  var DAY_NUMS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  var GAN = '甲乙丙丁戊己庚辛壬癸';
  var ZHI = '子丑寅卯辰巳午未申酉戌亥';
  var ANIMALS = '鼠牛虎兔龙蛇马羊猴鸡狗猪';

  function monthName(m, leap) { return (leap ? '闰' : '') + MONTH_ZH[m - 1] + '月'; }
  function dayName(d) {
    if (d === 10) return '初十';
    if (d === 20) return '二十';
    if (d === 30) return '三十';
    return DAY_TENS[Math.floor((d - 1) / 10)] + DAY_NUMS[(d - 1) % 10];
  }

  /* 农历节日（按农历月日定）：月历上用节日名替换「初一/十五」这类常规标注 */
  var LUNAR_FESTIVALS = { '1-1': '春节', '1-15': '元宵', '5-5': '端午', '7-7': '七夕', '8-15': '中秋', '9-9': '重阳', '12-8': '腊八' };

  var BASE = new Date(1900, 0, 31); /* 该日 = 1900 年正月初一 */

  /* 公历 → 农历。y/m/d 为公历；超范围或入参非法返回 null */
  function solar2lunar(y, m, d) {
    if (!(y >= YEAR_MIN + 1 && y <= YEAR_MAX) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
    var date = new Date(y, m - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
    var offset = Math.round((new Date(y, m - 1, d) - BASE) / 86400000);
    if (offset < 0) return null;
    var year = YEAR_MIN;
    for (;;) {
      var dy = yearDays(year);
      if (offset < dy) break;
      offset -= dy;
      year++;
      if (year > YEAR_MAX) return null;
    }
    var leap = leapMonth(year);
    var month = 0;
    for (;;) {
      month++;
      var len = monthDays(year, month);
      if (offset < len) {
        return pack(year, month, offset + 1, false);
      }
      offset -= len;
      if (leap > 0 && month === leap) {
        var ll = leapDays(year);
        if (offset < ll) return pack(year, month, offset + 1, true);
        offset -= ll;
      }
      if (month >= 12) return null;
    }
  }
  function pack(y, m, d, leap) {
    return {
      y: y, m: m, d: d, leap: leap,
      monthText: monthName(m, leap),
      dayText: dayName(d),
      /* 干支生肖以农历年为准（立春分界是算命的说法，这里从正月初一） */
      yearText: GAN.charAt((y - 4) % 10) + ZHI.charAt((y - 4) % 12),
      animal: ANIMALS.charAt((y - 4) % 12),
      festival: LUNAR_FESTIVALS[m + '-' + d] && !leap ? LUNAR_FESTIVALS[m + '-' + d] : '',
    };
  }

  window.Lunar = {
    solar2lunar: solar2lunar,
    monthName: monthName,
    dayName: dayName,
    minYear: YEAR_MIN + 1,
    maxYear: YEAR_MAX,
  };
})();
