import type { MouseEvent, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import Icon from '@/components/icons/Icon'
import { goBack } from '@/lib/back-go'

/**
 * 页面左上角那颗「← 返回」（F0-05 的统一样式，D-105 起接同一条通道）。
 *
 * ## 为什么必须是一个组件，而不是各页各写一个 `<Link>`
 *
 * 用户报的两条怪行为（「连续点击菜单，然后返回都能一直返」「点击进入详情再点击其他菜单
 * 还能返回去详情」）都出在**返回键**上；而页面上这颗箭头是**另一套**逻辑
 * （`state.from` + push 导航）。两套并存时，"箭头去的地方"和"返回键去的地方"
 * 会各自漂移——本项目在"同一个键两处各算一遍"上栽过两次（D-078 四）。
 *
 * 现在两者都走 `goBack`（见 `lib/back-go`）：同一个函数、同一个目标、同一条两层动画。
 * 于是不可能再出现"箭头回得去、返回键回不去"这种对不齐。
 *
 * ## 为什么还留着 `<Link>`
 *
 * 它渲染出来仍是一个真 `<a href>`：长按能看见链接地址、读屏把它当链接念、
 * 桌面浏览器里中键/新标签打开也照常。只是**普通点击**被接管成"返回"
 * （`replace` + 两层动画），修饰键与中键不拦——那是"打开这一页"，不是"返回"。
 */
export default function BackLink({
  to,
  label,
  children,
  state,
  className = 'page-back',
}: {
  /** 返回目标（来自 `useBackLink` / `readBackLink`，或页面自己写死的上一站） */
  to: string
  /** 文案；默认渲染成「← {label}」 */
  label?: string
  /** 自定义内容（个别页面在箭头两边还要塞别的东西） */
  children?: ReactNode
  /** 中间页替下一站收着的那份 state（只有菜谱编辑页用，见 `readCarry`） */
  state?: unknown
  className?: string
}) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // 中键与修饰键是"打开这一页"，不是"返回"：交给浏览器本来的行为
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    goBack(to)
  }

  return (
    <Link className={className} to={to} state={state} onClick={onClick}>
      {children ?? (
        <>
          <Icon name="arrow-left" size={13} /> {label ?? '返回'}
        </>
      )}
    </Link>
  )
}
