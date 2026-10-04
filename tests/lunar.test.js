/* 农历 / 节假日 / lunar RRULE 展开测试：锚点全部来自公开历表与国务院公告，钉死数据正确性 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const win = {};
win.window = win;
win.localStorage = (() => {
  const m = new Map();
  const s = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); s[k] = String(v); }, removeItem: (k) => { m.delete(k); delete s[k]; } };
  return s;
})();
vm.createContext(win);

function load(file) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8'), win, { filename: file });
}
load('lunar.js');
load('holidays.js');
load('ics.js');

const { IcsParser, Lunar, Holidays } = win;
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}
const dstr = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const lunarText = (y, m, d) => {
  const l = Lunar.solar2lunar(y, m, d);
  return l ? `${l.m}-${l.d}${l.leap ? '闰' : ''}` : null;
};

/* ---------- 1. 春节锚点（2020–2035 每年正月初一） ---------- */
const CHunjie = {
  2020: [1, 25], 2021: [2, 12], 2022: [2, 1], 2023: [1, 22], 2024: [2, 10],
  2025: [1, 29], 2026: [2, 17], 2027: [2, 6], 2028: [1, 26], 2029: [2, 13],
  2030: [2, 3], 2031: [1, 23], 2032: [2, 11], 2033: [1, 31], 2034: [2, 19], 2035: [2, 8],
};
Object.keys(CHunjie).forEach((y) => {
  const [m, d] = CHunjie[y];
  eq(`lunar: ${y} 年正月初一 = 春节`, lunarText(+y, m, d), '1-1');
});

/* ---------- 2. 端午 / 中秋 / 闰月 ---------- */
eq('lunar: 端午 2025-05-31', lunarText(2025, 5, 31), '5-5');
eq('lunar: 端午 2026-06-19', lunarText(2026, 6, 19), '5-5');
eq('lunar: 中秋 2025-10-06', lunarText(2025, 10, 6), '8-15');
eq('lunar: 中秋 2026-09-25', lunarText(2026, 9, 25), '8-15');
eq('lunar: 2023 闰二月初二', (() => { const l = Lunar.solar2lunar(2023, 3, 23); return l ? `${l.m}-${l.d}${l.leap ? '闰' : ''}` : null; })(), '2-2闰');
eq('lunar: 2025 闰六月初一', (() => { const l = Lunar.solar2lunar(2025, 7, 25); return l ? `${l.m}-${l.d}${l.leap ? '闰' : ''}` : null; })(), '6-1闰');
eq('lunar: 2028 闰五月初一', (() => { const l = Lunar.solar2lunar(2028, 6, 23); return l ? `${l.m}-${l.d}${l.leap ? '闰' : ''}` : null; })(), '5-1闰');
eq('lunar: 范围外返回 null', Lunar.solar2lunar(1899, 12, 1), null);
eq('lunar: 干支生肖 2026 丙午马', (() => { const l = Lunar.solar2lunar(2026, 2, 17); return [l.yearText, l.animal]; })(), ['丙午', '马']);
eq('lunar: 节日名标注', Lunar.solar2lunar(2026, 2, 17).festival, '春节');

/* ---------- 3. 节假日内置数据（国务院公告逐日抽查，含全部调休上班日） ---------- */
eq('holiday: 2026 国庆假期首日', Holidays.get('2026-10-01'), { name: '国庆节', off: true });
eq('holiday: 2026 国庆末日', Holidays.get('2026-10-07'), { name: '国庆节', off: true });
eq('holiday: 2026 调休上班日 09-20', Holidays.get('2026-09-20'), { name: '国庆节', off: false });
eq('holiday: 2026 调休上班日 10-10', Holidays.get('2026-10-10'), { name: '国庆节', off: false });
eq('holiday: 2026 春节调休 02-14', Holidays.get('2026-02-14'), { name: '春节', off: false });
eq('holiday: 2025 国庆中秋调休 09-28', Holidays.get('2025-09-28'), { name: '国庆节·中秋节', off: false });
eq('holiday: 未收录年份返回 null', Holidays.get('2031-05-01'), null);
eq('holiday: 普通工作日返回 null', Holidays.get('2026-10-12'), null);
eq('holiday: 年份列表', Holidays.years(), [2025, 2026]);

/* ---------- 4. 农历每年重复（rrule.lunar）展开 ---------- */
function expand(ev, from, to) { return IcsParser.expandOccurrences(ev, from, to); }
/* 2026-02-17 是正月初一：按农历每年重复 → 每年春节都出现 */
const lunarCny = { date: '2026-02-17', rrule: { freq: 'YEARLY', interval: 1, count: null, until: null, byDay: null, byMonthDay: null, lunar: true } };
eq('expand: 农历每年 = 每年正月初一',
  expand(lunarCny, '2026-01-01', '2030-12-31'),
  ['2026-02-17', '2027-02-06', '2028-01-26', '2029-02-13', '2030-02-03']);
/* 普通每年（非农历）仍是同一公历日期 */
const solarYearly = { date: '2026-02-17', rrule: { freq: 'YEARLY', interval: 1, count: null, until: null, byDay: null, byMonthDay: null } };
eq('expand: 公历每年不受 lunar 影响', expand(solarYearly, '2026-01-01', '2029-12-31'),
  ['2026-02-17', '2027-02-17', '2028-02-17', '2029-02-17']);
/* 隔年（interval=2）：用七夕（七月初七）2026-08-19 做起点，出现日必须全是农历七月初七 */
{
  const l2026 = Lunar.solar2lunar(2026, 8, 19);
  eq('lunar: 2026-08-19 是七夕', l2026 ? `${l2026.m}-${l2026.d}` : null, '7-7');
  const qixi = { date: '2026-08-19', rrule: { freq: 'YEARLY', interval: 2, count: null, until: null, byDay: null, byMonthDay: null, lunar: true } };
  const occ = expand(qixi, '2026-01-01', '2031-12-31');
  eq('expand: 七夕隔年共 3 次', occ.length, 3);
  eq('expand: 隔年出现日都是农历七月初七',
    occ.map((ds) => { const p = ds.split('-'); const l = Lunar.solar2lunar(+p[0], +p[1], +p[2]); return `${l.m}-${l.d}${l.leap ? '闰' : ''}`; }),
    ['7-7', '7-7', '7-7']);
}

/* ---------- 5. VALARM（提醒）导出与导入 ---------- */
{
  const icsText = [
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT',
    'DTSTART;TZID=Asia/Shanghai:20261005T090000', 'DTEND;TZID=Asia/Shanghai:20261005T100000',
    'SUMMARY:带提醒的日程', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT30M', 'END:VALARM',
    'UID:r1@x', 'END:VEVENT',
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20261006', 'SUMMARY:提前一天的', 'BEGIN:VALARM', 'ACTION:DISPLAY',
    'TRIGGER:-P1D', 'END:VALARM', 'UID:r2@x', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261007', 'SUMMARY:没提醒的', 'UID:r3@x', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const evs = IcsParser.parseICS(icsText);
  eq('valarm: -PT30M 收成 30 分钟', evs.find((e) => e.title === '带提醒的日程').rem, 30);
  eq('valarm: -P1D 收成 1440 分钟', evs.find((e) => e.title === '提前一天的').rem, 1440);
  eq('valarm: 没有提醒的没有 rem 键', 'rem' in (evs.find((e) => e.title === '没提醒的')), false);
  /* 导出再导回：提醒不丢 */
  const back = IcsParser.parseICS(IcsParser.buildICS(evs, { name: 'X' }));
  eq('valarm: 导出导回往返一致', back.find((e) => e.title === '带提醒的日程').rem, 30);
  eq('valarm: 导出导回 -P1D 一致', back.find((e) => e.title === '提前一天的').rem, 1440);
  eq('valarm: 无提醒的不多出 VALARM', back.find((e) => e.title === '没提醒的').rem, undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
