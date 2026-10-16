package com.yushan.cook;

import android.content.Context;
import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 实时连接的**开关**（F10-08）：让前端能启停那个前台服务（见 `RealtimeService`）。
 *
 * ## 为什么是一个自定义插件，而不是"服务自己找机会启动"
 *
 * 服务需要的三样东西（凭据、后端地址、账号）**只有前端知道**：
 * 凭据是登录之后才领的，后端地址与账号存在 localStorage 里。
 * 让原生自己去读那些（去解析 WebView 的 localStorage）是另一条容易坏的路
 * ——所以按本项目的惯例：**谁知道的谁送进来**（与 `patrol-sync` 把配置
 * `dispatchEvent` 给那段调度器代码是同一条分工）。
 *
 * ## 三个方法
 *
 * - `start({token, apiBase, userId})`：登录后调（前端在拿不到凭据时不会调它）；
 * - `stop()`：退出登录/用户主动关掉时调；
 * - `status()`：界面上那行"实时连接"的现状（它要如实说"现在是不是连着"，
 *   而不是让用户猜——与交付二那行"手机提醒"现状同一个理由，见 D-086 四）。
 */
@CapacitorPlugin(name = "RealtimeNative")
public class RealtimeNativePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        String token = call.getString("token");
        String apiBase = call.getString("apiBase");
        String userId = call.getString("userId");

        if (token == null || token.isEmpty() || apiBase == null || apiBase.isEmpty()) {
            call.reject("缺少凭据或后端地址");
            return;
        }

        Context context = getContext();
        Intent intent = new Intent(context, RealtimeService.class);
        intent.setAction(RealtimeService.ACTION_START);
        intent.putExtra(RealtimeService.EXTRA_TOKEN, token);
        intent.putExtra(RealtimeService.EXTRA_API_BASE, apiBase);
        intent.putExtra(RealtimeService.EXTRA_USER_ID, userId);

        /*
         * Android 8 起"后台启动服务"要按前台服务的方式启动（`startForegroundService`），
         * 服务自己有 5 秒时间把常驻通知挂上（见 `RealtimeService.onStartCommand`）。
         * 这里是从应用前台调的（登录那一刻），不存在"后台启动被拒"的问题。
         */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }

        JSObject result = new JSObject();
        result.put("running", true);
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context context = getContext();
        Intent intent = new Intent(context, RealtimeService.class);
        intent.setAction(RealtimeService.ACTION_STOP);
        // 已经停了的时候再停一次也没有副作用（服务里的收尾是幂等的）
        context.startService(intent);

        JSObject result = new JSObject();
        result.put("running", false);
        call.resolve(result);
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("running", RealtimeService.isRunning());
        call.resolve(result);
    }
}
