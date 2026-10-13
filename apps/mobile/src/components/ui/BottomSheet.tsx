import { Popup } from 'antd-mobile'
import { registerBackCloser } from '@/lib/android-back'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'

interface BottomSheetProps {
  visible: boolean
  title?: string
  /** 高度，默认自适应内容 */
  height?: string
  /**
   * 内容区（`.sheet__body`）上的附加类名。
   *
   * 给**对话型**抽屉用（AI 助手 / 问 AI）：它们要"上面那段对话滚、底部输入行钉住"，
   * 否则键盘起来时输入框会被裁掉（见 ui.scss 的 `.sheet__body--chat` 与用户 2026-10-14 的反馈）。
   */
  bodyClassName?: string
  onClose: () => void
}

export interface BottomSheetHandle {
  /** 播完退场动画再通知调用方卸载（写入成功后自动收起走这里） */
  close: () => void
}

/** 退场兜底：弹簧正常约 300ms 停下，超过这个时间还没回调就自己收尾（见 close 里的说明） */
const EXIT_FALLBACK_MS = 420

/** 往下拖多远算"要关掉"（再近就弹回去） */
const DRAG_CLOSE_DISTANCE = 110
/** 甩这么快也算关：不必拖满上面那段距离（px/ms，人手快甩一般 > 2） */
const DRAG_CLOSE_VELOCITY = 1.2
/** 起手阈值：位移不到这个数不接手势——否则按下时的手抖会把面板带歪（点按钮也会） */
const DRAG_SLOP = 8
/** 拖完收尾的动画时长，要和下面的复位计时器对得上 */
const DRAG_SETTLE_MS = 200

/**
 * 底部抽屉（F0-05）：封装 antd-mobile Popup，统一圆角与配色。
 *
 * ⚠️ 为什么要自己管一层 shown（动过这段才看得懂）：
 * antd-mobile 的 Popup 只在 `visible` **由 false 变 true** 时才播入场动画。而本项目的用法是
 * 「打开时才挂载、visible 直接写 true」（见 DiscoverPage），Popup 一上来就是"已经开着"，
 * 于是每张抽屉都是"啪"地出现——用户 2026-10-12 指着 AI 对话说「出来时要加个滑动出来，
 * 不要这种生硬的」。所以这里先渲染成关着的、再翻成开着，让动画有起始值（见下面的 effect）。
 *
 * 关闭同理：调用方的 onClose 一执行就把抽屉卸载了，退场动画来不及播。所以关闭先走 `close()`
 * （遮罩点击也走它），等 Popup 的 `afterClose`（弹簧停下那一刻）再回调 onClose。写入成功后要
 * 自动收起的页面用 `ref` 拿 `close()`——**直接调自己的 onClose 就没有退场动画**。
 *
 * ⚠️ 另外两件都是 2026-10-13 用户当场提的（「上面直接超出屏幕了」/「有没有跟随手指拖动」）：
 *
 * ① **高度封顶 + 内容自滚**：Popup 贴底放，内容多高就往外顶多高——冰箱那个录入抽屉是 882px，
 *    而手机可视区 844px，于是**顶部直接顶出屏幕**（量到的 top 是负的）。所以这里给面板
 *    `max-height: 88vh` 并让内容区自己滚（`.sheet__shell` / `.sheet__body` 见 ui.scss）。
 *    注意滚动写在**内容区**而不是面板上：标题留在原地不跟着滚。
 * ② **跟随手指下拖关掉**（原生那种）：手指能拖动整个面板、松手时按距离或甩的速度决定
 *    关掉还是弹回。三个刻意的细节（照原生的手感定的）：
 *    - **横划、上划都不抢**：横划留给上层（将来横向的东西），上划是"我要看下面"——那是滚动；
 *    - **手指底下那块自己能滚、且还没到顶时也不抢**（`scrollTop > 0`）：那是在滚内容；
 *    - **位移直接写 style，不进 React state**：拖动是每帧都来的，走 state 会把整棵子树重渲一遍。
 *    之所以用原生监听而不是 onTouchMove：React 的 touchmove 是 passive 的，
 *    `preventDefault()` 叫不停原生滚动（抽屉会被页面滚动一起带歪）。
 */
const BottomSheet = forwardRef<BottomSheetHandle, PropsWithChildren<BottomSheetProps>>(
  function BottomSheet({ visible, title, height, bodyClassName, onClose, children }, ref) {
    const [epoch, setEpoch] = useState(0)
    const [shown, setShown] = useState(false)
    // 记下"这次关闭是我发起的"：调用方自己把 visible 置 false 时不该再回调 onClose（会关两次）
    const closing = useRef(false)
    const exitTimer = useRef<number | null>(null)
    // 装在抽屉内部内容上：用来判断"内容还在不在"（见下面调用方关闭的那段兜底）
    const contentRef = useRef<HTMLDivElement>(null)
    // 手势的卸载函数。挂在 ref 回调里（见下面 attachDrag 的说明），不是 effect 里
    const detachDrag = useRef<(() => void) | null>(null)
    // 面板"现在是开着的吗"，给 ref 回调判断该不该清掉上次拖关留下的隐藏状态。
    // 在渲染期直接写（不是 effect）：ref 回调早于 effect 跑，effect 里写会慢一拍（踩过）。
    const shownRef = useRef(false)
    // onClose 每次渲染都是新的箭头函数，兜底计时器里要用"最新那个"
    const closeCallback = useRef(onClose)
    useEffect(() => {
      closeCallback.current = onClose
    }, [onClose])

    useEffect(() => {
      /*
       * 先以"关着"的状态渲染一帧，再打开：Popup 里的 spring 初值会落在 100%（屏幕外），
       * 收到 0% 时才有一段从下往上的插值——滑动就是这么来的。
       * 若一开始就 visible=true（本项目原来的写法），spring 的初值直接等于终点，等于没有动画。
       *
       * 下面这句会被 lint 的 react(set-state-in-effect) 点上。规则的本意是"别用 effect 派生状态"，
       * 而这里要的恰恰就是**两个渲染本身**（先关着、再打开）——渲染期写不了，初始化也不能直接给
       * true（给了就退化成"一上来已经开着"）。所以就地豁免，而不是绕成更难懂的写法。
       */
      // oxlint-disable-next-line react/set-state-in-effect
      setShown(visible)
      if (visible) return

      /*
       * 调用方自己把 visible 置 false（KitchenPage 那种"常驻 + 开关"的用法）：退场交给 Popup 播。
       * 但**弹簧没得跑时它不会回调**——同一帧里开了又关就是这种情况（目标值等于当前值，无动画可播），
       * afterClose 不来、Popup 的 active 一直是 true：内容卸不掉、遮罩挡着、页面滚不动。
       * 所以过一会儿看一眼内容还在不在，还在就把 Popup 整块重挂一次，等价于立刻回到"关着"。
       * （这里**不能回调 onClose**：调用方自己关的，再回调一次可能触发别人重复的收尾动作。）
       */
      const timer = window.setTimeout(() => {
        if (contentRef.current) setEpoch((value) => value + 1)
      }, EXIT_FALLBACK_MS)
      return () => window.clearTimeout(timer)
    }, [visible])

    /** 退场收尾：动画播完（或兜底到点）才通知调用方卸载 */
    const finishClose = useCallback(() => {
      if (exitTimer.current !== null) {
        window.clearTimeout(exitTimer.current)
        exitTimer.current = null
      }
      if (!closing.current) return
      closing.current = false
      closeCallback.current()
    }, [])

    const close = useCallback(() => {
      if (closing.current) return // 连点遮罩、或两个关闭入口先后触发，都只关一次
      closing.current = true
      setShown(false)
      /*
       * 兜底计时器：退场回调（afterClose）挂在弹簧"跑完"那一刻，而弹簧**没得跑**时不会回调——
       * 抽屉刚挂载、入场第一帧还没画就被关掉（此时目标值等于当前值，无动画可播）就是这么一种。
       * 少了这条，抽屉会卡在屏幕上永远关不掉（用户点不出去了）。EXIT_FALLBACK_MS 比动画略长。
       */
      exitTimer.current = window.setTimeout(finishClose, EXIT_FALLBACK_MS)
    }, [finishClose])

    useImperativeHandle(ref, () => ({ close }), [close])

    /**
     * 系统返回键先关抽屉（F14-01 / R-13 ①）：安卓用户按返回时的第一预期是"退掉眼前这一层"，
     * 而 WebView 不会替我们做这件事（不接管的话返回键在二级页上毫无反应）。
     *
     * 登记的是 `close` 而不是 `onClose`：`close` 会先播退场动画、再由 afterClose 回调 onClose，
     * 走 onClose 会让抽屉"啪"地消失（与点遮罩关掉的手感不一致）。
     * 依赖 `shown`：只有真开着的时候才该抢返回键——收起过程中（shown=false）还登记着的话，
     * 用户连按两次返回，第二次会被这个正在消失的抽屉吃掉。
     */
    useEffect(() => {
      if (!shown) return
      return registerBackCloser(close)
    }, [shown, close])

    // 渲染期记下"现在开着没"（ref 回调早于 effect 跑，写在 effect 里会慢一拍）
    shownRef.current = shown

    // 卸载时清掉兜底计时器：否则到点后会在一个已经不存在的抽屉上做收尾（close 的回调不该迟到）
    useEffect(
      () => () => {
        if (exitTimer.current !== null) window.clearTimeout(exitTimer.current)
      },
      [],
    )

    /**
     * 跟随手指下拖（原生手感）。只写 style 不动 state。
     * 手势判定的三个阶段：`deciding`（还没决定要不要接）→ `dragging`（接了）→ 松手收尾。
     *
     * 触摸与鼠标走同一套判定，只是入口分开：真机上是手指（触摸），桌面/开发时是鼠标。
     * 鼠标那条多一个"别在输入框里拖"的例外（那时用户是在选文字）。
     *
     * ⚠️ 为什么这里返回一个"装卸函数"、由下面的 ref 回调调用，而不是写成 useEffect：
     * **抽屉内容是在 spring 跑起来之后才挂到 DOM 上的**（antd-mobile 这套延迟挂载，本项目已在
     * R-031 踩过一次：那时症状是遮罩不出现）。所以"effect 跑的时候 shellRef.current 还是 null"，
     * 而 effect 的依赖（shown）不会再变——监听**永远挂不上**，手势看着像没实现。
     * ref 回调恰好在节点真正挂上/卸下时各调一次，没有这个时间差。
     */
    const attachDrag = useCallback((shell: HTMLElement): (() => void) => {
      // 真正要位移的是面板本体（`.adm-popup-body`）：拖外壳的话背板不动，会露出下面的页面
      const panel = (shell.closest('.adm-popup-body') as HTMLElement | null) ?? shell
      /*
       * 监听**挂在整个面板上**，不是挂在内层 `.sheet__shell` 上（用户 2026-10-14：
       * 「这个弹出窗用鼠标拖不动」）。
       *
       * 死区是实测出来的：面板比内容外壳多两圈内边距（上面 18px、下面再叠一份
       * `--safe-bottom` 的 44px），而监听原先只在外壳上——于是**顶边那条最容易抓的地方
       * 恰恰拖不动**。逐点测过：从顶边起拖「无位移、关不掉」，从标题行与内容中段起拖都能拖走。
       * 抓顶边往下拖是用户面对底部抽屉最自然的动作，它必须有效。
       */
      const dragSurface = panel

      let startX = 0
      let startY = 0
      let delta = 0
      let lastY = 0
      let lastAt = 0
      let velocity = 0
      let phase: 'idle' | 'deciding' | 'dragging' = 'idle'
      let scrollHost: HTMLElement | null = null
      let settleTimer: number | null = null
      // 触摸这条路要叫停原生滚动；鼠标不用（页面不会跟着动）
      let preventNative = false
      // "这次卸载是拖关引起的"：清理时**不能**清样式（原因见下面 cleanup 的说明）
      let closedByDrag = false

      /** 手指底下那块如果自己能滚，就是它在响应滚动，抽屉不该抢（直到它滚回顶） */
      const scrollableFrom = (node: EventTarget | null): HTMLElement | null => {
        let element = node instanceof HTMLElement ? node : null
        while (element && element !== panel) {
          const overflowY = getComputedStyle(element).overflowY
          if ((overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight + 1) {
            return element
          }
          element = element.parentElement
        }
        return null
      }

      const reset = () => {
        panel.style.transition = ''
        panel.style.transform = ''
        panel.style.userSelect = ''
        // 拖关那条路把面板藏过（见 end() 里的说明），这里一并还原
        panel.style.visibility = ''
      }

      const begin = (x: number, y: number, target: EventTarget | null, prevent: boolean) => {
        startX = x
        startY = lastY = y
        lastAt = performance.now()
        delta = 0
        velocity = 0
        scrollHost = scrollableFrom(target)
        preventNative = prevent
        phase = 'deciding'
      }

      const move = (x: number, y: number, event?: Event) => {
        if (phase === 'idle') return
        const dy = y - startY
        const dx = x - startX

        if (phase === 'deciding') {
          /*
           * 三个"不抢"，见文件头 ⚠️ ②。第一道是**起手阈值**（DRAG_SLOP）：
           * 手指按下时几乎必然有几像素抖动，一点就判成拖动的话，
           * 用户点预设、点按钮都会先把面板带歪一下——手感上是"这抽屉在乱动"。
           */
          if (Math.abs(dy) < DRAG_SLOP && Math.abs(dx) < DRAG_SLOP) return
          if (Math.abs(dx) > Math.abs(dy)) return (phase = 'idle')
          if (dy <= 0) return (phase = 'idle')
          if (scrollHost && scrollHost.scrollTop > 0) return (phase = 'idle')
          phase = 'dragging'
          panel.style.transition = 'none'
          // 拖动时别顺手把标题选中了（鼠标最明显）
          panel.style.userSelect = 'none'
        }

        const now = performance.now()
        // 只在**有效采样**上算速度：两次 move 相隔太近（同一帧内）除出来会是个假的巨大值，
        // 快甩判据就会因为一次抖动手势而误判成"用户要关"
        const elapsed = now - lastAt
        if (elapsed > 8) {
          velocity = (y - lastY) / elapsed
          lastY = y
          lastAt = now
        }
        delta = Math.max(0, dy)
        // 接了手势就得叫停原生滚动，否则页面跟着一起滚，抽屉看起来是歪的
        if (preventNative && event) event.preventDefault()
        panel.style.transform = `translateY(${delta}px)`
      }

      const end = () => {
        if (phase !== 'dragging') {
          phase = 'idle'
          return
        }
        phase = 'idle'
        /*
         * 关不关由两件事定：**拖得够远**，或者**甩得够快**（原生都是这个手感——
         * 慢慢拖一半再松手会弹回去，轻轻一甩就关）。快甩那条还要 `delta` 过一个小门槛，
         * 否则"按下时手一抖 + 立刻抬"会以一个假的极快速度关掉抽屉。
         */
        const shouldClose =
          delta > DRAG_CLOSE_DISTANCE ||
          (velocity > DRAG_CLOSE_VELOCITY && delta > DRAG_SLOP * 3)
        panel.style.transition = `transform ${DRAG_SETTLE_MS}ms ease-out`
        if (shouldClose) {
          panel.style.transform = 'translateY(100%)'
          settleTimer = window.setTimeout(() => {
            /*
             * 收尾这两行的顺序是**用户当场报的那个 bug**（「拖到一半松手会瞬间回到最高点再收回去」）：
             *
             * 面板的位移有两个来源——我们的 inline 像素值、和 Popup 弹簧自己的百分比值。
             * 原来这里是 `reset()` 再 `close()`：reset 把 inline 值清掉的那一刻，弹簧那个
             * **0%（=完全打开）** 的值立刻生效，于是面板先跳回顶部，再被 close 的退场动画推下去。
             *
             * 现在：**不清 transform**，直接把面板藏起来再走正常关闭。面板已经在我们这 200ms
             * 里挪出屏幕了，弹簧随后在看不见的面板上跑它的退场，谁也没看见那一下跳变
             * （弹簧不碰 visibility，所以这个"藏"能一直撑到 afterClose）。
             * 遮罩是 Popup 自己管的（跟面板不是同一个元素），照常渐隐。
             */
            closedByDrag = true
            panel.style.visibility = 'hidden'
            close()
          }, DRAG_SETTLE_MS)
          return
        }
        panel.style.transform = 'translateY(0px)'
        settleTimer = window.setTimeout(reset, DRAG_SETTLE_MS + 20)
      }

      const onTouchStart = (event: TouchEvent) => {
        if (event.touches.length !== 1) return
        begin(event.touches[0].clientX, event.touches[0].clientY, event.target, true)
      }
      const onTouchMove = (event: TouchEvent) => {
        if (event.touches.length !== 1) return
        move(event.touches[0].clientX, event.touches[0].clientY, event)
      }
      const onMouseDown = (event: MouseEvent) => {
        // 输入框里按下并拖动是在选文字，不是要关抽屉
        if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select')) return
        begin(event.clientX, event.clientY, event.target, false)
      }
      const onMouseMove = (event: MouseEvent) => move(event.clientX, event.clientY)

      dragSurface.addEventListener('touchstart', onTouchStart, { passive: true })
      // touchmove 必须 passive: false，否则 preventDefault 无效
      dragSurface.addEventListener('touchmove', onTouchMove, { passive: false })
      dragSurface.addEventListener('touchend', end)
      dragSurface.addEventListener('touchcancel', end)
      dragSurface.addEventListener('mousedown', onMouseDown)
      // 鼠标的 move/up 挂在 window 上：拖到面板外面（鼠标很容易甩出去）也要继续跟手
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', end)
      return () => {
        if (settleTimer !== null) window.clearTimeout(settleTimer)
        // 拖关那条路不清样式：面板已经藏起来等着退场，清掉会让它露出来（见 end() 里那段 ⚠️）
        if (!closedByDrag) reset()
        dragSurface.removeEventListener('touchstart', onTouchStart)
        dragSurface.removeEventListener('touchmove', onTouchMove)
        dragSurface.removeEventListener('touchend', end)
        dragSurface.removeEventListener('touchcancel', end)
        dragSurface.removeEventListener('mousedown', onMouseDown)
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', end)
      }
    }, [close])

    /**
     * 外壳的 ref。**必须是一个稳定身份的函数**（useCallback，依赖也是稳定的 close）：
     * 内联箭头 ref 会在每次重渲染时"卸一次、挂一次"，于是每次重渲染都会跑一遍清理
     * （把样式清掉、监听重挂）。`close()` 自己就会触发一次重渲染——用户看到的那一下
     * "瞬间弹回最高点再收回去"就是这么来的（先踩了，才改成现在这样）。
     */
    const setShell = useCallback(
      (node: HTMLDivElement | null) => {
        detachDrag.current?.()
        detachDrag.current = node ? attachDrag(node) : null
        /*
         * 节点挂上来时如果抽屉是开着的，清掉上次拖关可能留下的隐藏/位移。
         * 兜底用：拖关靠 visibility 藏到 afterClose，万一同一个 DOM 节点被复用
         * （调用方 toggle visible 的用法），不解除的话下次打开是个看不见的抽屉。
         */
        if (node && shownRef.current && !closing.current) {
          const panel = node.closest('.adm-popup-body') as HTMLElement | null
          if (panel) {
            panel.style.visibility = ''
            panel.style.transition = ''
            panel.style.userSelect = ''
          }
        }
      },
      [attachDrag],
    )

    return (
      <Popup
        key={epoch}
        visible={shown}
        onMaskClick={close}
        onClose={close}
        afterClose={finishClose}
        destroyOnClose
        bodyStyle={{
          height,
          // 高度封顶 + 内部自滚（见文件头 ⚠️ ①）：内容再长也只在屏幕里滚，不会顶出去
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          padding: '18px 16px calc(20px + var(--safe-bottom))',
          background: 'var(--color-paper)',
          borderTopLeftRadius: '22px',
          borderTopRightRadius: '22px',
        }}
      >
        <div className="sheet__shell" ref={setShell}>
          {title && <div className="sheet__title">{title}</div>}
          <div className={['sheet__body', bodyClassName].filter(Boolean).join(' ')} ref={contentRef}>{children}</div>
        </div>
      </Popup>
    )
  },
)

export default BottomSheet
