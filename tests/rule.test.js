/* RRULE COUNT 精确截断：窗口外的历史出现必须占名额，翻到后面的月份不能「又活过来」 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const win = {};
win.window = win;
vm.createContext(win);
win.Lunar = undefined;
fs.readFileSync; // 保 lint 安静
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'ics.js'), 'utf8'), win, { filename: 'ics.js' });

const { expandOccurrences } = win.IcsParser;
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

const daily = (date, count) => ({ date, rrule: { freq: 'DAILY', interval: 1, count: count || null, until: null, byDay: null, byMonthDay: null } });
const weekly = (date, count) => ({ date, rrule: { freq: 'WEEKLY', interval: 1, count: count || null, until: null, byDay: null, byMonthDay: null } });

/* 1. 经典回归：9-01 起「重复 10 次」——最后一个实例是 9-10。
      翻到 10 月的窗口必须一条不出（老实现从窗口前 400 天数起，这里会重新发满 10 条） */
eq('count: 10 次止于 09-10',
  expandOccurrences(daily('2026-09-01', 10), '2026-09-01', '2026-09-30'),
  ['2026-09-01','2026-09-02','2026-09-03','2026-09-04','2026-09-05','2026-09-06','2026-09-07','2026-09-08','2026-09-09','2026-09-10']);
eq('count: 之后的月份不再复活',
  expandOccurrences(daily('2026-09-01', 10), '2026-10-01', '2026-10-31'),
  []);
eq('count: 窗口横跨截止点只留窗口内的',
  expandOccurrences(daily('2026-09-01', 10), '2026-09-08', '2026-10-05'),
  ['2026-09-08','2026-09-09','2026-09-10']);

/* 2. 每周共 5 次：从 8-03（周一）数 5 个周一 = 8-03/10/17/24/31，9 月的周一一条不出 */
eq('count: 每周 5 次止于 08-31',
  expandOccurrences(weekly('2026-08-03', 5), '2026-08-01', '2026-09-30'),
  ['2026-08-03','2026-08-10','2026-08-17','2026-08-24','2026-08-31']);

/* 3. COUNT 与 UNTIL 同存：先到的那个赢（RFC 语义），截断仍在 */
eq('count: COUNT 比 UNTIL 早时 COUNT 赢',
  expandOccurrences({ date: '2026-09-01', rrule: { freq: 'DAILY', interval: 1, count: 3, until: '2026-09-30', byDay: null, byMonthDay: null } }, '2026-09-01', '2026-12-31'),
  ['2026-09-01','2026-09-02','2026-09-03']);

/* 4. 无 COUNT 的老行为不能坏：窗口起点前 400 天扫描 + 400 实例上限照旧 */
eq('count: 无 COUNT 时窗口照常展开',
  expandOccurrences(daily('2026-09-01', null), '2026-09-01', '2026-09-03').length, 3);
const far = expandOccurrences(daily('2019-01-01', null), '2026-10-01', '2026-10-05');
eq('count: 老事件无 COUNT 仍按窗口出（扫描回看得够远）', far.length, 5);

/* 5. 起始日之后的窗口 + 小 COUNT：一次不落全在窗口外，返回空 */
eq('count: 窗口整体在截断之后返回空',
  expandOccurrences(daily('2026-01-01', 2), '2026-06-01', '2026-06-30'),
  []);

/* 6. 边界：窗口从 start 前一格开扫时，start 当天必须占第 1 次名额 */
eq('count: start 早于窗口时名额照扣',
  expandOccurrences(daily('2026-05-30', 4), '2026-06-01', '2026-06-30'),
  ['2026-06-01','2026-06-02']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
