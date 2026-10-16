import { useFamily } from '@/api/family'
import { useMonthlyReport } from '@/api/discover-page'
import '../../shared.scss'
import '../discover.scss'

/**
 * 家庭月报（2026-10-16 新增，见 D-108）：**全家这个月过得怎么样**。
 *
 * 这一块填的是一个真空白：「我的」页只有你**个人**的打卡热力图与我的菜数，
 * 「家人最爱」是**菜**的榜单——全家一起过的这个月，没有人在讲。
 *
 * 四件事刻意的：
 *
 * - **不足 3 顿整块不画**（后端回 `report: null`，这里 `return null`）：
 *   1 顿就报"一起吃了 1 顿"没有意义，还显得这一家冷清。与「家人最爱」的空态同一条线
 *   ——用户 2026-10-16 定的「没有最爱就是没有」：**没有就说没有，不塞一个填坑的假总结**；
 * - **四个数都是现成的**（本月餐次 / 已做好 / 试过的菜 / 打卡张数），不引入新数据，
 *   也不给谁打分（不写"谁做得最多"——家庭里那种数字容易变成比较）；
 * - **脚注由后端拼好**（`report.line`），前端只照搬：与采购清单那句"家里有 半盒"同一条规矩，
 *   两边各拼一遍必然漂移；
 * - **加载与失败都只占一行**：这一块是页尾的总结，坏了不该把整页堵住。
 */
export default function MonthlyReport() {
  const family = useFamily()
  const report = useMonthlyReport({ enabled: Boolean(family.data) })

  // 没加入家庭：这一块算的是"全家"，一个人没有"家"可算
  if (!family.isPending && !family.data) return null

  const board = report.data

  /*
   * `report === null` 有**两种**情况，必须分开：
   * ① 还没取回来（`board` 是 undefined）→ 什么都不画，也不占位（避免闪一下"加载中"）；
   * ② 后端明确说这个月不够 3 顿 → 整块不画。
   * 把两者合成一个 `!board?.report` 会让加载中也"空着"一块，而这一块在页尾——
   * 空一块的表现是页面莫名其妙多出一段白。
   */
  if (!board || !board.report) return null
  const month = board.report

  return (
    <section className="report" aria-label="家庭月报">
      <div className="report__head">
        <span className="report__title">{titleOf(board.month)}</span>
        <span className="report__note">这个月的厨房</span>
      </div>

      <div className="report__grid">
        <Cell value={month.meals} unit="顿" label="一起吃了" />
        <Cell value={month.done} unit="顿" label="真的做了" />
        <Cell value={month.kinds} unit="种" label="试过的菜" />
        <Cell value={month.photos} unit="张" label="拍的照片" />
      </div>

      {/* 那句脚注（后端拼）：有冠军才提冠军、没开火就直说——只说真事 */}
      {month.line && <p className="report__foot">{month.line}</p>}
    </section>
  )
}

function Cell({ value, unit, label }: { value: number; unit: string; label: string }) {
  return (
    <div className="report__cell">
      <div className="report__num">
        {value}
        <small>{unit}</small>
      </div>
      <div className="report__label">{label}</div>
    </div>
  )
}

/**
 * `2026-10` → 「小满一家 · 十月」里的那个月份。
 *
 * 家庭名**不在这里拼**：这一块自己不去取家庭详情（`useFamily` 那边已经有那份数据，
 * 但标题要的是"几月"，而月份是这一块唯一的自变量）。名字交给页面标题更省事，
 * 也让这块在没取到家庭名时照样能画。
 */
function titleOf(month: string): string {
  const [, rawMonth] = month.split('-')
  const index = Number(rawMonth)
  const names = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']
  return names[index - 1] ?? month
}
