import { useEffect } from 'react'
import type { FridgeItem, FridgeZoneGroup } from '@/api/fridge'
import { useFridge } from '@/api/fridge'
import { usePlanBoard, type MealProgressRow, type PlanDay } from '@/api/orders'
import { useAuth } from '@/stores/auth'
import { cancelAll, requestPermission, rescheduleAll, syncScheduled } from './local-notify'
import { SCHEDULE_WINDOW_DAYS, planLocalReminders } from './local-notify.rules'

/**
 * 本机通知的**接线层**（M10 交付二）：什么时候排、用哪些数据排。
 *
 * 三层分开，各自能单独验：
 * - **排什么**（`local-notify.rules.ts`，纯函数）；
 * - **怎么调插件**（`local-notify.ts`，只碰 Capacitor）；
 * - **什么时候调**（这个文件，React 副作用）。
 *
 * ## 默认开启，不给开关（用户 2026-10-14）
 *
 * 原话：「手机上的弹窗提醒要开启啊，这个是默认的，不用设置……删掉这块配置」。
 * 所以这里**没有开关**：登录后如果系统还没问过通知权限，就自动问一次
 * （`prompt` 说明从没问过；问过被拒之后系统不会再弹第二次，那种情况只剩引导，见界面）。
 * 权限给了就自动排，不给就什么都不排、也不反复打扰。
 *
 * ## 关掉 App 也会响（这是本机通知的意义）
 *
 * 排程交给系统的闹钟，**不依赖 App 活着**：应用退到后台、从最近任务划掉，
 * 到点仍然会弹（Android 的 `AlarmManager` 属于系统，进程死了闹钟还在）。
 * 这与"只有打开 App 才看得到"的应用内红点（交付一）是两件事，互为补充。
 *
 * ⚠️ 但**只有本机算得出来的那两类**能这样送：到点该做饭、有东西到期。
 * "别人点了菜"这类远端事件必须在服务端发起，那需要推送通道（见 `RISKS.md` R-63）。
 *
 * ## 什么时候重排
 *
 * 三种时刻：① 应用启动/回到前台；② 手上的数据变了（点菜、定菜单、冰箱加了东西）；
 * ③ 日期跨天（回到前台时"今天到期"变成"昨天到期"）。**不做定时轮询**——
 * 排程是"整批替换"，在"数据可能变了"的那几个点各做一次就够。
 */

/**
 * 把 `/orders/plan` 的形状翻成规则要的形状。
 *
 * 只改字段名（`date` → `day`），**不在这一层做任何判断**——"哪一餐该提醒"全在规则里，
 * 这里多写一句 if 就是在把可测的判断搬进不可测的地方。
 */
export function toPlanRows(days: PlanDay[]): { day: string; meals: MealProgressRow[] }[] {
  return days.map((day) => ({ day: day.date, meals: day.meals }))
}

/** 把冰箱四个区摊平（规则只按 `expiresOn` 判，不在乎在哪一格） */
export function flattenFridge(zones: FridgeZoneGroup[]): FridgeItem[] {
  return zones.flatMap((zone) => zone.items)
}

/**
 * 挂在外壳上的同步器（`TabLayout` 里调一次）。
 *
 * 三件事：**要权限（没问过就问一次）→ 排程 → 数据变了重排**。
 */
export function useLocalNotifySync(): void {
  const userId = useAuth((state) => state.user?.id ?? null)
  const enabled = Boolean(userId)

  // 登录后（且装到手机上）才去读数据：浏览器里白白请求一遍没有意义
  const plan = usePlanBoard({ days: SCHEDULE_WINDOW_DAYS, enabled })
  const fridge = useFridge({ enabled })

  useEffect(() => {
    if (!enabled) {
      /*
       * 没登录（或刚退出登录）：把上一次会话排下的提醒**撤干净**。
       * 那些句子里带着"这家今天吃什么"（菜名、人数），换个人用这台手机不该看得到。
       * 退出登录后 `enabled` 变 false，这一条就是那条清理路径——不必再去
       * 登录/退出的代码里插一句（那些地方现在有四处）。
       */
      void cancelAll()
      return
    }
    let cancelled = false
    void syncScheduled(undefined).then(async (state) => {
      if (state !== 'prompt' || cancelled) return
      // 从没问过 → 自动问一次。用户拒绝后系统不会再弹，这里也就不会再打扰他
      await requestPermission()
    })
    return () => {
      cancelled = true
    }
    // 只跟"登录/登出"走：数据变化由下面那一条负责
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    const run = async () => {
      const reminders = planLocalReminders(
        {
          plan: plan.data ? toPlanRows(plan.data.days) : [],
          fridge: fridge.data ? flattenFridge(fridge.data.zones) : [],
        },
        new Date(),
      )
      // 排程本身会先查权限：没给就一条都不排（那种"排上了"是假的，系统会静默丢掉）
      await syncScheduled(reminders).catch(() => undefined)
      if (cancelled) return
    }

    void run()
    return () => {
      cancelled = true
    }
    // 数据变了就重排一次（整批替换，所以每次都是全量，不必做增删改的差量）
  }, [enabled, plan.data, fridge.data])

  /*
   * 回到前台时重排一次：**日期跨天了**（"今天到期"变成"昨天到期"、今天的做饭提醒
   * 已经响过）。这是唯一一处"不靠数据变化也要重排"的理由——隔夜放在后台的应用
   * 手上的数据是昨天的。
   */
  useEffect(() => {
    if (!enabled) return
    let handle: { remove: () => void } | null = null
    const timer = window.setTimeout(() => {
      void (async () => {
        const { App: CapacitorApp } = await import('@capacitor/app')
        const { Capacitor } = await import('@capacitor/core')
        if (!Capacitor.isNativePlatform()) return
        handle = await CapacitorApp.addListener('resume', () => {
          void plan.refetch()
          void fridge.refetch()
        })
      })()
    }, 0)

    return () => {
      window.clearTimeout(timer)
      handle?.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch 是稳定引用，列进去只会让监听重复挂
  }, [enabled])
}

export { rescheduleAll }
