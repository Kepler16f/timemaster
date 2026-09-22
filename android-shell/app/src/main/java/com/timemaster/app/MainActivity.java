package com.timemaster.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必须在 super 之前注册，JS 侧才能拿到插件
        registerPlugin(NativeHttpPlugin.class);
        registerPlugin(AndroidCalendarPlugin.class);
        registerPlugin(NativeUpdatePlugin.class);
        super.onCreate(savedInstanceState);
    }

    /* 返回键与全面屏侧滑：先让网页逐层回退（弹窗 → 设置页），网页说该走了才真的退出 */
    @Override
    public void onBackPressed() {
        if (bridge == null) {
            super.onBackPressed();
            return;
        }
        bridge.eval("window.__tmBack ? window.__tmBack() : \"exit\"", result -> {
            if (result == null || result.contains("exit")) {
                runOnUiThread(this::finishAffinity);
            }
        });
    }
}
