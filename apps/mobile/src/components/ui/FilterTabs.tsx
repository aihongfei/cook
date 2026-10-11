import { Tabs } from 'antd-mobile'
import './ui.scss'

interface FilterTabsProps {
  items: { key: string; title: string }[]
  activeKey: string
  onChange: (key: string) => void
}

export default function FilterTabs({ items, activeKey, onChange }: FilterTabsProps) {
  return (
    <div className="filter-tabs">
      <Tabs activeKey={activeKey} onChange={onChange}>
        {items.map((item) => (
          <Tabs.Tab key={item.key} title={item.title} />
        ))}
      </Tabs>
    </div>
  )
}
