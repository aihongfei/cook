import type { ReactNode } from 'react'
import { Tabs } from 'antd-mobile'
import SwipePager from './SwipePager'
import './ui.scss'

/**
 * 页内 tab 条（M1 / M9 等多处共用）。
 *
 * 两件事值得知道：
 *
 * - **tab 条本身用组件**（antd-mobile `Tabs`）：横向滚动、活动下划线、点击切换都是它；
 * - **给了 `renderPanel` 就自带走滑**（`SwipePager`）：用户 2026-10-15 要求「类似这种 tab 页
 *   （全部、已安排、已做好）包括我的菜谱中收藏、我的菜谱这种 tab 页需要能左右滑动切换」，
 *   看完之后又要求「要跟随手指拖动，滑到中间时，两个页是都能看见的」。
 *   为什么滑动这一件事是自己的纯规则 + 一层组件、而不是同一个包里的 `Swiper`：
 *   见 `lib/tab-swipe.rules.ts` 的文件头（定高轮播与本项目"整页一个滚动容器"不兼容）。
 *
 * 内容按**页**给（`renderPanel(key)`）：跟手拖动时邻居页也要画得出来，所以调用方要保证
 * "任何一页都能渲染"，而不是只渲染当前这一页。
 *
 * `data-no-swipe` 标在 tab 条上：它自己会横着滚，在它上面划动的意思是"看后面的选项"。
 * 标记打在这里，页面就不用记着加（`SwipePager` 见到这个标记一律不接）。
 */
interface FilterTabsProps {
  items: { key: string; title: string }[]
  activeKey: string
  onChange: (key: string) => void
  /** 画第 key 页的内容。不给则只有 tab 条（向后兼容只想要 tab 条的老调用方） */
  renderPanel?: (key: string) => ReactNode
}

export default function FilterTabs({ items, activeKey, onChange, renderPanel }: FilterTabsProps) {
  return (
    <div className="filter-tabs">
      <div data-no-swipe>
        <Tabs activeKey={activeKey} onChange={onChange}>
          {items.map((item) => (
            <Tabs.Tab key={item.key} title={item.title} />
          ))}
        </Tabs>
      </div>
      {renderPanel ? (
        <SwipePager
          keys={items.map((item) => item.key)}
          activeKey={activeKey}
          onChange={onChange}
          renderPanel={renderPanel}
        />
      ) : null}
    </div>
  )
}
