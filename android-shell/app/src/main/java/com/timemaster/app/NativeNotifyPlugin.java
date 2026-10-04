package com.timemaster.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * 变更通知：同步发现成员的增删改/应答后，网页侧调 show() 发一条系统通知。
 * Android 13+ 需要 POST_NOTIFICATIONS 运行时权限；没授权时把弹窗带起来，
 * 本条通知丢弃（弹窗期间用户也看不到通知），下一次同步就能正常发了。
 */
@CapacitorPlugin(
        name = "NativeNotify",
        permissions = {
                @Permission(alias = "notify", strings = { Manifest.permission.POST_NOTIFICATIONS })
        }
)
public class NativeNotifyPlugin extends Plugin {

    private static final String CHANNEL_ID = "reunion_changes";
    private static final int REQ_PERM = 41001;

    @PluginMethod
    public void show(PluginCall call) {
        Context ctx = getContext();
        String title = call.getString("title", "Reunion");
        String body = call.getString("body", "");
        String tag = call.getString("tag", "reunion");

        if (Build.VERSION.SDK_INT >= 33
                && ActivityCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            requestPermissionForAlias("notify", call, "permCb");
            return; // 权限回调里 resolve；这条通知等下一轮
        }
        boolean shown = publish(ctx, title, body, tag);
        JSObject ret = new JSObject();
        ret.put("shown", shown);
        call.resolve(ret);
    }

    @PermissionCallback
    private void permCb(PluginCall call) {
        Context ctx = getContext();
        boolean granted = Build.VERSION.SDK_INT < 33
                || ActivityCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS)
                        == PackageManager.PERMISSION_GRANTED;
        boolean shown = false;
        if (granted) {
            shown = publish(ctx, call.getString("title", "Reunion"),
                    call.getString("body", ""), call.getString("tag", "reunion"));
        }
        JSObject ret = new JSObject();
        ret.put("shown", shown);
        call.resolve(ret);
    }

    private boolean publish(Context ctx, String title, String body, String tag) {
        try {
            NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL_ID, "日程更新", NotificationManager.IMPORTANCE_DEFAULT);
                ch.setDescription("成员新增/修改日程与出勤应答");
                nm.createNotificationChannel(ch);
            }
            Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
            PendingIntent pi = launch != null
                    ? PendingIntent.getActivity(ctx, 0, launch,
                            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)
                    : null;
            Notification n = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                    .setAutoCancel(true)
                    .setContentIntent(pi)
                    .build();
            nm.notify(tag, (tag + title).hashCode(), n);
            return true;
        } catch (Exception e) {
            return false; // 权限被收回、通知被系统关闭：静默，不打扰主流程
        }
    }
}
