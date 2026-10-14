/**
 * 页面缓存的淘汰规则（`KeepAlivePages` 用，见那个文件头的说明）。
 *
 * 单独一个 `.ts` 是为了**不进 DOM 直接单测**——它只有一条判断（超过上限丢谁），
 * 而写错的表现是"返回某一页时它被重挂了"或"内存越用越多"，两种都不容易看出来。
 */

/**
 * 最多同时留着几页。
 *
 * 六个的来由：底栏五个 Tab 加上"从某一页点进去的那一页"，正好够那个最常见的来回
 * （列表 → 详情 → 返回 → 再进另一个详情）。再多也不会用上——用户不会同时"停在"十几页里，
 * 而那些页各自带着一份接口缓存与 DOM（菜谱小书还能翻几百张卡），留着只涨内存。
 */
export const MAX_CACHED_PAGES = 6

/**
 * 该丢掉哪些键：保留当前这一页 + 最近用过的 `max - 1` 个，其余丢掉。
 *
 * `keys` 按**最近使用**排序（用得越晚越靠后，调用方每次渲染把当前页挪到末尾）。
 * 当前这一页**永远不丢**——它是正显示着的那一页，丢掉它等于把用户眼前的页面卸载重挂。
 */
export function evictKeys(keys: string[], currentKey: string, max = MAX_CACHED_PAGES): string[] {
  const keep = new Set<string>([currentKey])
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    if (keep.size >= max) break
    keep.add(keys[index])
  }
  return keys.filter((key) => !keep.has(key))
}
