package com.yushan.cook;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import android.provider.Settings;

/**
 * 通知渠道（Android 8+）——**全应用只在这里创建**（2026-10-16）。
 *
 * ## 为什么要收拢到一处
 *
 * 起因是 vivo 开放平台那条要求：「请在规定时间内完成 vivo 本地通知分类的接入，
 * 否则将影响正常的消息推送。请将所有**正在使用的本地通知渠道**在平台登记备案」。
 * 备案要逐条写清"这个渠道发什么"，而当时我们的渠道是这样的（模拟器上 dump 出来的真名字）：
 *
 * | 渠道 id | 名字 | 谁建的 | 发什么 |
 * | --- | --- | --- | --- |
 * | `default` | Default（说明栏空） | `@capacitor/local-notifications` 初始化时 | 别人点了菜、到点做饭……**全都在里面** |
 * | `badge` | Badge | `@capacitor/background-runner` | **从来没发过东西** |
 * | `realtime_link` | 实时连接 | 本项目 `RealtimeService` | 常驻的"正在保持连接" |
 *
 * 拿去备案填不清（"Default 发什么？"——什么都发），用户到系统设置里看到
 * "Default""Badge"也不知道那是什么。
 *
 * ## 两条 Android 的硬规矩，决定了这里只能"新建 + 删旧"
 *
 * 1. **渠道 id 建出来就不能改**，名字与说明也是**由创建那一次定的**（之后代码里改无效
 *    ——系统的设计是"用户看到的设置不能被应用偷偷改掉"）；
 * 2. 所以要换名字，只能**用一个新 id 新建**，再把旧 id `deleteNotificationChannel` 掉。
 *
 * 三个还在用的渠道见下面三个常量；两个退役的（`default` / `badge`）每次启动都删一遍——
 * 它们由第三方插件在各自的路径上顺手创建，我们改不了插件的代码，只能删：
 * - `default`：插件在 `load()` 里建（应用每次启动时那一次，我们紧随其后删掉）；
 * - `badge`：后台那段巡查代码用到它的通知 API 时会连带建出来（见 `public/runners/patrol.js`）。
 *   它**从来没有被用来发过任何一条通知**，只是"建在那儿"。
 *
 * ## 用户能改，我们不覆盖
 *
 * `create()` 里"已存在就一个字都不改"：用户在系统设置里把「家里的事」调成静音、
 * 或者关掉，那是他的选择——下次启动**不能**把它改回来（那正是渠道机制要防的事）。
 */
public final class NotifyChannels {

    /**
     * 家里的事：谁点了菜、谁传了打卡、谁动了冰箱、谁改了家庭设置。
     *
     * 这是应用里**最主要**的一类通知（别人做了什么），也是唯一"有互动意味"的：
     * 用户看到它可能想立刻回一句话或者去做点什么。
     */
    public static final String FAMILY_EVENTS = "family_events";

    /**
     * 做饭与到期提醒：到点该做饭、冰箱里有东西快过期。
     *
     * 与上面那条分开，是因为**用途不同**（这两类是"时间到了该干活"，不是"谁做了什么"），
     * 用户想静音其中一类时不必连另一类一起关掉。这两类在应用里本来也是分开算的
     * （见 `lib/local-notify.rules.ts` 与 M10 的四类状态型提醒）。
     */
    public static final String MEAL_REMINDERS = "meal_reminders";

    /**
     * 实时连接：那条常驻的"正在保持连接"（前台服务必需，否则系统会随时收走服务）。
     *
     * 名字沿用第一版的「实时连接」：它本来就是给用户看的说明，含义准确，没有改的必要
     * ——换个 id 会让已装机的用户白丢一次渠道设置。
     */
    public static final String LIVE_LINK = "realtime_link";

    /**
     * 退役的渠道：每次启动删掉。
     *
     * 为什么不留着（哪怕它们没在用）：它们**会出现在系统设置的渠道列表里**
     * （Android 把"建过的渠道"都列出来，不管有没有发过），而 vivo 那条要求正是
     * "把所有正在使用的渠道登记备案"——留着两个说不清用途的，就得为它们各写一段解释。
     */
    private static final String[] RETIRED = { "default", "badge" };

    private NotifyChannels() {}

    /** 建齐三个渠道 + 删掉退役的。**幂等**，随便调多少次都行 */
    public static void ensure(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;

        create(manager, FAMILY_EVENTS, "家里的事", "谁点了菜、谁传了打卡、谁动了冰箱这类家里的消息");
        create(manager, MEAL_REMINDERS, "做饭与到期提醒", "到点该做饭、冰箱里有东西快过期");
        // 常驻那条走 IMPORTANCE_MIN：它是一句"连接还在"的说明，不是提醒，不该响也不该打扰
        createSilent(manager, LIVE_LINK, "实时连接", "让家里的事立刻到达（不响、不打扰）");

        for (String id : RETIRED) {
            if (manager.getNotificationChannel(id) != null) {
                manager.deleteNotificationChannel(id);
            }
        }
    }

    private static void create(NotificationManager manager, String id, String name, String description) {
        if (manager.getNotificationChannel(id) != null) return;
        NotificationChannel channel = new NotificationChannel(id, name, NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription(description);
        // 用系统默认提示音：不自己指定音效文件，跟着用户手机的设置走
        channel.setSound(Settings.System.DEFAULT_NOTIFICATION_URI, null);
        manager.createNotificationChannel(channel);
    }

    private static void createSilent(NotificationManager manager, String id, String name, String description) {
        if (manager.getNotificationChannel(id) != null) return;
        NotificationChannel channel = new NotificationChannel(id, name, NotificationManager.IMPORTANCE_MIN);
        channel.setDescription(description);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }
}
