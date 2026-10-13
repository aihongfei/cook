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
}

export default config
