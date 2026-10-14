/**
 * 「又点了一次当前这个 Tab」这件事（用户 2026-10-14：「重复点击订单tab时自动滚到
 * 通知的那个卡片位置」）。
 *
 * 为什么走事件而不是给页面传 props：底部栏在 `TabLayout` 里，而"哪一张卡有提醒"
 * 只有页面自己知道（订单页握着 `notifications` 与卡片列表）。让外壳去算这件事，
 * 就等于把"哪一餐有事"那套判据复制到第二个地方——本项目在"同一个键/同一份数
 * 两处各算一遍"上栽过不止一次（D-059 三、D-078 四），所以外壳只负责喊一声。
 *
 * 只在**已经站在这一页**时发（`pathname === path`）：从别的页点过来是一次正常
 * 跳转，那不是"再点一次"，页面照常从头渲染、滚动位置本来就归零。
 */
export const TAB_RETAP_EVENT = 'cook:tab-retap'

export function emitTabRetap(path: string): void {
  window.dispatchEvent(new CustomEvent(TAB_RETAP_EVENT, { detail: { path } }))
}

/** 订阅某个 Tab 的"再点一次"；返回值就是取消订阅（直接用作 `useEffect` 的清理）。 */
export function onTabRetap(path: string, handler: () => void): () => void {
  const listener = (event: Event) => {
    if ((event as CustomEvent<{ path?: string }>).detail?.path !== path) return
    handler()
  }
  window.addEventListener(TAB_RETAP_EVENT, listener)
  return () => window.removeEventListener(TAB_RETAP_EVENT, listener)
}
