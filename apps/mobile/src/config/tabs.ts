import type { ComponentType, SVGProps } from 'react'
import { DiscoverIcon, FridgeIcon, KitchenIcon, MineIcon, OrderIcon } from '@/components/icons/TabIcons'

export interface TabItem {
  /** 路由路径 */
  path: string
  /** 底栏文案 */
  label: string
  Icon: ComponentType<SVGProps<SVGSVGElement>>
}

/** 底部 5 个 Tab（信息架构见 PLAN.md 第二节） */
export const tabs: TabItem[] = [
  { path: '/kitchen', label: '厨房', Icon: KitchenIcon },
  { path: '/order', label: '订单', Icon: OrderIcon },
  { path: '/discover', label: '发现', Icon: DiscoverIcon },
  { path: '/fridge', label: '冰箱', Icon: FridgeIcon },
  { path: '/mine', label: '我的', Icon: MineIcon },
]
