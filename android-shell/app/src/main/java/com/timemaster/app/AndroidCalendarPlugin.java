package com.timemaster.app;

import android.Manifest;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;
import android.provider.CalendarContract.Calendars;
import android.provider.CalendarContract.Events;
import android.provider.Settings;

import androidx.core.app.ActivityCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;

/**
 * 系统日历桥：读取设备日历日程 + 把空间日程回写到独立日历账户「共享日程」。
 * 回写映射（spaceEventId -> systemEventId）存 SharedPreferences，删除/更新只动本 App 创建的条目。
 */
@CapacitorPlugin(
        name = "AndroidCalendar",
        permissions = {
                @Permission(alias = "calendar", strings = {
                        android.Manifest.permission.READ_CALENDAR,
                        android.Manifest.permission.WRITE_CALENDAR
                })
        }
)
public class AndroidCalendarPlugin extends Plugin {

    private static final String ACCOUNT_NAME = "timemaster";
    private static final String ACCOUNT_TYPE = "com.timemaster.app";
    private static final String PREFS = "tm_syscal";
    private static final long DAY = 86400000L;

    /**
     * 注意：Capacitor 的 Plugin.hasPermission(String) 接收的是 Android 权限字符串而不是 alias，
     * 传 alias 会永远返回 false（已授权也提示无权限），因此这里直接用系统 API 检查真实授权状态。
     */
    @PluginMethod
    public void ensurePermission(PluginCall call) {
        if (calendarGranted()) {
            call.resolve();
            return;
        }
        requestPermissionForAlias("calendar", call, "permissionCb");
    }

    @PermissionCallback
    private void permissionCb(PluginCall call) {
        if (calendarGranted()) call.resolve();
        else call.reject("未获得日历权限，请在系统设置中开启");
    }

    private boolean calendarGranted() {
        Context c = getContext();
        return ActivityCompat.checkSelfPermission(c, Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED
                && ActivityCompat.checkSelfPermission(c, Manifest.permission.WRITE_CALENDAR) == PackageManager.PERMISSION_GRANTED;
    }

    /** 跳到本 App 的系统设置页（权限被永久拒绝时引导用户手动开启） */
    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", getContext().getPackageName(), null));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public void fetchEvents(PluginCall call) {
        long from = call.getLong("from", System.currentTimeMillis() - 365 * DAY);
        long to = call.getLong("to", System.currentTimeMillis() + 365 * DAY);
        JSArray out = new JSArray();
        String[] proj = {
                Events._ID, Events.CALENDAR_ID, Events.TITLE, Events.ALL_DAY,
                Events.DTSTART, Events.DTEND, Events.RRULE,
                Events.EVENT_LOCATION, Events.DESCRIPTION,
        };
        // 查询走 view_events：该视图无 STATUS 列，取消语义对应列名为 eventStatus（3=CANCELED）
        String sel = "DTSTART > ? AND DTSTART < ? AND (eventStatus IS NULL OR eventStatus != 3) AND (DTEND > ? OR (RRULE IS NOT NULL AND RRULE != ''))";
        long floor = from - 400 * DAY; // 循环日程可能开始得很早
        try (Cursor c = getContext().getContentResolver().query(
                Events.CONTENT_URI, proj, sel,
                new String[]{String.valueOf(floor), String.valueOf(to), String.valueOf(from)}, null)) {
            SimpleDateFormat df = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            SimpleDateFormat tf = new SimpleDateFormat("HH:mm", Locale.US);
            // view_events 会为循环日程的每个实例出一行（字段相同），按事件 id 去重
            java.util.HashSet<Long> seen = new java.util.HashSet<>();
            while (c != null && c.moveToNext()) {
                long id = c.getLong(0), calId = c.getLong(1);
                if (!seen.add(id)) continue;
                boolean allDay = c.getInt(3) == 1;
                long start = c.getLong(4);
                long end = c.isNull(5) ? start : c.getLong(5);
                JSObject ev = new JSObject();
                ev.put("sourceUid", "cal:" + calId + ":" + id);
                ev.put("title", c.isNull(2) ? "未命名日程" : c.getString(2));
                ev.put("allDay", allDay);
                ev.put("date", df.format(new Date(start)));
                if (allDay) {
                    long lastDay = end > start ? end - DAY : start;
                    if (lastDay > start) ev.put("endDate", df.format(new Date(lastDay)));
                    ev.put("start", ""); ev.put("end", "");
                } else {
                    ev.put("start", tf.format(new Date(start)));
                    ev.put("end", end > start && sameDay(start, end) ? tf.format(new Date(end)) : "");
                }
                if (!c.isNull(6)) ev.put("rruleStr", c.getString(6));
                ev.put("location", c.isNull(7) ? "" : c.getString(7));
                ev.put("desc", c.isNull(8) ? "" : c.getString(8));
                out.put(ev);
            }
        } catch (Exception e) {
            call.reject("读取系统日历失败: " + e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("events", out);
        call.resolve(ret);
    }

    /** 全量同步空间日程到「共享日程」日历：upsert 传入的，删除此前同步过但未传入的 */
    @PluginMethod
    public void sync(PluginCall call) {
        JSArray events = call.getArray("events", new JSArray());
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, 0);
        long calId;
        try {
            calId = ensureCalendar();
        } catch (Exception e) {
            call.reject("创建系统日历账户失败: " + e.getMessage());
            return;
        }
        SimpleDateFormat df = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
        Map<String, String> tz = new HashMap<>();
        String tzid = TimeZone.getDefault().getID();
        int ok = 0, rm = 0;
        Set<String> keep = new HashSet<>();
        try {
            for (int i = 0; i < events.length(); i++) {
                JSONObject ev = events.getJSONObject(i);
                String spaceId = ev.getString("id");
                if (spaceId == null) continue;
                keep.add(spaceId);
                ContentValues cv = toValues(calId, ev, df, tzid);
                if (cv == null) continue;
                Long sysId = prefs.getLong("m:" + spaceId, -1);
                if (sysId > 0) {
                    getContext().getContentResolver().update(
                            ContentUris.withAppendedId(Events.CONTENT_URI, sysId), cv, null, null);
                } else {
                    Uri inserted = getContext().getContentResolver().insert(Events.CONTENT_URI, cv);
                    if (inserted != null) {
                        long newId = ContentUris.parseId(inserted);
                        prefs.edit().putLong("m:" + spaceId, newId).apply();
                    }
                }
                ok++;
            }
            // 删除已不在列表中的旧映射
            Map<String, ?> all = prefs.getAll();
            SharedPreferences.Editor ed = prefs.edit();
            for (String key : all.keySet()) {
                if (!key.startsWith("m:")) continue;
                String sid = key.substring(2);
                if (!keep.contains(sid)) {
                    long sysId = (Long) all.get(key);
                    try {
                        getContext().getContentResolver().delete(
                                ContentUris.withAppendedId(Events.CONTENT_URI, sysId), null, null);
                    } catch (Exception ignored) { }
                    ed.remove(key);
                    rm++;
                }
            }
            ed.apply();
        } catch (Exception e) {
            call.reject("回写系统日历失败: " + e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("upserted", ok);
        ret.put("removed", rm);
        call.resolve(ret);
    }

    /** 把改动写回这条日程原来所在的日历：只 update，绝不删除别人的日程 */
    @PluginMethod
    public void edit(PluginCall call) {
        JSONObject ev = new JSONObject(call.getData());
        long sysId, calId;
        try {
            sysId = Long.parseLong(ev.optString("evId"));
            calId = Long.parseLong(ev.optString("calId"));
        } catch (NumberFormatException e) {
            call.reject("缺少要修改的日程编号");
            return;
        }
        try {
            ContentValues cv = toValues(calId, ev,
                    new SimpleDateFormat("yyyy-MM-dd", Locale.US), TimeZone.getDefault().getID());
            int n = getContext().getContentResolver().update(
                    ContentUris.withAppendedId(Events.CONTENT_URI, sysId), cv, null, null);
            if (n <= 0) {
                call.reject("原日历里已找不到这条日程，可能已被删除");
                return;
            }
            JSObject ret = new JSObject();
            ret.put("updated", n);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("写回原日历失败: " + e.getMessage());
        }
    }

    private ContentValues toValues(long calId, JSONObject ev, SimpleDateFormat df, String tzid) throws Exception {
        ContentValues cv = new ContentValues();
        cv.put(Events.CALENDAR_ID, calId);
        cv.put(Events.TITLE, ev.optString("title", "共享日程"));
        cv.put(Events.EVENT_LOCATION, ev.optString("location", ""));
        cv.put(Events.DESCRIPTION, ev.optString("desc", ""));
        boolean allDay = Boolean.TRUE.equals(ev.optBoolean("allDay"));
        long start = df.parse(ev.getString("date")).getTime();
        if (allDay) {
            long end = start;
            String endDate = ev.optString("endDate");
            if (endDate != null && !endDate.isEmpty()) end = df.parse(endDate).getTime();
            cv.put(Events.DTSTART, start);
            cv.put(Events.DTEND, end + DAY); // 全天 DTEND 排他
        } else {
            String st = ev.optString("start", "");
            if (st != null && !st.isEmpty()) start += hhmm(st);
            cv.put(Events.DTSTART, start);
            String en = ev.optString("end", "");
            long end = (en != null && !en.isEmpty()) ? df.parse(ev.getString("date")).getTime() + hhmm(en) : start + 3600000L;
            if (end <= start) end = start + 3600000L;
            cv.put(Events.DTEND, end);
            cv.put(Events.EVENT_TIMEZONE, tzid);
        }
        String rrule = ev.optString("rruleStr");
        if (rrule != null && !rrule.isEmpty()) cv.put(Events.RRULE, rrule);
        return cv;
    }

    private long hhmm(String hm) {
        String[] p = hm.split(":");
        return (Long.parseLong(p[0]) * 60 + Long.parseLong(p[1])) * 60000L;
    }

    private boolean sameDay(long a, long b) {
        return (a / DAY) == (b / DAY);
    }

    private long ensureCalendar() {
        try (Cursor c = getContext().getContentResolver().query(
                Calendars.CONTENT_URI,
                new String[]{Calendars._ID},
                Calendars.ACCOUNT_NAME + "=? AND " + Calendars.ACCOUNT_TYPE + "=?",
                new String[]{ACCOUNT_NAME, ACCOUNT_TYPE}, null)) {
            if (c != null && c.moveToFirst()) return c.getLong(0);
        }
        ContentValues cv = new ContentValues();
        cv.put(Calendars.ACCOUNT_NAME, ACCOUNT_NAME);
        cv.put(Calendars.ACCOUNT_TYPE, ACCOUNT_TYPE);
        cv.put(Calendars.NAME, ACCOUNT_NAME);
        cv.put(Calendars.CALENDAR_DISPLAY_NAME, "共享日程");
        cv.put(Calendars.CALENDAR_COLOR, 0xFF5B8FF9);
        cv.put(Calendars.VISIBLE, 1);
        cv.put(Calendars.SYNC_EVENTS, 1);
        cv.put(Calendars.CALENDAR_ACCESS_LEVEL, Calendars.CAL_ACCESS_OWNER);
        cv.put(Calendars.OWNER_ACCOUNT, ACCOUNT_NAME);
        Uri calUri = Calendars.CONTENT_URI.buildUpon()
                .appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true")
                .appendQueryParameter(Calendars.ACCOUNT_NAME, ACCOUNT_NAME)
                .appendQueryParameter(Calendars.ACCOUNT_TYPE, ACCOUNT_TYPE)
                .build();
        Uri u = getContext().getContentResolver().insert(calUri, cv);
        return ContentUris.parseId(u);
    }
}
