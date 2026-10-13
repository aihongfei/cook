import { tabs } from '@/config/tabs'

/**
 * 子页面的「返回」入口（F0-05 的统一样式，跨页传来源的那套 state 的唯一读取处）。
 *
 * 为什么要有这个模块：**每个子页面自己维护一份白名单**的话，加一个新入口就会漏
 * ——实战踩过：发现页的「摇一道」带 `from: '/discover'` 进菜谱详情，而详情页只认
 * `/kitchen` 与 `/recipes`，于是那个值被静默丢掉、返回按钮指向菜谱小书。
 * 用户点了"摇一道"却退到另一个页面，只会觉得"这功能坏了"。
 *
 * 所以白名单**只在这里定义一次**：
 * - 底部 5 个 Tab 直接从 `config/tabs` 取（加 Tab 自动生效，不用回来改）；
 * - 再加"不在 Tab 里但有返回价值"的页（菜谱小书）；
 * - **带查询串的路径**按前缀放行（`/recipes?q=鱼` 是菜谱小书的一种状态），
 *   但仍然要求它以某个已知入口开头——不能拿一个 `/../evil` 之类的字符串当返回目标。
 */
const EXTRA_ENTRIES: Record<string, string> = {
  '/recipes': '返回菜谱小书',
  // 「我的菜谱」是个独立子页（F1-12）：卡片点进详情时带的就是这个来源，
  // 不列在这儿就会静默退到菜谱小书——用户从自己的菜谱点进去，返回却到了公共库里
  '/recipes/mine': '返回我的菜谱',
  // 备菜计划与常用组合都是独立子页（不在底部 Tab 里），从它们进了菜谱小书之后返回要能回到原处
  '/prep': '返回备菜计划',
  '/shopping': '返回采购清单',
  '/order/history': '返回点单历史',
  '/favorites': '返回我收藏的菜',
  '/combos': '返回常用组合',
}

/** 路径 → 返回按钮文案；**只含已放行的入口**（查表就等于校验） */
export const BACK_LABELS: Record<string, string> = {
  ...Object.fromEntries(tabs.map((tab) => [tab.path, `返回${tab.label}`])),
  ...EXTRA_ENTRIES,
}

/** 能从来源里认出的"返回目标"（`/recipes?q=鱼` 这类带查询串的按前缀认） */
function matchEntry(raw: string): string | null {
  if (raw in BACK_LABELS) return raw
  const [path, query] = raw.split('?', 2)
  if (query !== undefined && path in BACK_LABELS) return `${path}?${query}`
  return null
}

/**
 * 返回按钮上的字。
 *
 * 表里查得到就用表里的；查不到的是**菜谱详情**这种"动态路径"——它的目标里带着一个 id，
 * 没法写进静态表。这时给一句准确的话（"返回这道菜谱"），而不是干巴巴一个"返回"：
 * 编辑页夹在中间，它的返回目标正是详情（`/recipes/<id>`），
 * 表里没有它就落到了一个没有主语的按钮上。
 */
function labelFor(path: string): string {
  const listed = BACK_LABELS[path]
  if (listed) return listed
  // `/recipes/<id>`（详情）——排除 `mine`/`new`/`<id>/edit` 这几个同样在 /recipes 下的子页
  if (/^\/recipes\/[^/]+$/.test(path) && path !== '/recipes/mine' && path !== '/recipes/new') return '返回这道菜谱'
  return '返回'
}

/**
 * 来源路径属于底部哪个 Tab（认不出返回 null）。
 *
 * 用途：**菜谱页该高亮哪个 Tab**。菜谱列表/详情不在 Tab 里，原先一律高亮「厨房」，
 * 于是从发现页「摇一道」过去后底栏亮的是厨房——用户点那个亮着的 Tab 就落到厨房菜单页，
 * 而他是从发现页过来的（实测踩过）。
 */
export function tabOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const path = raw.split('?', 1)[0]
  return tabs.some((tab) => tab.path === path) ? path : null
}

/**
 * 读路由 state 里的来源，翻成可用的返回目标；认不出来就用 `fallback`（必填——每个子页面
 * 自己知道"没有来源时退到哪最合理"，比如家庭页退「我的」、菜谱详情退菜谱小书）。
 *
 * **路由 state 是外部输入**：可能是昨天留下的链接（那个页面已经改了名）、也可能是手改的值。
 * 认不出来就退回兜底，绝不把一个未校验的字符串直接塞进 `<Link to>`。
 */
export function readBackLink(state: unknown, fallback: string): { to: string; label: string } {
  const requestedFrom = (state as { from?: unknown } | null)?.from
  const matched = typeof requestedFrom === 'string' ? matchEntry(requestedFrom) : null
  const to = matched ?? fallback
  // 文案按**路径**取（`/recipes?q=鱼` 的键是 `/recipes`）：拿带查询串的完整值查表会落空，
  // 返回按钮就变成干巴巴一个"返回"（自己写的测试当场抓出来的）
  const path = to.split('?', 1)[0]
  return { to, label: labelFor(path) }
}

/**
 * 中间页**替下一站收着**的那份 state（现在用在菜谱详情 → 编辑这条链上）。
 *
 * 为什么需要它：编辑页是夹在中间的一页——它的返回目标是**菜谱详情**，而详情页自己
 * 还有来源（「我的菜谱」）。中间页如果不把这份来源收好再还回去，链条就断了：
 * 我的菜谱 → 详情 → 编辑 → 返回详情 → 再返回会落到菜谱小书，而不是我的菜谱
 * （用户 2026-10-13 报的正是这个）。
 *
 * 所以从详情进编辑时把详情那份 state 塞进 `carry`，回详情时原样交还，
 * 详情页"从哪来"就一直是当初那一份。**校验仍然在读取处**（详情页自己会过
 * `readBackLink`），这里只保证交还的是一个普通对象、不把形状弄坏。
 */
export function readCarry(state: unknown): Record<string, unknown> | undefined {
  const carry = (state as { carry?: unknown } | null)?.carry
  if (carry === null || typeof carry !== 'object' || Array.isArray(carry)) return undefined
  return carry as Record<string, unknown>
}
