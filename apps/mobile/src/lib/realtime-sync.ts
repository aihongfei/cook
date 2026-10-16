import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/stores/auth'

/**
 * 实时通道的**前端接线**（F10-08）：应用开着时，家里发生的变动**当场**刷新到屏幕上。
 *
 * ## 它解决的是哪一段
 *
 * 在这之前"家里人刚做的事"到另一台设备有三条路，但**应用开着反而是最慢的**：
 *
 * | 场景 | 之前 |
 * | --- | --- |
 * | 我正看着订单页，另一台点了菜 | **最多 60 秒**（`staleTime`，或手动下拉） |
 * | 退到后台 | 巡查那条（最多约一刻钟） |
 *
 * 用户 2026-10-16：「我需要的是实时通知，我这边上传了打卡，另一台同家庭的设备要**立马**收到」。
 * 这一层就是那一段：服务端写完库当场推一句信号过来，这里收到就刷新对应的查询。
 *
 * ## 推的是"信号"，不是"那条通知本身"
 *
 * 后端推的是 `{ type: 'changed', area }`——只说"哪一块变了"。为什么不在推送里带上标题正文：
 * 那样等于把"谁能看什么"的判断复制到推送这一侧（可见范围、开关、已读全在服务端算），
 * 而本项目在"同一个事实存两处"上栽过不止一次（见 D-078 四）。
 * 收到信号**重取一次**，拿回来的就是自己那一份，永远和通知中心一致。
 *
 * ## 断了要自己重连（这条不能省）
 *
 * 手机切网、地铁里丢信号、后端重启都会断。断开后按 **1s → 2s → 4s → …最多 15s** 退避重连，
 * 并在**网络恢复/页面回到前台**时立刻重连一次（`visibilitychange`）——
 * 不这么做的话，从电梯里出来后要等到下一次"碰巧"才会重新连上，
 * 用户看到的仍然是"怎么不刷新了"。
 *
 * ## 浏览器与手机是同一份代码
 *
 * 这里用浏览器原生的 `WebSocket`：APK 里 WebView 也有它，所以**前台那条路一次写好两边都能用**。
 * 手机退到后台之后 WebView 会被冻住（实测约 40 秒，见 D-081），那一段交给原生那条路
 * （`RealtimeService` 与 Android 侧的 OkHttp，两端都用同一个路径与协议）。
 */

/** 后端那个路径（与 `realtime.rules` 的 `REALTIME_PATH` 必须一致） */
const PATH = '/realtime'

/** 退避重连的上限：再久用户会觉得"它就是坏了" */
const MAX_BACKOFF_MS = 15_000

function socketUrl(token: string): string | null {
  const base = import.meta.env.VITE_API_BASE_URL
  if (typeof base !== 'string' || !base) return null
  /*
   * `VITE_API_BASE_URL` 是 http(s) 的，而 WebSocket 要 ws(s)：
   * 本机开发是 `http://127.0.0.1:3000/api` → `ws://127.0.0.1:3000/api/realtime`。
   * 部署到 https 后会自动变成 wss（同一段转换，不用改配置）。
   */
  const wsBase = base.replace(/^http/, 'ws').replace(/\/+$/, '')
  return `${wsBase}${PATH}?t=${encodeURIComponent(token)}`
}

/**
 * 挂在根层（`main.tsx`，与 `PatrolSync` 并列）：登录后连、退出就断。
 *
 * 放在 Router **外面**是必须的——退出登录会把路由布局卸载，
 * 而"从有到无"那一步正需要在这一层才看得见（交付二在这上面踩过一次，见 `patrol-sync` 文件头）。
 */
export function useRealtimeSync(): void {
  const token = useAuth((state) => state.token)
  const client = useQueryClient()
  const socketRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!token) return
    const url = socketUrl(token)
    if (!url) return

    /** 这一轮 effect 是否已经作废（换账号/退出时别再重连） */
    let closed = false
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const open = () => {
      if (closed) return
      let socket: WebSocket
      try {
        socket = new WebSocket(url)
      } catch {
        // 地址不合法之类：退避后重试，不让它把整个应用带崩
        schedule()
        return
      }
      socketRef.current = socket

      socket.onopen = () => {
        attempt = 0
      }

      socket.onmessage = (event) => {
        /*
         * 只认自己那一种消息。**不因为收到不认识的东西就报错**：
         * 协议将来加消息类型时，老客户端不该崩（它只是不知道那条而已）。
         */
        let payload: { type?: string } | null = null
        try {
          payload = JSON.parse(String(event.data)) as { type?: string }
        } catch {
          return
        }
        if (payload?.type !== 'changed') return

        /*
         * 刷哪几个：通知列表是**必然**要刷的（红点、角标、通知中心由它算），
         * 另外把与派单相关的几块也刷一遍——订单页、打卡墙、冰箱、菜谱、家庭。
         *
         * 全部 `invalidateQueries` 而不精细挑"这次是哪个 area"：
         * 一次失效只是把缓存标记为陈旧，**真正在看的那个页面才发请求**（React Query 的行为），
         * 所以代价是"当前这一页多发一次请求"。而按 area 精细挑的话，
         * 那个对应表就得在前端再存一份（后端的 `areaOfKind` 才是权威），
         * 迟早出现"后端归到 A、前端以为在 B"的空刷或不刷——本项目最不喜欢的那类重复。
         */
        void client.invalidateQueries({ queryKey: ['notifications'] })
        void client.invalidateQueries({ queryKey: ['orders'] })
        void client.invalidateQueries({ queryKey: ['checkins'] })
        void client.invalidateQueries({ queryKey: ['fridge'] })
        void client.invalidateQueries({ queryKey: ['recipes'] })
        void client.invalidateQueries({ queryKey: ['family'] })
      }

      socket.onclose = () => {
        socketRef.current = null
        schedule()
      }

      // 出错之后 `onclose` 一定会跟着来（浏览器保证），所以重连只挂在 `onclose` 一处
      socket.onerror = () => {}
    }

    const schedule = () => {
      if (closed) return
      attempt += 1
      const wait = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS)
      timer = setTimeout(open, wait)
    }

    /**
     * 回到前台/网络恢复时**立刻**重连，不等退避那一轮。
     *
     * 手机在后台待久之后 socket 早被系统收了，而退避计时器也可能因为休眠没跑；
     * 用户回到应用的第一眼就应当是新的数据，不该先看 15 秒旧内容。
     *
     * `CONNECTING` 也算"已经在连了"：这里若不判它，就会在"上一次还在握手"时再开一条，
     * 于是同一个页面握着两条连接（后端那边表现为条数莫名翻倍）。**只认 OPEN 是不够的。**
     */
    const wake = () => {
      if (document.visibilityState !== 'visible') return
      const socket = socketRef.current
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
      if (timer) clearTimeout(timer)
      attempt = 0
      open()
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)

    open()

    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [token, client])
}

/** 挂载点（`main.tsx` 里放一个，渲染 `null`）——与 `PatrolSync` 同一种形式 */
export function RealtimeSync(): null {
  useRealtimeSync()
  return null
}
