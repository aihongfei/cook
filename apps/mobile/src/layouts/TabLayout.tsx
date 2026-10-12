import { useEffect, useRef } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { LeafSprig } from '@/components/icons/TabIcons'
import { tabs } from '@/config/tabs'
import { tabOf } from '@/pages/back-link'
import './TabLayout.scss'

/**
 * 应用外壳：内容区（滚动） + 底部 5 Tab 导航。
 * 页面本身的边距/留白由各页面自己负责（用 <Page> 组件统一）。
 */
export default function TabLayout() {
  const location = useLocation()
  const { pathname } = location
  const bodyRef = useRef<HTMLElement>(null)
  useEffect(() => { bodyRef.current?.scrollTo?.({ top: 0 }) }, [pathname])

  /*
   * 菜谱列表/详情不在 Tab 里，要借一个 Tab 表示"人在哪一块"：
   * - **从哪个 Tab 进来的就亮哪个**（读 `state.from`，与返回按钮同一份来源）；
   * - 来源认不出（地址栏直接敲、或菜谱小书内部自己跳）才退回「厨房」——菜谱库本来就归厨房。
   * 原先一律亮厨房：从发现页「摇一道」过去后，用户点那个亮着的 Tab 会落到厨房菜单页，
   * 而他明明是从发现页过来的（实测踩过）。
   */
  const recipeOwner = tabOf((location.state as { from?: unknown } | null)?.from)
  const isRecipePage = pathname === '/recipes' || pathname.startsWith('/recipes/')
  const borrowedTab = isRecipePage ? recipeOwner ?? '/kitchen' : null

  return (
    <div className="tab-layout">
      <main ref={bodyRef} className="tab-layout__body">
        <Outlet />
      </main>

      <nav className="tab-bar">
        {tabs.map(({ path, label, Icon }) => {
          /*
           * 这里用 Link 不用 NavLink：NavLink 自己算 active 并在最后覆盖 aria-current，
           * 而"借来的 Tab"恰恰是路由看不出来的状态——NavLink 表达不了它（传了也会被丢掉，
           * 于是样式亮着、无障碍状态却是空的，自己写的测试当场抓出来的）。
           * 改成自己算，两个高亮（class 与 aria-current）就同源于一个判断，不会再分叉。
           */
          const active = path === borrowedTab || pathname === path || pathname.startsWith(`${path}/`)
          return (
            <Link
              key={path}
              to={path}
              aria-current={active ? 'page' : undefined}
              className={`tab-bar__item${active ? ' is-active' : ''}`}
            >
              <Icon width={23} height={23} />
              <span>{label}</span>
              <i className="tab-bar__bar" />
            </Link>
          )
        })}
        <LeafSprig className="tab-bar__deco tab-bar__deco--left" />
        <LeafSprig className="tab-bar__deco tab-bar__deco--right" />
      </nav>
    </div>
  )
}
