/**
 * 「我的」页那几行各自的未读数（用户 2026-10-16 把提醒扩到"家里的事"之后加的）。
 *
 * ## 为什么这几行要有红点
 *
 * 打卡、家庭、菜谱这三块**不亮底栏**——底栏五个 Tab 里没有它们的入口
 * （不像"订单""冰箱"那样点一下就进去了）。若不给任何标记，家里人传了打卡照、
 * 换了邀请码、改了你家菜谱，用户在这一页完全看不出来：那正是这次改动要解决的事
 * （用户原话：「就是家庭相关修改的都需要通知」）。
 *
 * ## 为什么单独一个文件、而不是写在 `MinePage.tsx` 里
 *
 * 与 `pages/order/unread-badges.ts` 同一条理由：判据是纯的，抽出来能**不进 jsdom**
 * 直接单测——而它恰恰是会被改坏的地方（比如以后有人把 `comment` 漏在打卡行之外，
 * 那一类未读就再也看不见了，而界面测试只看到"有个数字"）。
 *
 * ## 数字从哪来
 *
 * **不自己按区域加**（那是 `unreadByArea` 的事，后端算好的）：这里要的是
 * **按行**拆开——同一个 `family` 区域里的四类，落在这一页的**三个不同去处**上。
 * 所以用 `unreadByKind`（后端按 kind 数好的）在**这一层**做分组：
 * 打卡与评论同属"打卡墙"这一行（它们也是同一个开关，见后端 `prefOfKind`），
 * 家庭与菜谱各自一行。**这是界面的分组，不是后端口径的第二份**：
 * 后端只管"每一类有几条未读"，"哪几类落在同一行"是这一页的排版事实。
 */
import type { NotificationBoard } from '@/api/notifications'

export interface MineRowUnread {
  /** 「我的打卡」那一行（上传 + 评论） */
  checkin: number
  /** 「家庭共享与成员」那一行 */
  family: number
  /** 「我的菜谱」那一行 */
  recipe: number
}

/**
 * 这一页三行各显示几个未读。
 *
 * `comment` **必须算进打卡行**：评论是"在你的照片底下说了话"，而这一页通往它们的
 * 唯一入口就是打卡墙——漏掉它，家里人说的话就永远不在这页上现形。
 *
 * 数据还没回来（`board` 为空）时全给 0：与外壳的红点同一条规矩
 * （"不能默认亮着"，见 `TabLayout.tabBadge`）。
 */
export function mineRowUnread(board: NotificationBoard | undefined): MineRowUnread {
  const by = board?.unreadByKind
  return {
    checkin: (by?.checkin ?? 0) + (by?.comment ?? 0),
    family: by?.family ?? 0,
    recipe: by?.recipe ?? 0,
  }
}
