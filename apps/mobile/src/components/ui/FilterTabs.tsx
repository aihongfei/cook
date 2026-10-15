import type { ReactNode } from 'react'
import { Tabs } from 'antd-mobile'
import SwipeArea from './SwipeArea'
import './ui.scss'

/**
 * 页内 tab 条（M1 / M9 等多处共用）。
 *
 * 两件事值得知道：
 *
 * - **tab 条本身用组件**（antd-mobile `Tabs`）：横向滚动、活动下划线、点击切换都是它；
 * - **传了 `children` 就自带走滑**（`SwipeArea`）：用户 2026-10-15 要求「类似这种 tab 页
 *   （全部、已安排、已做好）包括我的菜谱中收藏、我的菜谱这种 tab 页需要能左右滑动切换」。
 *   为什么滑动这一件事是自己的纯规则 + 一小层手势面，而不是同一个包里的 `Swiper`：
 *   见 `lib/tab-swipe.rules.ts` 的文件头（长列表塞不进定高轮播轨道）。
 *
 * `data-no-swipe` 标在 tab 条上：它自己会横着滚，在它上面划动的意思是"看后面的选项"。
 * 标记打在这里，页面就不用记着加（`SwipeArea` 见到这个标记一律放行）。
 */
interface FilterTabsProps {
  items: { key: string; title: string }[]
  activeKey: string
  onChange: (key: string) => void
  /** 这一屏的内容：给了就能左右滑动切换（不给则只有 tab 条，向后兼容老调用方） */
  children?: ReactNode
}

export default function FilterTabs({ items, activeKey, onChange, children }: FilterTabsProps) {
  return (
    <div className="filter-tabs">
      <div data-no-swipe>
        <Tabs activeKey={activeKey} onChange={onChange}>
          {items.map((item) => (
            <Tabs.Tab key={item.key} title={item.title} />
          ))}
        </Tabs>
      </div>
      {children ? (
        <SwipeArea keys={items.map((item) => item.key)} activeKey={activeKey} onChange={onChange}>
          {children}
        </SwipeArea>
      ) : null}
    </div>
  )
}
