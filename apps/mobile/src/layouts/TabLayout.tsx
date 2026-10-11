import { NavLink, Outlet } from 'react-router-dom'
import { LeafSprig } from '@/components/icons/TabIcons'
import { tabs } from '@/config/tabs'
import './TabLayout.scss'

/**
 * 应用外壳：内容区（滚动） + 底部 5 Tab 导航。
 * 页面本身的边距/留白由各页面自己负责（用 <Page> 组件统一）。
 */
export default function TabLayout() {
  return (
    <div className="tab-layout">
      <main className="tab-layout__body">
        <Outlet />
      </main>

      <nav className="tab-bar">
        {tabs.map(({ path, label, Icon }) => (
          <NavLink
            key={path}
            to={path}
            className={({ isActive }) => `tab-bar__item${isActive ? ' is-active' : ''}`}
          >
            <Icon width={23} height={23} />
            <span>{label}</span>
            <i className="tab-bar__bar" />
          </NavLink>
        ))}
        <LeafSprig className="tab-bar__deco tab-bar__deco--left" />
        <LeafSprig className="tab-bar__deco tab-bar__deco--right" />
      </nav>
    </div>
  )
}
