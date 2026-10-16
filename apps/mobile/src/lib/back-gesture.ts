import { onBackGesture, setBackGestureEnabled, type BackGestureEvent } from '@/api/back-gesture-native'
import { backCloserCount, handleBackPress, subscribeBackCloserChanges } from './android-back'
import { resolveBack } from './back-policy'
import { backTargetOf } from './back-target'
import {
  beginBackDrag,
  cancelBackDrag,
  isBackTransitionActive,
  setBackDragProgress,
  useBackTransition,
} from './back-transition'

/**
 * 返回手势的**跟手**（用户 2026-10-16：「需要返回那种从底层页面上方划过的那种效果，
 * 就和原生那种似的」；D-109）。
 *
 * ## 它补的是最后一格
 *
 * 到 `back-transition` 为止，返回已经是"松手后两页各滑一趟"。用户要的那种"划过去"
 * 还差一段：**手指拖到哪儿，页面跟到哪儿**。系统能给这个进度
 * （`BackEvent.progress`，Android 14+），但 Capacitor 官方的插件只送"按了一下"，
 * 所以自己写了一个（见 `api/back-gesture-native`）。
 *
 * ## 四件事各自的处理
 *
 * | 原生事件 | 这里做什么 |
 * | --- | --- |
 * | `start` | 算一次"这一趟要去哪"，能预览就先摆好两层（`beginBackDrag`） |
 * | `progress` | 把进度写进 CSS 变量（**不进 React**，见 `back-transition` 文件头） |
 * | `cancel` | 缩回原位（拖到一半又松开手指、没退成） |
 * | `press` | 松手/实体键：走**统一的那一次判定**（`handleBackPress`） |
 *
 * ## 为什么"接不接管"要提前算，而不是等手势来了再决定
 *
 * 系统在**手指刚碰边缘**时就要知道这次归谁：归我们，它才派发 `start`/`progressed`；
 * 不归我们，它自己播"窗口缩回桌面"的那套预览。而"归不归我们"正是返回语义那套判据
 * （子页归我们、弹层开着归我们、**厨房根页不归我们**——那一下要让系统自己演）。
 * 所以下面这只 `syncBackGesture()` 是**主动同步**的：位置一变、弹层一开一关就重算一次。
 *
 * ## 一个必须分清的时刻
 *
 * `press` 有两种来路：**松手那一帧**（手势，前面有 `start`/`progress`）与
 * **实体返回键**（没有手势过程）。两者的处理其实一样——都交给 `handleBackPress`：
 * 它先关弹层、再按 `resolveBack` 决定退出还是回上一层；而"退回去"那条路上
 * `startBackNavigation` 看见当前正在拖动，会**接着当前进度播完**（不是从头再来）。
 * 区别只是"弹层开着时"手势那一路不该把两页摆出来（用户要关的是抽屉，不是页面），
 * 所以 `start` 里对弹层做了短路。
 */

/**
 * 现在这一趟归不归我们管。
 *
 * - **有弹层**：归我们（返回键要用来关抽屉；手势也一样）；
 * - **判据说"回某一页"**：归我们（要跟手、要播两层）；
 * - **判据说"退出"**（在厨房根页）：**不归我们**——让系统自己播退出预览。
 */
export function shouldHandleBackGesture(): boolean {
  if (backCloserCount() > 0) return true
  return resolveBack({ pathname: window.location.pathname, target: backTargetOf(window.location.pathname) }).type === 'go'
}

/** 把当前判据同步给原生（位置一变、弹层一开一关都要调一次） */
export function syncBackGesture(): void {
  const next = shouldHandleBackGesture()
  /*
   * 同值不发第二次：`TabLayout` 每次换页都会喊一声（它是最可靠的"位置变了"信号），
   * 而每次换页都跨桥调一次原生既没必要、也会在快速换页时堆一串 Promise。
   */
  if (next === lastSynced) return
  lastSynced = next
  void setBackGestureEnabled(next).then((ok) => {
    /*
     * **落空要重试**：插件在启动早期还没挂上时（`main.tsx` 那一行跑在 bridge 就绪之前），
     * 这次调用会失败——而记号已经写下了，不抹掉的话**这个值永远不会再发一次**。
     * 表现正是"明明改了判据，返回键却按老规矩走"（装机实测踩到过）。
     */
    if (!ok && lastSynced === next) lastSynced = null
  })
}

let lastSynced: boolean | null = null

/** 处理一次原生事件。抽成纯入口是为了能单测（真实事件要真机才有） */
export function handleBackGestureEvent(event: BackGestureEvent): void {
  switch (event.kind) {
    case 'start': {
      // 弹层开着：这一趟是"关抽屉"，不摆两页（摆了反而把背后的页面拽出来）
      if (backCloserCount() > 0) return
      const target = backTargetOf(window.location.pathname)
      const decision = resolveBack({ pathname: window.location.pathname, target })
      if (decision.type !== 'go') return
      // 预览得了就摆好两层；预览不了（目标不在缓存里）就什么都不做——
      // 松手时 `handleBackPress` 会照常整段播一遍
      beginBackDrag(decision.to)
      return
    }
    case 'progress': {
      if (useBackTransition.getState().phase !== 'dragging') return
      setBackDragProgress(event.progress ?? 0)
      return
    }
    case 'cancel': {
      cancelBackDrag()
      return
    }
    case 'press': {
      /*
       * 松手或实体键：走统一判定。
       *
       * ⚠️ 这里**不**判断"有没有在拖动"就去决定动作：拖动只是动画的起点不同，
       * 去哪儿由 `handleBackPress` 一处说了算（与服务端返回键同一条路）。
       */
      handleBackPress()
      /*
       * 判定完立刻重算一次接管状态：这一趟之后可能已经在厨房根页了
       * （那次返回正是"回厨房"），下一次手势就该交给系统。
       */
      syncBackGesture()
      return
    }
  }
}

/**
 * 装一次即可（`main.tsx` 调）。返回卸载函数；浏览器里是空实现。
 *
 * 装完立刻 `syncBackGesture()` 一次：原生插件起手是"接管"的（见它的 `load()`），
 * 这里按真实判据校正——比如冷启动落在厨房根页时，第一次手势就该归系统。
 */
export function installBackGesture(): () => void {
  let unsubscribe: (() => void) | null = null
  void onBackGesture((event) => handleBackGestureEvent(event)).then((off) => {
    unsubscribe = off
  })

  /*
   * 两个"判据变了"的信号源：
   * - **弹层开合**（`android-back` 的订阅）：在厨房根页打开一个抽屉之后，
   *   返回该用来关抽屉而不是退出——不同步的话那一次会被系统当成"退出应用"；
   * - **`popstate`**：浏览器前进/后退（手势与按钮之外的第三条路）。
   *
   * 换页那一条由 `TabLayout` 主动喊（路由的编程式跳转不发 `popstate`，
   * 而"人在哪一页"是那个组件每次渲染都知道的事实）。
   */
  const offClosers = subscribeBackCloserChanges(syncBackGesture)
  window.addEventListener('popstate', syncBackGesture)

  syncBackGesture()

  return () => {
    offClosers()
    window.removeEventListener('popstate', syncBackGesture)
    unsubscribe?.()
  }
}

/** 测试用：清掉去重状态（用例之间必须互不影响） */
export function resetBackGestureListeners(): void {
  lastSynced = null
}

export { isBackTransitionActive }
