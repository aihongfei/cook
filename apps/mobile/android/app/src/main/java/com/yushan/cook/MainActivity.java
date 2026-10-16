package com.yushan.cook;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        /*
         * 实时连接那个插件（F10-08）**必须先注册再 super.onCreate**：
         * `super` 里会建 bridge、把已注册的插件挂上去，晚一步注册就赶不上这次启动
         * （表现是 JS 那边 `RealtimeNative.start()` 报 "not implemented"）。
         */
        registerPlugin(RealtimeNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
