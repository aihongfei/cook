import type { CapacitorConfig } from '@capacitor/cli'

/*
 * Capacitor 打包配置（F14-01）。
 *
 * 两个"看起来可以省"的配置，省掉就出问题：
 *
 * - `server.androidScheme: 'http'`：Capacitor 默认把 Web 资源挂在 `https://localhost`，
 *   而开发期后端是 `http://127.0.0.1:3000`——https 页面请求 http 接口属于混合内容，
 *   WebView 直接拦掉，表现是"APK 里所有数据都加载不出来"。改挂 `http://localhost`
 *   两条就同源协议了。`localhost` 本身算安全来源，摄像头/剪贴板这些要安全上下文的 API 不受影响。
 * - `server.cleartext: true`：Android 9+ 默认禁止明文 HTTP，不放行则本机联调（http 后端）连不上。
 *   正式部署换 https 后这几条都不需要改，留着也无害。
 *
 * `appId` 一旦装机就改不得（改了等于另一个 App，要卸载重装、数据清空），所以记在 DECISIONS D-067。
 */
const config: CapacitorConfig = {
  appId: 'com.yushan.cook',
  // 启动器上的名字。用两个字而不是「御膳·家庭小厨房」：四个字以上在多数启动器上会被截断成"御膳…"，
  // 应用内的标记本来也就是「御膳」。
  appName: '御膳',
  webDir: 'dist',
  server: {
    androidScheme: 'http',
    cleartext: true,
  },
  plugins: {
    /*
     * 后台巡查（M10 交付三）：让"别人点了菜"这类事在**应用退到后台之后**也能弹出来。
     *
     * 为什么非它不可（实测）：应用退到后台约 40 秒，WebView 里的 JS 就完全不执行了
     * （探针每 20 秒记一次，后台只记到第一次；拉回前台立刻恢复）。所以"页面里写个定时器"
     * 这条路根本不通，必须把那段逻辑交给**系统的调度器**（WorkManager）——它不看应用的死活。
     *
     * `interval: 15` 是 Android `PeriodicWorkRequest` 的**下限**（系统不接受更短），
     * 实际时机由系统按省电策略挑（息屏久置会更稀疏）。这不是"实时推送"，
     * 而是"最多晚一刻钟知道"——比"关掉就完全不知道"强得多，口径见 D-081。
     *
     * `src: 'runners/patrol.js'` 在 public/ 下，构建时会被原样拷进 APK 的 assets。
     */
    BackgroundRunner: {
      label: 'com.yushan.cook.patrol',
      src: 'runners/patrol.js',
      event: 'patrolTick',
      repeat: true,
      interval: 15,
      autoStart: true,
    },
  },
}

export default config
