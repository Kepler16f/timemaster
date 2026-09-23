import { calendarManager } from '@kit.CalendarKit';
import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';

const TM_PREFIX = 'TimeMaster:';
const DAY_MS = 86400000;
/* CalendarKit 的 napi 层按字面量取键名，用数字常量避开不同 SDK 版本枚举名差异 */
const EVENT_TYPE_NORMAL = 0;
/* READ_WHOLE_CALENDAR 是受限开放权限（API 20 起才对普通应用开放，且要签名 profile 带 ACL），
   常规构建没声明它，去请求会连累普通权限一起失败。CI 的实验构建分支会把这里改成 true 再构建。 */
const WHOLE_CAL = false;

interface BizErr {
  message?: string;
  code?: number;
}

function errText(e: Object): string {
  const b: BizErr = e as Object as BizErr;
  const code: string = b.code === undefined ? '' : '[' + String(b.code) + '] ';
  return code + (b.message ? b.message : String(e));
}

/* CalendarKit 抛出的原生错误只有 "invalid arg[0]" 这类笼统措辞，
   不标注调用点就没法定位是读、删还是写出的问题 */
async function labeled<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new Error(label + '失败：' + errText(e as Object));
  }
}

/* EventFilter 是带静态工厂的类，napi 侧对入参做 napi_unwrap：
   传 { timeRange, calendarType } 这种对象字面量必然报 [23900001] invalid arg[0], i.e. invalid keys! */
function timeFilter(fromMs: number, toMs: number): calendarManager.EventFilter {
  return calendarManager.EventFilter.filterByTime(fromMs, toMs);
}

interface LocShape {
  location?: string;
}

interface CalStat {
  name: string;
  events: number;
  error: string;
}

interface FetchDebug {
  calendars: CalStat[];
  scanned: number;
  skipped: number;
}

interface EvShape {
  id?: number;
  title?: string;
  type?: number;
  startTime?: number;
  endTime?: number;
  description?: string;
  isAllDay?: boolean;
  location?: LocShape;
}

interface WireEv {
  id?: string;
  title?: string;
  date?: string;
  endDate?: string;
  allDay?: boolean;
  start?: string;
  end?: string;
  desc?: string;
  location?: string;
  rruleStr?: string;
}

interface WirePayload {
  events?: WireEv[];
}

interface OutEv {
  id?: string;
  title: string;
  date: string;
  endDate?: string;
  allDay: boolean;
  start: string;
  end: string;
  desc: string;
  location: string;
  sourceUid: string;
}

function pad(n: number): string {
  return n < 10 ? '0' + n : '' + n;
}

function toDateStr(ms: number): string {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function toHmStr(ms: number): string {
  const d = new Date(ms);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function fromLocal(dateStr: string, hm: string): number {
  const ps = (dateStr || '').split('-');
  const hs = (hm || '00:00').split(':');
  const d = new Date(Number(ps[0]), Number(ps[1]) - 1, Number(ps[2]),
    hs.length > 1 ? Number(hs[0]) : 0, hs.length > 1 ? Number(hs[1]) : 0, 0, 0);
  return d.getTime();
}

/* 事件对象按键名逐个拼：空 location 之类的多余字段是 CalendarKit 参数校验的常见雷区 */
function buildEvent(title: string, w: WireEv, marker: string, startMs: number, endMs: number): calendarManager.Event {
  const ev: Record<string, Object> = {
    'title': title,
    'type': EVENT_TYPE_NORMAL,
    'startTime': startMs,
    'endTime': endMs,
    'description': marker + '|' + (w.desc || ''),
  };
  if (w.allDay) {
    ev['isAllDay'] = true;
  }
  const loc: string = w.location || '';
  if (loc.length > 0) {
    const l: Record<string, Object> = { 'location': loc };
    ev['location'] = l;
  }
  return ev as Object as calendarManager.Event;
}

function getCal(ctx: common.UIAbilityContext): Promise<calendarManager.Calendar> {
  const mgr = calendarManager.getCalendarManager(ctx);
  return labeled('获取日历实例', () => mgr.getCalendar());
}

/* getAllCalendars() 才是「用户能看到的那些日历」；getCalendar() 拿到的是
   本应用首次写入时自动建的默认日历，用户在系统日历 App 里建的日程全都不在里面 */
async function allCals(ctx: common.UIAbilityContext): Promise<calendarManager.Calendar[]> {
  const mgr = calendarManager.getCalendarManager(ctx);
  try {
    const list = await mgr.getAllCalendars();
    if (list.length > 0) {
      return list;
    }
  } catch (e) {
    console.warn('getAllCalendars failed, fallback to default calendar: ' + errText(e as Object));
  }
  return [await getCal(ctx)];
}

function calName(cal: calendarManager.Calendar): string {
  try {
    const acc = cal.getAccount();
    const dn: string = acc.displayName || '';
    if (dn.length > 0) {
      return dn;
    }
    const n: string = acc.name || '';
    return n.length > 0 ? n : '未命名日历';
  } catch (e) {
    return '取日历名失败';
  }
}

export class HarmonyCalendar {
  static async ensure(ctx: common.UIAbilityContext | null): Promise<void> {
    if (ctx === null) {
      throw new Error('上下文未就绪');
    }
    const at = abilityAccessCtrl.createAtManager();
    const perms: Permissions[] = ['ohos.permission.READ_CALENDAR', 'ohos.permission.WRITE_CALENDAR'];
    const r = await at.requestPermissionsFromUser(ctx, perms);
    const ok = r.authResults.length > 0 && r.authResults.every((x: number) => x === 0);
    if (!ok) {
      throw new Error('未获得日历权限');
    }
    if (WHOLE_CAL) {
      /* 实验构建才走到这里：再要一次「读取全部日历」。拿不到（profile 没带 ACL、用户拒绝）也只记日志，
         退化成「只能读本应用自己写的日程」，与常规构建行为一致 */
      const whole: Permissions[] = [('ohos.permission.READ_WHOLE_CALENDAR' as Object) as Permissions];
      try {
        await at.requestPermissionsFromUser(ctx, whole);
      } catch (e) {
        console.warn('whole calendar permission unavailable: ' + errText(e as Object));
      }
    }
  }

  static async fetch(ctx: common.UIAbilityContext | null, fromMs: number, toMs: number): Promise<string> {
    if (ctx === null) {
      throw new Error('上下文未就绪');
    }
    const cals = await allCals(ctx);
    const out: OutEv[] = [];
    const stats: CalStat[] = [];
    const seen = new Set<string>();
    let skipped = 0;
    for (const cal of cals) {
      const label: string = calName(cal);
      const stat: CalStat = { name: label, events: 0, error: '' };
      let list: calendarManager.Event[] = [];
      try {
        list = await cal.getEvents(timeFilter(fromMs, toMs));
      } catch (e) {
        /* 单个日历读不动（无权限、别的 App 的日历被系统挡下…）不能连累其它日历 */
        stat.error = errText(e as Object);
        stats.push(stat);
        continue;
      }
      for (const raw of list) {
        const e = raw as Object as EvShape;
        const st = e.startTime;
        if (!st) {
          continue;
        }
        const key: string = label + ':' + String(e.id);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const en = e.endTime || st;
        const dur = en - st;
        const allDay = e.isAllDay === true || (dur >= DAY_MS - 1000 && new Date(st).getHours() === 0);
        const descRaw = e.description || '';
        let desc = descRaw;
        if (descRaw.startsWith(TM_PREFIX)) {
          const bar = descRaw.indexOf('|');
          desc = bar >= 0 ? descRaw.substring(bar + 1) : '';
          skipped++;
        }
        const item: OutEv = {
          title: e.title || '未命名',
          date: toDateStr(st),
          allDay: allDay,
          start: allDay ? '' : toHmStr(st),
          end: allDay ? '' : toHmStr(en),
          desc: desc,
          location: e.location?.location || '',
          sourceUid: 'hos:' + String(e.id),
        };
        if (allDay && dur > DAY_MS + 1000) {
          item.endDate = toDateStr(en - 1);
        }
        out.push(item);
        stat.events++;
      }
      stats.push(stat);
    }
    const debug: FetchDebug = { calendars: stats, scanned: stats.length, skipped: skipped };
    return JSON.stringify({ events: out, debug: debug });
  }

  static async writeBack(ctx: common.UIAbilityContext | null, payloadJson: string): Promise<string> {
    if (ctx === null) {
      throw new Error('上下文未就绪');
    }
    const payload = JSON.parse(payloadJson) as WirePayload;
    const list: WireEv[] = payload.events || [];
    const cal = await getCal(ctx);
    const now = Date.now();
    const existing = await labeled('读取本应用已有日程',
      () => cal.getEvents(timeFilter(now - 750 * DAY_MS, now + 750 * DAY_MS)));

    /* 只认自己写过的那批（description 以 TimeMaster: 开头），别人的日程一律不动 */
    const mine: EvShape[] = [];
    for (const raw of existing) {
      const e = raw as Object as EvShape;
      if ((e.description || '').startsWith(TM_PREFIX) && typeof e.id === 'number') {
        mine.push(e);
      }
    }
    const wanted = new Set<string>();
    for (const w of list) {
      wanted.add(TM_PREFIX + (w.id || ''));
    }

    const fails: string[] = [];
    let removed = 0;
    for (const m of mine) {
      const marker: string = (m.description || '').split('|')[0];
      if (wanted.has(marker) || typeof m.id !== 'number') {
        continue;
      }
      const staleId: number = m.id;
      try {
        await labeled('清理旧日程', () => cal.deleteEvent(staleId));
        removed++;
      } catch (e) {
        fails.push(errText(e as Object));
      }
    }

    let upserted = 0;
    for (const w of list) {
      const marker: string = TM_PREFIX + (w.id || '');
      const title: string = w.title || '未命名';
      const startMs = w.allDay
        ? fromLocal(w.date || toDateStr(now), '00:00')
        : fromLocal(w.date || toDateStr(now), w.start || '00:00');
      let endMs = w.allDay
        ? (w.endDate ? fromLocal(w.endDate, '00:00') + DAY_MS - 1000 : startMs + DAY_MS - 1000)
        : (w.end ? fromLocal(w.date || toDateStr(now), w.end) : startMs + 3600000);
      if (endMs <= startMs) {
        endMs += DAY_MS;
      }
      try {
        await labeled('写入「' + title + '」', () => cal.addEvent(buildEvent(title, w, marker, startMs, endMs)));
        upserted++;
        /* 先写后删：中途失败时旧条目还在，不会两头落空 */
        for (const m of mine) {
          if ((m.description || '').split('|')[0] === marker && typeof m.id === 'number') {
            const oldId: number = m.id;
            try {
              await labeled('替换旧日程', () => cal.deleteEvent(oldId));
              removed++;
            } catch (e) {
              fails.push(errText(e as Object));
            }
          }
        }
      } catch (e) {
        fails.push(errText(e as Object));
      }
    }
    return JSON.stringify({
      upserted: upserted,
      removed: removed,
      failed: fails.length,
      error: fails.length > 0 ? fails[0] : '',
    });
  }

  static async openSettings(ctx: common.UIAbilityContext | null): Promise<void> {
    if (ctx === null) {
      throw new Error('上下文未就绪');
    }
    const params: Record<string, Object> = {
      'pushParam': { 'bundleName': ctx.abilityInfo.bundleName } as Record<string, string>,
    };
    await ctx.startAbility({
      bundleName: 'com.huawei.hmos.settings',
      abilityName: 'com.huawei.hmos.settings.MainAbility',
      uri: 'application_info_entry',
      parameters: params,
    });
  }
}
