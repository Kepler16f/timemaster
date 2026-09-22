package com.timemaster.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * 应用内更新：把安装包流式下到应用缓存（不占用户存储、无需文件权限），再唤起系统安装器。
 * JS 侧协议见 public/update.js
 */
@CapacitorPlugin(name = "NativeUpdate")
public class NativeUpdatePlugin extends Plugin {

    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .build();
    private final Handler ui = new Handler(Looper.getMainLooper());

    @PluginMethod
    public void download(PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) { call.reject("url is required"); return; }
        String name = call.getString("name", "reunion-update.apk");
        final File dir = new File(getContext().getCacheDir(), "update");
        if (!dir.exists() && !dir.mkdirs()) { call.reject("无法创建下载目录"); return; }
        final File out = new File(dir, name);
        if (out.exists() && !out.delete()) { call.reject("旧安装包被占用，请重试"); return; }

        client.newCall(new Request.Builder().url(url).build()).enqueue(new Callback() {
            @Override
            public void onFailure(Call c, IOException e) {
                call.reject("下载失败：" + e.getMessage());
            }

            @Override
            public void onResponse(Call c, Response resp) {
                if (!resp.isSuccessful() || resp.body() == null) {
                    resp.close();
                    call.reject("下载失败 HTTP " + resp.code());
                    return;
                }
                long total = resp.body().contentLength();
                long received = 0, lastTick = 0;
                try (InputStream in = resp.body().byteStream();
                     OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[16 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        os.write(buf, 0, n);
                        received += n;
                        long now = System.currentTimeMillis();
                        if (now - lastTick > 300) { lastTick = now; emitProgress(received, total); }
                    }
                    os.flush();
                    resp.close();
                    emitProgress(received, Math.max(total, received));
                    JSObject ret = new JSObject();
                    ret.put("path", out.getAbsolutePath());
                    call.resolve(ret);
                } catch (IOException e) {
                    resp.close();
                    out.delete();
                    call.reject("写入失败：" + e.getMessage());
                }
            }
        });
    }

    private void emitProgress(long received, long total) {
        JSObject data = new JSObject();
        data.put("received", received);
        data.put("total", total);
        if (total > 0) data.put("percent", (int) (received * 100 / total));
        ui.post(() -> notifyListeners("progress", data));
    }

    /** 安装包在 cacheDir 子目录里，必须经 FileProvider 授权，直接 file:// 会被系统拒绝 */
    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) { call.reject("path is required"); return; }
        File f = new File(path);
        if (!f.exists()) { call.reject("安装包不存在，请重新下载"); return; }
        try {
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("唤起安装失败：" + e.getMessage());
        }
    }
}
