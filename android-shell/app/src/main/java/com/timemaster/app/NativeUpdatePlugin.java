package com.timemaster.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
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
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;
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

    /**
     * 一组候选地址（直连 github.com + 公共反代）按顺序试，谁先完整下完并用 sha256 校过就用谁。
     * 大陆直连 GitHub 的 release 附件经常几十 KB/s 或干脆连不上，而反代是第三方，
     * 所以校验必须做：包被换过、下载被截断，都在这里当场报错换下一个，而不是留给系统安装器去「解析包出错」。
     */
    @PluginMethod
    public void download(PluginCall call) {
        List<String> urls = new ArrayList<>();
        JSArray arr = call.getArray("urls", new JSArray());
        for (int i = 0; i < arr.length(); i++) {
            try {
                String u = arr.getString(i);
                if (u != null && !u.isEmpty()) urls.add(u);
            } catch (Exception ignored) { }
        }
        String single = call.getString("url");
        if (urls.isEmpty() && single != null && !single.isEmpty()) urls.add(single);
        if (urls.isEmpty()) { call.reject("url is required"); return; }
        String name = call.getString("name", "reunion-update.apk");
        final String sha = call.getString("sha256", "");
        final File dir = new File(getContext().getCacheDir(), "update");
        if (!dir.exists() && !dir.mkdirs()) { call.reject("无法创建下载目录"); return; }
        tryNext(call, urls, 0, sha, new File(dir, name), "没有可用的下载通道");
    }

    private void tryNext(final PluginCall call, final List<String> urls, final int idx,
                         final String sha, final File out, final String lastError) {
        if (idx >= urls.size()) { call.reject(lastError); return; }
        final String url = urls.get(idx);
        if (out.exists() && !out.delete()) { call.reject("旧安装包被占用，请重试"); return; }

        client.newCall(new Request.Builder().url(url).build()).enqueue(new Callback() {
            @Override
            public void onFailure(Call c, IOException e) {
                tryNext(call, urls, idx + 1, sha, out, "下载失败：" + e.getMessage());
            }

            @Override
            public void onResponse(Call c, Response resp) {
                if (!resp.isSuccessful() || resp.body() == null) {
                    resp.close();
                    tryNext(call, urls, idx + 1, sha, out, "下载失败 HTTP " + resp.code());
                    return;
                }
                long total = resp.body().contentLength();
                long received = 0, lastTick = 0;
                MessageDigest md = null;
                try {
                    md = sha.isEmpty() ? null : MessageDigest.getInstance("SHA-256");
                } catch (NoSuchAlgorithmException e) { md = null; }
                try (InputStream in = resp.body().byteStream();
                     OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[16 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        os.write(buf, 0, n);
                        if (md != null) md.update(buf, 0, n);
                        received += n;
                        long now = System.currentTimeMillis();
                        if (now - lastTick > 300) { lastTick = now; emitProgress(received, total); }
                    }
                    os.flush();
                    resp.close();
                    emitProgress(received, Math.max(total, received));
                    String got = md == null ? "" : toHex(md.digest());
                    if (md != null && !got.equalsIgnoreCase(sha)) {
                        out.delete();
                        tryNext(call, urls, idx + 1, sha, out, "安装包校验不通过（下载通道可能不可靠）");
                        return;
                    }
                    JSObject ret = new JSObject();
                    ret.put("path", out.getAbsolutePath());
                    ret.put("used", url);
                    call.resolve(ret);
                } catch (IOException e) {
                    resp.close();
                    out.delete();
                    tryNext(call, urls, idx + 1, sha, out, "写入失败：" + e.getMessage());
                }
            }
        });
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
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
