import type { OrderStatus } from '@/api/orders'

/**
 * 点单状态 → 印章色（点菜单与本周菜单共用）。
 *
 * 放在公共层是因为**同一张单在两个页面上的颜色必须一致**：状态色各写一份的话，
 * 改了一处另一处就开始漂移，用户会以为"同一个状态怎么两个颜色"。
 * 色值本身在 `ui.scss` 的 `.stamp--*`。
 */
export const STATUS_TONE: Record<OrderStatus, string> = {
  PENDING: 'stamp--wait',
  PLANNED: 'stamp--planned',
  COOKING: 'stamp--cooking',
  // 已做好是收尾，用默认的绿色实心戳；已取消要"褪色"，别再吸引注意力
  DONE: '',
  CANCELED: 'stamp--canceled',
}
