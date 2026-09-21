package com.timemaster.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必须在 super 之前注册，JS 侧才能拿到插件
        registerPlugin(NativeHttpPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
