package com.timemaster.app;

import android.content.Context;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 桌面小组件的数据入口：网页每次同步/改动后把「今天还剩的日程」推过来，
 * 原生存一份到 SharedPreferences，再通知所有 widget 重画。
 * 没有后台轮询——widget 显示的是最后一次推送的快照，用户打开应用即刷新。
 */
@CapacitorPlugin(name = "NativeWidget")
public class NativeWidgetPlugin extends Plugin {

    @PluginMethod
    public void update(PluginCall call) {
        String payload = call.getString("payload", "{}");
        Context ctx = getContext();
        ctx.getSharedPreferences("tm_widget", Context.MODE_PRIVATE)
                .edit().putString("payload", payload).apply();
        WidgetProvider.pushAll(ctx);
        call.resolve();
    }
}
