import { calendarManager } from '@kit.CalendarKit';
import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';

const TM_PREFIX = 'TimeMaster:';
const DAY_MS = 86400000;

interface EvTime {
  startTime: number;
  endTime: number;
}

interface EvShape {
  id?: number;
  title?: string;
  type?: number;
  time?: EvTime;
  description?: string;
  location?: string;
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

function getCal(ctx: common.UIAbilityContext): Promise<calendarManager.Calendar> {
  const mgr = calendarManager.getCalendarManager(ctx);
  const acc = mgr.getActiveAccount();
  return mgr.getCalendar(acc);
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
  }

  static async fetch(ctx: common.UIAbilityContext | null, fromMs: number, toMs: number): Promise<string> {
    if (ctx === null) {
      throw new Error('上下文未就绪');
    }
    const cal = await getCal(ctx);
    const filter: calendarManager.EventFilter = { timeRange: { startTime: fromMs, endTime: toMs } };
    const list = await cal.getEvents(filter);
    const out: OutEv[] = [];
    for (const raw of list) {
      const e = raw as Object as EvShape;
      const t = e.time;
      if (!t || !t.startTime) {
        continue;
      }
      const dur = (t.endTime || t.startTime) - t.startTime;
      const allDay = dur >= DAY_MS - 1000 && new Date(t.startTime).getHours() === 0;
      const descRaw = e.description || '';
      let desc = descRaw;
      if (descRaw.startsWith(TM_PREFIX)) {
        const bar = descRaw.indexOf('|');
        desc = bar >= 0 ? descRaw.substring(bar + 1) : '';
      }
      const item: OutEv = {
        title: e.title || '未命名',
        date: toDateStr(t.startTime),
        allDay: allDay,
        start: allDay ? '' : toHmStr(t.startTime),
        end: allDay ? '' : toHmStr(t.endTime || t.startTime),
        desc: desc,
        location: e.location || '',
        sourceUid: 'hos:' + String(e.id),
      };
      if (allDay && dur > DAY_MS + 1000) {
        item.endDate = toDateStr((t.endTime || t.startTime) - 1);
      }
      out.push(item);
    }
    return JSON.stringify({ events: out });
  }

  static async writeBack(ctx: common.UIAbilityContext | null, payloadJson: string): Promise<string> {
    if (ctx === null) {
      throw new Error('上下文未就绪');
    }
    const payload = JSON.parse(payloadJson) as WirePayload;
    const list: WireEv[] = payload.events || [];
    const cal = await getCal(ctx);
    const now = Date.now();
    const filter: calendarManager.EventFilter = { timeRange: { startTime: now - 750 * DAY_MS, endTime: now + 750 * DAY_MS } };
    const existing = await cal.getEvents(filter);
    const mine: calendarManager.Event[] = [];
    for (const raw of existing) {
      const e = raw as Object as EvShape;
      if ((e.description || '').startsWith(TM_PREFIX) && e.id !== undefined) {
        mine.push(raw);
      }
    }
    const wanted = new Set<string>();
    for (const w of list) {
      wanted.add(TM_PREFIX + (w.id || ''));
    }
    let removed = 0;
    for (const m of mine) {
      const shape = m as Object as EvShape;
      const marker = (shape.description || '').split('|')[0];
      if (!wanted.has(marker) && m.id !== undefined) {
        await cal.deleteEvent(m.id);
        removed++;
      }
    }
    let upserted = 0;
    for (const w of list) {
      const marker = TM_PREFIX + (w.id || '');
      for (const m of mine) {
        const shape = m as Object as EvShape;
        if ((shape.description || '').split('|')[0] === marker && m.id !== undefined) {
          await cal.deleteEvent(m.id);
        }
      }
      let startMs: number;
      let endMs: number;
      if (w.allDay) {
        startMs = fromLocal(w.date || toDateStr(now), '00:00');
        endMs = w.endDate ? fromLocal(w.endDate, '00:00') + DAY_MS - 1000 : startMs + DAY_MS - 1000;
      } else {
        startMs = fromLocal(w.date || toDateStr(now), w.start || '00:00');
        endMs = w.end ? fromLocal(w.date || toDateStr(now), w.end) : startMs + 3600000;
        if (endMs <= startMs) {
          endMs += DAY_MS;
        }
      }
      const ev: calendarManager.Event = {
        title: w.title || '未命名',
        type: calendarManager.EventType.DEFAULT,
        time: { startTime: startMs, endTime: endMs },
        description: marker + '|' + (w.desc || ''),
      };
      await cal.addEvent(ev);
      upserted++;
    }
    return JSON.stringify({ upserted: upserted, removed: removed });
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
