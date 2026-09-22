package com.timemaster.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.util.Iterator;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * 通用 HTTP 转发桥：绕开 WebView CORS，支持 WebDAV 自定义方法（PROPFIND/PUT 等）。
 * JS 侧协议见 public/transport.js
 */
@CapacitorPlugin(name = "NativeHttp")
public class NativeHttpPlugin extends Plugin {

    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .build();

    @PluginMethod
    public void request(PluginCall call) {
        String url = call.getString("url");
        if (url == null) { call.reject("url is required"); return; }

        final String method = call.getString("method", "GET").toUpperCase();
        final String bodyStr = call.getString("body");
        final JSObject headers = call.getObject("headers", new JSObject());

        RequestBody body = null;
        if (bodyStr != null && !method.equals("GET") && !method.equals("HEAD")) {
            String ct = "application/octet-stream";
            for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                String k = it.next();
                if (k.equalsIgnoreCase("Content-Type")) { ct = headers.getString(k); break; }
            }
            body = RequestBody.create(MediaType.parse(ct), bodyStr);
        }

        Request.Builder rb = new Request.Builder().url(url).method(method, body);
        for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
            String k = it.next();
            rb.addHeader(k, headers.getString(k));
        }

        client.newCall(rb.build()).enqueue(new Callback() {
            @Override
            public void onFailure(Call c, IOException e) {
                call.reject("http failed: " + e.getMessage());
            }

            @Override
            public void onResponse(Call c, Response resp) {
                try {
                    byte[] bytes = resp.body() != null ? resp.body().bytes() : new byte[0];
                    JSObject ret = new JSObject();
                    ret.put("status", resp.code());
                    JSObject hs = new JSObject();
                    for (String name : resp.headers().names()) hs.put(name, resp.header(name));
                    ret.put("headers", hs);
                    ret.put("bodyBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                    call.resolve(ret);
                } catch (IOException e) {
                    call.reject("read failed: " + e.getMessage());
                } finally {
                    resp.close();
                }
            }
        });
    }

    /** 设备标识存 SharedPreferences：WebView 的 localStorage 被清也不会换人 */
    @PluginMethod
    public void deviceId(PluginCall call) {
        SharedPreferences sp = getContext().getSharedPreferences("reunion", Context.MODE_PRIVATE);
        String id = sp.getString("deviceId", null);
        if (id == null || id.isEmpty()) {
            id = UUID.randomUUID().toString();
            sp.edit().putString("deviceId", id).apply();
        }
        JSObject ret = new JSObject();
        ret.put("id", id);
        call.resolve(ret);
    }
}
