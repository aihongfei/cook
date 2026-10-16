import type { PropsWithChildren, ReactNode } from 'react'
import './ui.scss'

/**
 * 页面容器：统一底部留白。
 * 需要通栏内容（如 hero 插画）时直接用；局部需要 16px 栏距时包一层 <div className="pad">。
 *
 * ## 给了 `fixed` 就是「页头不动、只滚主体」的骨架（D-091，用户 2026-10-16）
 *
 * 用户这一批的要求：
 * - 「滑动时只滑动主题内容，tab 和操作区域不能动」；
 * - 「厨房页菜谱小书和订单页包括其他的有滚动的都要改，**只能滚动主题内容**」。
 *
 * 做法是给要固定的那一块套一层 `position: sticky`（见 ui.scss 的 `.page__fixed`），
 * **外壳那个唯一的滚动容器一个字都不改**：滚动位置记忆（D-083 / R-65）、换页不卸载的
 * 页面缓存（D-083）、列表的无限滚动哨兵（root 取 `closest('.tab-layout__body')`）
 * 三件事全挂在它上面，把滚动拆到每一页里去会让这三件事一起重做
 * （`lib/tab-swipe.rules.ts` 的文件头记着同一个判断，D-088 二也按它否决了定高轮播）。
 *
 * `sticky` 与「页头固定在屏幕上」在用户看到的那一层是同一件事：往下滚时那一块钉住不动、
 * 内容从它下面穿过去（它是不透明的，所以穿过去看不见）。
 *
 * ⚠️ 不传 `fixed` 的页面**保持原样**（整页跟着外壳一起滚）：这不是"两套实现"，是渐进改造——
 * 这一批按页推进，还没轮到的页面不该被顺手改掉（项目规矩：只改任务范围内的内容）。
 */
export default function Page({ children, fixed }: PropsWithChildren<{ fixed?: ReactNode }>) {
  if (!fixed) return <div className="page">{children}</div>
  return (
    <div className="page page--fill">
      <div className="page__fixed">{fixed}</div>
      {/* 主体：撑满剩下的高度，长内容把它顶高、短内容不撑出空白（见 ui.scss 里那段算式） */}
      <div className="page__body">{children}</div>
    </div>
  )
}
