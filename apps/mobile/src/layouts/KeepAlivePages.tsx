import { useRef, type ReactNode } from 'react'
import {
  UNSAFE_LocationContext,
  useLocation,
  useNavigationType,
  useOutlet,
  type Location,
  type NavigationType,
} from 'react-router-dom'
import { pageKeyOf } from '@/lib/scroll-memory'
import { evictKeys } from './keep-alive.rules'

/**
 * 页面缓存（用户 2026-10-14：「你是不是使用类似vue keepalive那种就行了，不光是滚动位置，
 * 就相当于是有缓存的，不是重新加载页面」）。
 *
 * 这是**对的做法**，我第一版只存滚动位置是治标：位置还存在，但页面本身重挂了——
 * 筛选、翻到第几页、输入框里的字、展开的卡片全都丢，回到那一页要重新加载、重新滚。
 *
 * 于是这里做的是真缓存：**离开的页面不卸载，只是藏起来**（`hidden`），回来时原样还在。
 *
 * ### 两个必须一起解决的问题
 *
 * **① 缓存页读到的"当前位置"会是别人的**。`useLocation()` 读的是路由上下文，而缓存页
 * 还在树上——它会把**当前**地址当成自己的。于是 `/order/2026-10-14-LUNCH` 那页在缓存里
 * 会以为自己是 `/fridge`，它的链接、`state.from`、相对跳转全跟着错。所以每一页用
 * `UNSAFE_LocationContext.Provider` **冻结在自己被缓存那一刻的地址上**（这是 react-router
 * 内部给 `MemoryRouter` 用的同一套机制，值形如 `{ location, navigationType }`）。
 *
 * 这也是为什么不缓存 `useParams`：**参数不用我们管**——路由元素在被创建时就把
 * `RouteContext`（含 matches 与 params）包在自己的子树里了，缓存这个元素正好把参数一起冻住。
 * 所以详情页（`/order/:mealKey`、`/recipes/:id`）缓存起来也是对的。
 *
 * **② 缓存不能无限涨**：留最多 `MAX_CACHED_PAGES` 页，超了丢最久没用过的（见 keep-alive.rules）。
 *
 * ### 藏起来的那一页仍然是"活"的
 *
 * 这是 keep-alive 与生俱来的代价，项目里已经逐条查过：
 * - **页面里没有定时器**（唯一一处 `setInterval` 在 AI 聊天的等待提示里，随抽屉关闭而停）；
 * - **列表的翻页观察器**挂在共享滚动容器上：藏起来的那一页 `display: none`，
 *   观察目标不与之相交，因此**不会**在背后偷偷翻页；
 * - **弹层**：`BottomSheet`（antd-mobile 的 `Popup`）就地渲染，跟着页面一起藏；
 *   两个挂到 `body` 的（`ImageViewer` / `ConfirmDialog`）由它们自己在**地址变了就关掉**
 *   （见那两个文件里的说明）——不关的话它们会盖在**别的页**上面；
 * - **抽屉里跳走**：`ConfirmMenuSheet` 的「去采购清单」原来不关抽屉就走，现在先关再走
 *   （不关的话那一层会在藏起来的页面上继续抢系统返回键）。
 *
 * 换页动画不在这里：当前这一页由外面挂类名（`activeTurnClass`），缓存页不挂——
 * 它们不参与那 0.24 秒。
 */
interface CachedPage {
  node: ReactNode
  location: Location
  navigationType: NavigationType
}

export default function KeepAlivePages({ activeTurnClass }: { activeTurnClass: string }) {
  const outlet = useOutlet()
  const location = useLocation()
  const navigationType = useNavigationType()
  const key = pageKeyOf(location)

  /*
   * 缓存写在渲染期而不是 effect 里：`useOutlet()` 拿到的元素**只在当前这次渲染有效**
   * （下一次渲染它是另一个元素，而它对应的路由上下文也只有那一刻是对的）。放进 effect 就晚了——
   * 那时取到的已经不是刚渲染的这一页。
   *
   * 写 ref 通常要避开（渲染必须能被重复执行），这里是**例外且必须**：同一个 key 反复写
   * 同一份内容，是幂等的；StrictMode 把渲染跑两遍也不会多出什么（`Map.set` 覆盖同一个键）。
   * vue 的 `<keep-alive>` 在渲染里缓存 VNode 是同一件事——React 侧没有别的写法能做到
   * "读到刚渲染的这一份元素"。所以下面这几行**有意**绕开 lint 的 `react/refs`。
   */
  /* oxlint-disable react/refs -- 见上一段：缓存必须在渲染期写，且是幂等的 */
  const cacheRef = useRef(new Map<string, CachedPage>())
  const cache = cacheRef.current
  // 先删再放：Map 的迭代顺序就是"最近用过的在后"，淘汰规则靠它
  cache.delete(key)
  cache.set(key, { node: outlet, location, navigationType })
  for (const stale of evictKeys([...cache.keys()], key)) cache.delete(stale)

  /*
   * 下面这段读缓存来画页面，**也在渲染期**——同一个例外，所以 `oxlint-disable` 一直到
   * 函数末尾才收（中间那个返回的 JSX 里也要读它）。
   */
  const pages = [...cache.entries()]

  return (
    <>
      {pages.map(([cacheKey, page]) => {
        const active = cacheKey === key
        return (
          <div
            key={cacheKey}
            className={['tab-layout__page', active && activeTurnClass].filter(Boolean).join(' ')}
            /*
              藏起来用 `hidden`：它同时给到读屏与浏览器（`display: none`）——
              缓存页不该被读屏念出来，也不该参与 Tab 键的顺序。
            */
            hidden={!active}
          >
            {/*
              冻结这一页自己的地址（见文件头 ①）。必须在**每一页**外面各包一层：
              包在公共父层上的话，所有缓存页会共用最后那一个地址。
            */}
            <UNSAFE_LocationContext.Provider
              value={{ location: page.location, navigationType: page.navigationType }}
            >
              {page.node}
            </UNSAFE_LocationContext.Provider>
          </div>
        )
      })}
    </>
  )
  /* oxlint-enable react/refs */
}
