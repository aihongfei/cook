import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router-dom'
import { Toaster } from '@/components/ui/toast'
import { installAndroidBack } from '@/lib/android-back'
import { setBackNavigator } from '@/lib/back-go'
import { installBackGesture } from '@/lib/back-gesture'
import { installNoImageDrag } from '@/lib/no-image-drag'
import { LocalNotifySync } from '@/lib/local-notify-sync'
import { PatrolSync } from '@/lib/patrol-sync'
import { RealtimeSync } from '@/lib/realtime-sync'
import { router } from '@/router'
import '@/styles/tailwind.css'
import '@/styles/index.scss'

/*
 * 安卓系统返回键（F14-01 / R-13 ①）：WebView 不接管的话，返回键在二级页上毫无反应
 * （模拟器实测：在 /taste 按返回，页面纹丝不动）。装一次、全局生效——
 * 弹层优先关、再回上一层、到首页才退出 App。浏览器里这个函数直接返回空卸载器，没有副作用。
 */
installAndroidBack()

/*
 * 返回手势的**跟手**（D-109）：手指从屏幕左缘拖，页面跟着走。
 *
 * 与上一条是同一个功能的两半：上一条管"按下去了、该去哪"，这一条管"拖动过程中两页
 * 各自在哪"。它同时负责**告诉原生"这一次归不归我们"**——在厨房根页放手，
 * 让系统自己播"窗口缩回桌面"的退出预览（那是最"原生"的那种退出）。
 * 浏览器 / iOS 上没有这个插件，函数自己会空转。
 */
installBackGesture()

/*
 * 「退回去」接到真实路由上（D-105）：页面上的「← 返回」与系统返回键都调
 * `lib/back-go` 的 `goBack`，而它需要路由的 `navigate`。接线放在最外层（这里）——
 * 路由对象 import 页面、页面又要用 `goBack`，直接互相 import 会绕成环。
 */
setBackNavigator((to, options) => void router.navigate(to, options))

/*
 * 图片不能拖（用户 2026-10-16）：与上一条同一类——装一次、全局生效。
 * 原生拖放会抢走正在跟手的那一下（翻页 / 长按 / 抽屉下拖），见 lib/no-image-drag.ts 文件头。
 */
installNoImageDrag()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      {/* 全局提示层：放在 Router 外面，换页时不会被卸载 */}
      <Toaster />
      {/*
        手机弹窗提醒的排程（M10 交付二）：也放在 Router **外面**。
        它在登录时排、**退出登录时清**——挂在路由里的布局上时，退出登录会把那个布局卸载，
        清理代码因此永远不执行（实测：退出后 9 条闹钟留在系统里）。见 lib/local-notify-sync 文件头。
      */}
      <LocalNotifySync />
      {/*
        后台巡查（M10 交付三）：登录后把这台手机的巡查令牌交给系统的调度器，
        退出登录时交还。同样放在 Router 外面——它要跨登录态才看得见"从有到无"那一步
        （交付二在这一点上踩过一次，见 lib/local-notify-sync 文件头）。
      */}
      <PatrolSync />
      {/*
        实时通道（F10-08）：应用**开着**的时候，家里发生的变动当场刷新到屏幕上——
        通知中心、订单、打卡墙、冰箱、菜谱、家庭那几块。
        它补的是"两台都开着反而最慢"那一段（要等 60 秒的 staleTime）。
        手机退到后台之后由原生那条路接着收（见 lib/realtime-sync 文件头）。
      */}
      <RealtimeSync />
    </QueryClientProvider>
  </StrictMode>,
)
