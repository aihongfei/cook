import { useLayoutEffect, useRef, type ReactNode } from 'react'
import {
  UNSAFE_LocationContext,
  useLocation,
  useNavigationType,
  useOutlet,
  type Location,
  type NavigationType,
} from 'react-router-dom'
import { pageIdentityOf } from '@/lib/scroll-memory'
import {
  finishBackTransitionNow,
  setCachedStateReader,
  setPreviewKeys,
  useBackTransition,
} from '@/lib/back-transition'
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
 * ### 缓存按**路径**分，不按查询串分（2026-10-16 改，D-091）
 *
 * 键是 `pageIdentityOf`（只有 pathname）。查询串在本项目里是**页内状态**——
 * 「我的菜谱」三个 tab、菜谱小书的品类、冰箱「能做点什么」的筛选都写在里面——
 * 按整条地址分键的话，**换一个 tab 就等于把整页卸载重挂**：跟手滑到一半抬手时，
 * 正在播落位动画的那一份被新实例替换掉（动画根本播不出来，用户看到的是一次硬切），
 * 而且每切一次 tab 就在缓存里多留一份整页 DOM。
 * 这与 `use-page-turn` 里的判断同源（「换页」看 pathname，不看整条地址，D-077）。
 *
 * 滚动位置**仍然按整条地址记**（在 `TabLayout` 里，用 `pageKeyOf`）：那是"用户的浏览位置"，
 * 菜谱小书每个品类各记各的滚到哪儿了，正是 D-083 要的。两个键回答两个问题，别合并。
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
 *
 * ### 返回的两层（2026-10-16，D-106）
 *
 * 返回那一趟要**两层同时在屏上**：要离开的那一页向右划走（上层），要回去的那一页
 * 从左边轻轻跟进（下层）。两层就是缓存里的两份 DOM——这正是 keep-alive 白送的能力，
 * 只多两个类名（`tab-layout__page--back-leave` / `--back-enter` + `data-back-phase`）。
 *
 * 三条规矩：
 * - **下层留在文档流里**（它就是"下一页"，只是暂时被上层盖着）：主体滚动位置、滚动记忆、
 *   收尾摆位三件事因此都不用手动兜（两层都 `fixed` 的写法会撞上它们，见 `back-transition` 文件头）；
 * - **上层带自己的滚动**：它变成 `fixed` 之后不再跟着主体滚，所以把它离开时的位置
 *   （`leaveScroll`）在**布局阶段**写进它的 `scrollTop`——同一帧里写完，用户看不到跳；
 * - **上层只要求它自己在缓存里**（它本来就是当前页，永远在）；下层要回去的那一页
 *   即使没缓存（冷启动深链直达详情）也照样在流里——它是这一次导航渲染出来的新页，只是没内容可"原样露出"。
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
  const key = pageIdentityOf(location)

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

  /*
   * 返回那一趟：哪两层在动（见文件头「返回的两层」）。
   */
  const back = useBackTransition()
  const transition = back.phase === 'idle' ? null : back

  const layerRefs = useRef(new Map<string, HTMLDivElement>())

  /*
   * 两层各自把滚动位置写回去（它们都从文档流里拿出来了，不再跟着主体滚）。
   *
   * 必须在**布局阶段**写：同一帧里 DOM 刚被改成 `fixed`，这里接着设好 `scrollTop`、
   * 浏览器才画第一帧——写晚了用户会看到"页面先跳到顶、再滑走"。两层都要摆：
   * 下层要露出的是**它上次停的地方**，不然跟手拖动时看到的不是用户离开时的样子。
   */
  useLayoutEffect(() => {
    if (!transition) return
    const pairs: Array<[string, number]> = [
      [transition.leaveKey, transition.leaveScroll],
      [transition.enterKey, transition.enterScroll],
    ]
    for (const [cacheKey, scroll] of pairs) {
      const el = layerRefs.current.get(cacheKey)
      if (el && el.scrollTop !== scroll) el.scrollTop = scroll
    }
  }, [transition])

  /*
   * 拖动预览要先知道"目标那一页在不在缓存里"（`back-gesture` 在开始拖动时问它）；
   * 而"退回去时目标那一页自己的 state"要从缓存里取回来交还给它（见 back-transition 里
   * `cachedStateOf` 的说明）。两件都在这里同步——每次渲染最多 6 个键，代价可以忽略。
   */
  useLayoutEffect(() => {
    setPreviewKeys([...cache.keys()])
    setCachedStateReader((cacheKey) => cache.get(cacheKey)?.location.state)
  })

  /*
   * 换页即作废：这一趟还在飞的时候用户又去了别的页（点底栏、点通知），
   * 这一趟就没意义了——立刻收掉，别让上层继续盖着新页面。
   *
   * 判据是"当前这一页既不是要走的、也不是要回的"：动画自己那一下导航
   * （key 变成 enterKey）不算作废。
   */
  useLayoutEffect(() => {
    const { phase, enterKey, leaveKey } = useBackTransition.getState()
    if (phase === 'idle') return
    if (key !== enterKey && key !== leaveKey) finishBackTransitionNow()
  }, [key])
  /* oxlint-enable react/refs */

  /*
   * 两层都 `fixed` 之后，主体里没有任何**流内**内容了——浏览器会把它的 `scrollTop`
   * 当场夹成 0，而滚动记忆那一趟 rAF 正好会把夹过的值记下来（R-65 那一族）。
   * 占位块就是拿来顶住这件事的：把两层各自的滚动位置都算进去，撑出足够的可滚高度，
   * 于是整趟动画里主体一动都不动（它上面的值 = 用户离开时那两个位置）。
   */
  const spacerHeight = transition
    ? `calc(${Math.max(transition.leaveScroll, transition.enterScroll)}px + 100%)`
    : undefined

  return (
    <>
      {spacerHeight && <div className="tab-layout__page-spacer" style={{ height: spacerHeight }} aria-hidden />}
      {pages.map(([cacheKey, page]) => {
        const active = cacheKey === key
        const leave = Boolean(transition && cacheKey === transition.leaveKey)
        const enter = Boolean(transition && cacheKey === transition.enterKey)
        return (
          <div
            key={cacheKey}
            ref={(el) => {
              if (el) layerRefs.current.set(cacheKey, el)
              else layerRefs.current.delete(cacheKey)
            }}
            className={[
              'tab-layout__page',
              /*
               * 正在"被盖着往回露"的那一层**不挂换页动画**：这一趟的位移由返回动画给
               * （`use-page-turn` 也在这一趟里不挂类，两处口径一致）。
               */
              active && !enter && activeTurnClass,
              leave && 'tab-layout__page--back-leave',
              enter && 'tab-layout__page--back-enter',
            ]
              .filter(Boolean)
              .join(' ')}
            /*
              拖动那一档还没导航（下层还不是"当前页"），但两层都已经在屏幕上了；
              动画那一档导航已经发生。CSS 靠这个属性分"跟手"和"接着播"两种位移来源。
            */
            data-back-phase={leave || enter ? transition?.phase : undefined}
            /*
              藏起来用 `hidden`：它同时给到读屏与浏览器（`display: none`）——
              缓存页不该被读屏念出来，也不该参与 Tab 键的顺序。
              **正在滑走的那一层与正在露出来的那一层除外**（它们就是要被看见的）。
            */
            hidden={!active && !enter && !leave}
            /*
              滑走的那一层是纯装饰：读屏不该念它，它也不该接走点击
              （0.24 秒里手停在屏幕上的那一下，本来就该落在下层）。
            */
            aria-hidden={leave || undefined}
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
}
