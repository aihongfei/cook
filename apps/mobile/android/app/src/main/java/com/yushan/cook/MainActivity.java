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
        /*
         * 返回手势的进度（D-109）：同理，也要在 super 之前注册。
         *
         * 它接管系统的返回键与返回手势（`onBackPressedDispatcher` 上**唯一**的 callback
         * ——`@capacitor/app` 那条已在 `capacitor.config.ts` 里关掉：两处各判一次会打架）。
         * 手势进度只有 Android 14+ 有；低版本这条只转发按键，行为与旧版一致。
         */
        registerPlugin(BackGesturePlugin.class);
        super.onCreate(savedInstanceState);

        /*
         * 通知渠道（2026-10-16）：建齐三个、删掉退役的。
         *
         * **必须放在 `super.onCreate` 之后**：`@capacitor/local-notifications` 会在它自己的
         * `load()` 里创建那个叫 `default` 的旧渠道，而 `load()` 正是 `super` 里跑的
         * ——放前面会被它当场建回来（那次删除等于白做）。
         *
         * 也因此这里是"每次启动删一遍"：插件每次启动都会重建 `default`，
         * 改不了插件代码，就每次紧跟着删掉（渠道是系统级的，删掉之后一直有效，
         * 直到某个进程又把它建出来）。见 `NotifyChannels` 文件头那段。
         */
        NotifyChannels.ensure(this);
    }
}
