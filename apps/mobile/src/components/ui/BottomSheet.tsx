import { Popup } from 'antd-mobile'
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
  onClose: () => void
}

export interface BottomSheetHandle {
  /** 播完退场动画再通知调用方卸载（写入成功后自动收起走这里） */
  close: () => void
}

/** 退场兜底：弹簧正常约 300ms 停下，超过这个时间还没回调就自己收尾（见 close 里的说明） */
const EXIT_FALLBACK_MS = 420

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
 */
const BottomSheet = forwardRef<BottomSheetHandle, PropsWithChildren<BottomSheetProps>>(
  function BottomSheet({ visible, title, height, onClose, children }, ref) {
    const [epoch, setEpoch] = useState(0)
    const [shown, setShown] = useState(false)
    // 记下"这次关闭是我发起的"：调用方自己把 visible 置 false 时不该再回调 onClose（会关两次）
    const closing = useRef(false)
    const exitTimer = useRef<number | null>(null)
    // 装在抽屉内部内容上：用来判断"内容还在不在"（见下面调用方关闭的那段兜底）
    const contentRef = useRef<HTMLDivElement>(null)
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

    // 卸载时清掉兜底计时器：否则到点后会在一个已经不存在的抽屉上做收尾（close 的回调不该迟到）
    useEffect(
      () => () => {
        if (exitTimer.current !== null) window.clearTimeout(exitTimer.current)
      },
      [],
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
          padding: '18px 16px calc(20px + var(--safe-bottom))',
          background: 'var(--color-paper)',
          borderTopLeftRadius: '22px',
          borderTopRightRadius: '22px',
        }}
      >
        {title && <div className="sheet__title">{title}</div>}
        <div className="sheet__body" ref={contentRef}>{children}</div>
      </Popup>
    )
  },
)

export default BottomSheet
