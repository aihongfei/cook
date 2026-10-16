import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { readBackLink } from '@/pages/back-link'

/**
 * 「这一页按返回该去哪」的登记表（2026-10-16，D-105）。
 *
 * ## 为什么要有它
 *
 * 页面上那颗「← 返回」的目标，各页本来就在算（`readBackLink(location.state, …)`：
 * 进来时带的那份来源 state）。但**返回键**在 `android-back` 那一层，
 * 它不知道任何一页的来龙去脉——原来只能去 `history.back()`，于是退进了浏览器历史
 * （用户报的那两条怪行为都从这儿来，见 `back-policy` 文件头）。
 *
 * 与其在返回键那一层"再算一遍来源"（两处各算一遍，迟早有一处漏改——本项目在
 * "同一个键两处各拼一次"上栽过两次，见 D-078 四），不如让**页面自己顺手登记**：
 * `useBackLink` 拿到的就是那颗箭头用的同一个值，登记进这张表。
 * 于是返回键与页面上那颗箭头**按构造是同一个目标**，不存在对不齐的可能。
 *
 * ## 为什么不清理
 *
 * 表是 `路径 → 返回目标`，一条几十字节；上限是"这次会话去过的页数"。
 * 清理要求这里盯着 keep-alive 的淘汰名单（跨模块），收益是几十字节——
 * 不值得（真要清，得先让 keep-alive 把淘汰事件发出来）。
 * 真实性的保障不靠清理，而靠**每次渲染都重新登记**：同一路径再进去时，
 * 这一页会用新的来源把旧值覆盖掉。
 */
const targets = new Map<string, string>()

/** 登记「人在这一页时按返回去哪」。由 `useBackLink` 调用，页面自己不用手写 */
export function registerBackTarget(pathname: string, to: string): void {
  targets.set(pathname, to)
}

/** 这一页登记的返回目标（没人登记就 null，交给 `resolveBack` 的兜底） */
export function backTargetOf(pathname: string): string | null {
  return targets.get(pathname) ?? null
}

/** 注销（页面真的卸载时），只删还是自己那份登记的情况 */
export function unregisterBackTarget(pathname: string, to: string): void {
  if (targets.get(pathname) === to) targets.delete(pathname)
}

/** 测试用：模块级状态，用例之间必须互不影响 */
export function clearBackTargets(): void {
  targets.clear()
}

/**
 * 子页面算「返回去哪」的**唯一入口**（替代原来各页自己调 `readBackLink`）。
 *
 * 它做两件事，而且必须是同一件：① 给出箭头要的目标与文案；② 把同一个目标登记给返回键。
 * 分开写就等于允许两者分叉。
 *
 * 参数与 `readBackLink` 逐字一致（`state` 传 `location.state`）——这样各页的那一行
 * 只是把函数名换掉，读的人一眼看得出"还是同一件事"。
 *
 * ⚠️ 页面**必须用它**、不许再直接调 `readBackLink`：有一条守卫测试在扫这件事
 * （`back-target.test.ts`）——漏一页的症状是"这颗箭头好好的，系统返回键去了别处"，
 * 光靠人眼看代码看不出来。
 */
export function useBackLink(state: unknown, fallback: string): { to: string; label: string } {
  const location = useLocation()
  const { to, label } = readBackLink(state, fallback)
  const pathname = location.pathname

  useEffect(() => {
    registerBackTarget(pathname, to)
    return () => unregisterBackTarget(pathname, to)
  }, [pathname, to])

  return { to, label }
}
