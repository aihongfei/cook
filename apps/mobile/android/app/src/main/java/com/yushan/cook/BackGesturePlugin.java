package com.yushan.cook;

import androidx.activity.BackEventCompat;
import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 系统返回手势的**进度**（F14-01 配套，用户 2026-10-16「需要返回那种从底层页面上方
 * 划过的那种效果，就和原生那种似的」，D-109）。
 *
 * ## 它补的是哪一格
 *
 * `@capacitor/app` 的 `backButton` 事件只在**松手之后**送一次「按了返回」——
 * 也就是说手指导航这件事它只知道终点，不知道过程。所以网页能做的只有
 * "松手后播一趟 0.24 秒动画"；要做到**手指拖到哪儿页面跟到哪儿**，必须有进度。
 *
 * 进度只有 Android 13/14 起才有（`OnBackInvokedCallback` 上的
 * `onBackStarted` / `onBackProgressed` / `onBackCancelled` + `BackEvent.progress`）。
 * androidx 把这些封在 `OnBackPressedCallback` 的四个方法里（1.6 起），
 * 本项目用的 1.11 全都有——所以**不用自己碰 `OnBackInvokedDispatcher`**，
 * 挂一个 callback 就同时拿到"按键"与"手势进度"两种输入。
 *
 * ## 为什么接管之后按键那一路也要走它
 *
 * 见 `capacitor.config.ts`：`plugins.App.disableBackButtonHandler = true` 关掉了
 * `@capacitor/app` 自己那条 callback。**返回的判定只许有一处**——
 * 两条 callback 会在同一次按键上各做各的判断（一条发事件、一条走我们的逻辑），
 * 行为取决于哪条先注册。所以这一条 plugin 是**唯一的**接入口：
 * 四件事（开始/进度/取消/按下）全都在这里转发给网页，由 `lib/android-back` 统一决策。
 *
 * ## 接管与放手的判据在**网页**那边
 *
 * 什么时候该由我们接管（子页返回、弹层开着）、什么时候该放手（在厨房根页——
 * 让**系统自带**的预测式退出预览出现，就是最"原生"的那种退出），
 * 判据全在 `lib/back-gesture.ts` 里（与返回语义同一份 `resolveBack`）。
 * 原生这边只做一件事：**如实转发**，并且按网页说的 `enabled` 开合 callback。
 *
 * ## 一个容易踩的坑：`handleOnBackPressed` 里的 `remove()`
 *
 * Android 13 起，手势**取消**也会走 `handleOnBackPressed`（系统用它表示"手势收了"）。
 * 而"要不要接管"是网页算的——原生这里不猜，转发过去由网页决定；
 * 网页回一句 `setEnabled(false)` 就真的放手（下一次手势归系统）。
 */
@CapacitorPlugin(name = "BackGesture")
public class BackGesturePlugin extends Plugin {

    private static final String EVENT_PROGRESS = "backGestureProgress";

    private OnBackPressedCallback callback;

    @Override
    public void load() {
        /*
         * `enabled = true` 起手：网页在**首帧之后**就会用 `setEnabled` 校正一次
         * （见 `lib/back-gesture.ts`）。起手关着的话，用户若在手势进行中打开应用
         * （理论上不会，但保守）或者第一次调用失败，返回键会变成"什么都不发生"——
         * 那是 R-13 第一条，绝不能退回去。
         */
        callback = new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackStarted(BackEventCompat event) {
                emit("start", event);
            }

            @Override
            public void handleOnBackProgressed(BackEventCompat event) {
                emit("progress", event);
            }

            @Override
            public void handleOnBackCancelled() {
                emit("cancel", null);
            }

            @Override
            public void handleOnBackPressed() {
                /*
                 * 走到这里有两种情形，**原生不区分、交网页判断**：
                 * ① 实体/虚拟返回键按下（没有手势过程）；
                 * ② 手势在 Android 13+ 被系统取消时的收尾回调。
                 * 网页那一侧用"当前有没有在拖动"来分（见 lib/back-gesture.ts）。
                 */
                emit("press", null);
            }
        };

        getActivity().getOnBackPressedDispatcher().addCallback(getActivity(), callback);
    }

    /** 把一次事件转发给网页。`progress` 只在有事件对象时带上 */
    private void emit(String kind, BackEventCompat event) {
        JSObject data = new JSObject();
        data.put("kind", kind);
        if (event != null) {
            data.put("progress", event.getProgress());
            data.put("touchX", event.getTouchX());
            data.put("touchY", event.getTouchY());
            // 从左缘还是右缘起手（本项目锁竖屏、只做左侧，但如实带上）
            data.put("edge", event.getSwipeEdge());
        }
        notifyListeners(EVENT_PROGRESS, data, true);
    }

    /**
     * 网页说"这次返回归我"或"放手"。
     *
     * 关掉（`enabled = false`）之后，返回交给**系统**：在厨房根页那一下会看到
     * 系统自带的"窗口缩回桌面"预览——那正是我们要的（见 D-109 四）。
     */
    @PluginMethod
    public void setEnabled(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) {
            call.reject("缺少 enabled");
            return;
        }
        if (callback != null) callback.setEnabled(enabled);
        JSObject result = new JSObject();
        result.put("enabled", enabled);
        call.resolve(result);
    }

    /** 现在归不归我们管（排查用：与「返回键怎么没反应」那类现象对照） */
    @PluginMethod
    public void isEnabled(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", callback != null && callback.isEnabled());
        call.resolve(result);
    }

    @Override
    protected void handleOnDestroy() {
        if (callback != null) callback.remove();
        callback = null;
    }
}
