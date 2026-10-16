package com.yushan.cook;

import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * 实时连接的原生实现（F10-08）：**应用退到后台之后，家里的动静仍然当场到达**。
 *
 * ## 为什么非得是原生的（用户问过「你说 webview 会死，那用原生能实现吗」）
 *
 * 能。而且这就是那个问题的答案：WebView 里的 JS 在应用退到后台约 40 秒后会被系统冻住
 * （实测过，见 DECISIONS D-081），所以**连接要活在 WebView 之外**——
 * 一个前台服务（`Service` + 常驻通知）里挂一条 WebSocket，它不受 WebView 冻不冻的影响。
 *
 * | 应用状态 | 谁在盯着 | 延迟 |
 * | --- | --- | --- |
 * | 前台 | WebView 那条（`lib/realtime-sync.ts`） | 毫秒 |
 * | **后台（WebView 已冻住）** | **本服务** | **毫秒** |
 * | 进程被杀 | 系统的调度器（`public/runners/patrol.js`） | 最多约一刻钟 |
 *
 * 三层是**兜底关系**，不是三套并行的东西：越靠上的越实时、越靠下的越能活。
 *
 * ## 这一层不自己编通知内容
 *
 * 收到信号（`{"type":"changed"}`）之后，它去问**同一个巡查接口**
 * （`GET /notifications/patrol?since=…`）拿"上次之后又发生了什么"，
 * 那条接口给的就是通知中心里那些句子（`NotificationsService.patrol` 直接调 `list()`）。
 * 所以后台弹出来的话与用户点进应用看到的**一模一样**——这也是本项目反复强调的口径同源
 * （见 D-081）。它**不**从信号里拼一句话出来。
 *
 * ## 水位线（`since`）与那段调度器代码**共用同一份存储**
 *
 * `@capacitor/background-runner` 的 KV 就是一份以 runner label 命名的
 * `SharedPreferences`（`io.ionic.backgroundrunner.plugin.api.KV`：`getSharedPreferences(label)`），
 * 键是 `patrol-config`、里面是一个 JSON（`token` / `apiBase` / `userId` / `since`）。
 * 本服务**读它、推进它**，于是两条路不会各弹一遍同一件事：
 * 谁先取到就推进水位线，另一条下次就从那儿往后取。
 * （两者在同一个进程里，`SharedPreferences` 的访问是串行的；真要撞上同一个瞬间，
 * 代价是**至多一条重复通知**，而这件事的概率与影响都远小于"两条路各记一份水位线、
 * 结果各自弹一遍"——那是**每次**都重复。）
 *
 * ## 它自己不发通知给自己看的人
 *
 * 应用正在前台时**不弹系统通知**：用户此刻就在看着应用，红点与通知中心已经当场更新了
 * （WebView 那条连接），再弹一条通知栏是骚扰。判据用
 * `ActivityManager.getRunningAppProcesses()` 里自己那个进程的 `importance`
 * ——Android 上它只返回本应用，正好是我们要问的那个问题。
 */
public class RealtimeService extends Service {

    private static final String TAG = "RealtimeLink";

    /** 启动（带上令牌与后端地址） */
    public static final String ACTION_START = "com.yushan.cook.realtime.START";
    /** 停手（退出登录、用户关掉开关时） */
    public static final String ACTION_STOP = "com.yushan.cook.realtime.STOP";

    public static final String EXTRA_TOKEN = "token";
    public static final String EXTRA_API_BASE = "apiBase";
    public static final String EXTRA_USER_ID = "userId";

    /**
     * 常驻通知那条的 id（前台服务必须有它，否则系统随时会收走服务）。
     *
     * 渠道走 `NotifyChannels.LIVE_LINK`（"实时连接"）——渠道的创建/删除**全部**收在
     * `NotifyChannels` 一处，这里不再自己建（2026-10-16 合并；理由见那边文件头）。
     */
    private static final int LIVE_NOTIFICATION_ID = 910001;

    /** 与那段调度器代码共用的那份存储（见文件头） */
    private static final String PATROL_PREFS = "com.yushan.cook.patrol";
    private static final String PATROL_CONFIG_KEY = "patrol-config";

    /**
     * 退避重连的上限。
     *
     * 后台服务比前台更该省电：连着断、断了连会让手机反复唤醒。所以上限放到 60 秒——
     * 真断了之后"最多晚一分钟恢复"，比"为了快而每 2 秒重试、把电耗光"值得。
     */
    private static final long MAX_BACKOFF_MS = 60_000L;

    private final OkHttpClient http = new OkHttpClient.Builder()
            // 读超时给 0（不超时）：这条连接本来就是长连接，空闲是常态。
            // 用 WebSocket 自己那套 ping（下面 pingInterval）保活，不靠读超时。
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(30, TimeUnit.SECONDS)
            .build();

    /** 取"上次之后发生了什么"与解析都要串行（水位线的推进必须是原子的，见文件头） */
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    /**
     * 这条连接现在活着吗（给界面上的状态行看）。
     *
     * 静态字段：界面问的是"这台手机现在保不保持实时连接"，
     * 而能否拿到 `Service` 实例不影响这个答案（拿不到实例时只需要知道它没在跑）。
     */
    private static volatile boolean running = false;

    public static boolean isRunning() {
        return running;
    }

    private WebSocket socket;
    private boolean stopped = false;
    private int attempt = 0;
    private String token;
    private String apiBase;
    private String userId;

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopEverything();
            return START_NOT_STICKY;
        }

        if (intent != null) {
            token = intent.getStringExtra(EXTRA_TOKEN);
            apiBase = intent.getStringExtra(EXTRA_API_BASE);
            userId = intent.getStringExtra(EXTRA_USER_ID);
        }
        if (token == null || apiBase == null) {
            // 没有凭据就没有可做的事（退出登录时前端会先叫停，这里是兜底）
            stopEverything();
            return START_NOT_STICKY;
        }

        startForeground(LIVE_NOTIFICATION_ID, liveNotification());
        running = true;
        connect();
        /*
         * `START_STICKY`：被系统回收后自己回来。**不用 START_REDELIVER_INTENT**——
         * 重启时拿到的是旧的 intent（可能带着已经吊销的令牌），而更简单的做法是
         * 让它在没配置时自停、下次用户打开应用时由前端重新启动（见 JS 那侧的接线）。
         */
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopEverything();
        super.onDestroy();
    }

    // ------------------------------------------------------------------ 连接

    private void connect() {
        if (stopped || token == null) return;

        String url = wsBaseUrl(apiBase) + "/realtime?p=" + encode(token);
        Request request = new Request.Builder().url(url).build();
        Log.i(TAG, "connecting " + wsBaseUrl(apiBase) + "/realtime");

        socket = http.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                attempt = 0;
                Log.i(TAG, "connected");
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                // 只认"有变化"这一种（协议见 realtime.rules）：其余一概不理会，别猜
                if (!text.contains("\"changed\"")) return;
                fetchAndNotify();
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                Log.i(TAG, "closed " + code + " " + reason);
                scheduleReconnect();
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable error, @Nullable Response response) {
                int code = response == null ? 0 : response.code();
                Log.i(TAG, "failure (" + code + ") " + error.getMessage());
                if (code == 401 || code == 403) {
                    /*
                     * 凭据不认了（退出登录、被吊销、过期）：**停手**，不要每 60 秒白问一次。
                     * 用户下次在应用里登录时前端会重新启动本服务（与那段调度器代码
                     * 收到 401 就清令牌是同一条口径，见 public/runners/patrol.js）。
                     */
                    stopEverything();
                    return;
                }
                scheduleReconnect();
            }
        });
    }

    private void scheduleReconnect() {
        if (stopped) return;
        attempt += 1;
        long wait = Math.min(1000L * (1L << Math.min(attempt - 1, 6)), MAX_BACKOFF_MS);
        main.postDelayed(this::connect, wait);
    }

    // ------------------------------------------------------------------ 取"发生了什么"并弹

    /**
     * 问巡查接口"上次之后又发生了什么"，把新的那些弹成系统通知，并推进水位线。
     *
     * 与 `public/runners/patrol.js` 里那段是**同一件事的第二个实现**（那段跑在系统的
     * JS 引擎里，import 不了这里的代码）。两处都读同一份水位线，所以不会各弹一遍（见文件头）。
     */
    private void fetchAndNotify() {
        worker.execute(() -> {
            try {
                String since = readSince();
                String url = apiBase + "/notifications/patrol" + (since == null ? "" : "?since=" + encode(since));
                Request request = new Request.Builder()
                        .url(url)
                        .header("x-patrol-token", token)
                        .build();

                try (Response response = http.newCall(request).execute()) {
                    if (response.code() == 401 || response.code() == 403) {
                        Log.i(TAG, "patrol 凭据失效，停手");
                        stopEverything();
                        return;
                    }
                    if (!response.isSuccessful() || response.body() == null) return;

                    JSONObject body = new JSONObject(response.body().string());
                    JSONArray items = body.optJSONArray("items");
                    String next = body.optString("since", since == null ? "" : since);

                    /*
                     * 先推进水位线再弹：反过来的话，弹完崩在中间会让这一条**下次再弹一遍**。
                     * 先推进最多是"这次没弹成、那条只留在通知中心里"——少弹一条的代价
                     * 比重复弹一条小（用户对重复弹的反应是"这 App 有问题"）。
                     */
                    writeSince(next);

                    if (items != null && items.length() > 0 && !appVisible()) {
                        postNotifications(items);
                    }
                    Log.i(TAG, "patrol fetched: " + (items == null ? 0 : items.length()) + " new");
                }
            } catch (Exception error) {
                Log.i(TAG, "patrol 取失败（下一轮再试）：" + error.getMessage());
            }
        });
    }

    /** 把巡查接口给的那几条弹到通知栏（句子与去处都是后端给的，这里一个字都不编） */
    private void postNotifications(JSONArray items) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        // 渠道建齐（幂等）；退役的那个 "default" 也在这里被删掉，见 NotifyChannels
        NotifyChannels.ensure(this);

        for (int index = 0; index < items.length(); index += 1) {
            JSONObject item = items.optJSONObject(index);
            if (item == null) continue;
            String title = item.optString("title", "家里有新的动静");
            String text = item.optString("body", "");
            int id = item.optInt("notifyId", title.hashCode());

            Intent open = new Intent(this, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pending = PendingIntent.getActivity(this, id, open, flags);

            Notification notification = new NotificationCompat.Builder(this, NotifyChannels.FAMILY_EVENTS)
                    .setContentTitle(title)
                    .setContentText(text)
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                    .setSmallIcon(getApplicationInfo().icon)
                    .setAutoCancel(true)
                    .setContentIntent(pending)
                    .build();

            manager.notify(id, notification);
        }
    }

    /**
     * 应用是不是正在前台（决定要不要弹通知）。
     *
     * `getRunningAppProcesses()` 在 Android 5.0+ 只返回**本应用**的进程，
     * 正好是我们要问的"我自己现在什么状态"。拿不到时按"不在前台"处理——
     * 这条服务的意义就是后台送达，宁可多弹一条，也不要因为读不到状态而把该弹的吞掉。
     */
    private boolean appVisible() {
        try {
            ActivityManager manager = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
            if (manager == null) return false;
            int pid = android.os.Process.myPid();
            for (ActivityManager.RunningAppProcessInfo info : manager.getRunningAppProcesses()) {
                if (info.pid == pid) {
                    return info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
                }
            }
        } catch (Exception ignored) {
            // 读不到就当"不在前台"（见上）
        }
        return false;
    }

    // ------------------------------------------------------------------ 水位线（与那段调度器代码共用）

    private SharedPreferences patrolPrefs() {
        return getSharedPreferences(PATROL_PREFS, Context.MODE_PRIVATE);
    }

    private String readSince() {
        try {
            String raw = patrolPrefs().getString(PATROL_CONFIG_KEY, null);
            if (raw == null) return null;
            JSONObject config = new JSONObject(raw);
            /*
             * 只认**同一个账号**的水位线：换账号之后上一个人的"我取到哪儿了"
             * 对新账号毫无意义，用它会让新账号漏掉刚发生的事（那段调度器代码
             * 在换账号时也是清掉水位线，见 patrol.js 的 loadConfig）。
             */
            if (userId != null && !userId.equals(config.optString("userId", null))) return null;
            String since = config.optString("since", "");
            return since.isEmpty() ? null : since;
        } catch (Exception error) {
            return null;
        }
    }

    private void writeSince(String since) {
        if (since == null || since.isEmpty()) return;
        try {
            SharedPreferences prefs = patrolPrefs();
            String raw = prefs.getString(PATROL_CONFIG_KEY, null);
            JSONObject config = raw == null ? new JSONObject() : new JSONObject(raw);
            if (userId != null && !userId.equals(config.optString("userId", null))) return;
            config.put("since", since);
            /*
             * 用 `commit()` 而不是 `apply()`：这里在后台线程上，而"写进去"必须**当场成立**
             * ——用 apply 的话它异步落盘，紧接着进程被回收就会丢掉这次推进，
             * 下一次巡查把同一批事再弹一遍。
             */
            prefs.edit().putString(PATROL_CONFIG_KEY, config.toString()).commit();
        } catch (Exception error) {
            Log.i(TAG, "水位线写失败：" + error.getMessage());
        }
    }

    // ------------------------------------------------------------------ 常驻通知与收尾

    private Notification liveNotification() {
        /*
         * 渠道由 `NotifyChannels` 统一管（建齐三个 + 删掉退役的，见那边文件头）。
         * 这里在建之前**再叫一次**是必要的：本服务可能由系统在应用进程之外单独唤起
         * （`START_STICKY` 之后的重启），那一刻 `MainActivity` 没有跑过。
         */
        NotifyChannels.ensure(this);

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending = PendingIntent.getActivity(this, LIVE_NOTIFICATION_ID, open, flags);

        return new NotificationCompat.Builder(this, NotifyChannels.LIVE_LINK)
                .setContentTitle("家里的事会立刻告诉你")
                .setContentText("正在保持连接")
                .setSmallIcon(getApplicationInfo().icon)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setContentIntent(pending)
                .build();
    }

    private void stopEverything() {
        stopped = true;
        running = false;
        if (socket != null) {
            socket.close(1000, "stop");
            socket = null;
        }
        worker.shutdown();
        stopForeground(true);
        stopSelf();
    }

    // ------------------------------------------------------------------ 小工具

    /** `http(s)://host/api` → `ws(s)://host/api`（同一条转换，与前端那边一致） */
    private static String wsBaseUrl(String httpBase) {
        if (httpBase.startsWith("https://")) return "wss://" + httpBase.substring("https://".length());
        if (httpBase.startsWith("http://")) return "ws://" + httpBase.substring("http://".length());
        return httpBase;
    }

    private static String encode(String value) {
        try {
            return java.net.URLEncoder.encode(value, "UTF-8");
        } catch (Exception error) {
            return value;
        }
    }
}
