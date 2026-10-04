package com.timemaster.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 2xN 家字日历卡片：日期 + 空间名一行，下面最多四条「时间 + 标题」。
 * 数据全部来自 NativeWidgetPlugin 推送的 JSON 快照（网页侧生成），原生不做任何业务计算。
 */
public class WidgetProvider extends AppWidgetProvider {

    private static final int MAX_ROWS = 4;

    public static void pushAll(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, WidgetProvider.class));
        if (ids.length == 0) return;
        String json = ctx.getSharedPreferences("tm_widget", Context.MODE_PRIVATE)
                .getString("payload", "{}");
        RemoteViews rv = render(ctx, json);
        if (rv != null) mgr.updateAppWidget(ids, rv);
    }

    static RemoteViews render(Context ctx, String json) {
        RemoteViews rv = new RemoteViews(ctx.getPackageName(), R.layout.widget);
        Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (launch != null) {
            rv.setOnClickPendingIntent(R.id.widget_root,
                    PendingIntent.getActivity(ctx, 0, launch,
                            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        }
        String date = "今天", space = "";
        JSONArray items = new JSONArray();
        try {
            JSONObject o = new JSONObject(json);
            date = o.optString("date", "今天");
            space = o.optString("space", "");
            JSONArray arr = o.optJSONArray("items");
            if (arr != null) items = arr;
        } catch (Exception ignored) { /* 坏数据按空卡片显示 */ }
        rv.setTextViewText(R.id.widget_date, date);
        rv.setTextViewText(R.id.widget_space, space);

        int[] rowIds = { R.id.wr1, R.id.wr2, R.id.wr3, R.id.wr4 };
        int[] timeIds = { R.id.wp1, R.id.wp2, R.id.wp3, R.id.wp4 };
        int[] titleIds = { R.id.wt1, R.id.wt2, R.id.wt3, R.id.wt4 };
        int n = Math.min(items.length(), MAX_ROWS);
        for (int i = 0; i < MAX_ROWS; i++) {
            if (i >= n) {
                rv.setViewVisibility(rowIds[i], View.GONE);
                continue;
            }
            JSONObject it = items.optJSONObject(i);
            if (it == null) {
                rv.setViewVisibility(rowIds[i], View.GONE);
                continue;
            }
            rv.setViewVisibility(rowIds[i], View.VISIBLE);
            rv.setTextViewText(timeIds[i], it.optString("time", ""));
            rv.setTextViewText(titleIds[i], it.optString("title", ""));
            try {
                int c = Color.parseColor(it.optString("color", "#E5484D"));
                rv.setTextColor(timeIds[i], c);
            } catch (Exception ignored) { /* 颜色坏了就用布局里的默认色 */ }
        }
        rv.setViewVisibility(R.id.widget_empty, n == 0 ? View.VISIBLE : View.GONE);
        return rv;
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        pushAll(context);
    }
}
