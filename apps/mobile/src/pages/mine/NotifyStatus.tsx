import { useQuery } from '@tanstack/react-query'
import { isSupported, readNotifyStatus } from '@/lib/local-notify'
import { notifyStatusText } from '@/lib/local-notify.rules'
import { nativeSupported, nativeLinkRunning } from '@/api/realtime-native'

/**
 * 「手机提醒」这一行的现状（M10 交付二 / 交付三；用户 2026-10-15 报「真机也没收到通知」之后加的）。
 *
 * ## 为什么必须有这一行
 *
 * "没收到通知"这件事在界面上**完全看不出来**：可能压根没有要提醒的事、
 * 可能系统权限没给、可能排上了但时间还没到——用户只能干着急，我也只能靠连他的手机猜。
 * 这与 `RISKS.md` R-66 那一族是同一类问题（**界面分不出"做成了"与"看着做成了"**），
 * 所以修法也一样：**把状态摆出来**。
 *
 * ## 它是**只读**的
 *
 * 用户 2026-10-14 明确说过提醒默认开着、不要开关（D-080：「删掉这块配置」），
 * 所以这里只报状态，不给任何开关。权限被拒时给一句**去哪打开**的话（系统设置里），
 * 但不在这一行里再弹一次权限框——系统对"问过被拒"的 App 不会再弹，点了也是白点。
 *
 * ## 什么时候刷新
 *
 * 每次进「我的」页取一次（`staleTime: 0`）：排程会随着点菜/冰箱变化而重排，
 * 缓存下来的"已排 3 条"很快就不是真的了。
 */

export default function NotifyStatusRow() {
  // 网页版（开发时的浏览器）没有"关掉页面还能响"这回事，那一行干脆不出现——
  // 否则每次在电脑上看界面都多一句与当前环境无关的话
  const supported = isSupported()
  const query = useQuery({
    queryKey: ['notify', 'status'],
    queryFn: readNotifyStatus,
    enabled: supported,
    staleTime: 0,
    retry: 0,
  })

  /*
   * 实时连接（F10-08）：**第二句**问的是原生那条长连接现在在不在。
   *
   * 为什么也放在这一行、而不是新起一行：两个都是"手机在不在替我盯着家里的事"
   * ——用户心里那件事只有一件。新起一行「实时连接」会让人以为它们是两套东西、
   * 还要分别判断，而实际上实时那条不通时，下面那条巡查兜着（只是慢一点）。
   *
   * 与上面那条同样**只读**：用户没要过"关掉实时"这个开关，
   * 而他真想要"安静一会儿"时该关的是通知权限（那一句本来就指到系统设置）。
   */
  const live = useQuery({
    queryKey: ['notify', 'realtime'],
    queryFn: nativeLinkRunning,
    enabled: nativeSupported(),
    staleTime: 0,
    retry: 0,
  })

  if (!supported) return null
  const view = notifyStatusText(query.data ?? { permission: 'prompt', pending: 0, next: null })

  return (
    <div className="row row--status">
      <div className="row__icon">📣</div>
      <div className="row__main">
        手机提醒
        <div className={['row__sub', view.tone === 'warn' && 'row__sub--warn'].filter(Boolean).join(' ')}>
          {query.isPending ? '正在看提醒排上了没有…' : view.text}
        </div>
        {/* 装到手机上才有实时那条；浏览器里 `nativeSupported()` 为假，这一句不出现 */}
        {nativeSupported() && (
          <div className="row__sub">
            {live.isPending ? '正在看实时连接…' : live.data ? '实时连接中：家里的事立刻到' : '实时连接没开着（家里的事最多晚一刻钟）'}
          </div>
        )}
      </div>
    </div>
  )
}
