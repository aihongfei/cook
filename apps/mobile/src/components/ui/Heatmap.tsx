import { useMemo } from 'react'
import type { HeatmapGrid } from '@/api/checkins'

/**
 * 打卡热力图（M9 / F9-03）。
 *
 * 参照 GitHub 贡献图：一周一列、周一在上，格子按当天打卡张数分 5 档深浅。
 * 三点刻意的做法：
 * - **格子不做成按钮**：这是"回看"用的图，一天点不下去；要看清某天就看格子的 title 提示；
 * - **月份标在列下**：只标"出现新月份的第一周"，避免每列都顶一个重复的月份；
 * - 等级阈值由后端给（`level`），前端只负责上色——改口径不用动前端。
 */

const MONTH_LABEL = ['1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月', '9 月', '10 月', '11 月', '12 月']
const WEEKDAY_LABEL = ['一', '', '三', '', '五', '', '日']

export default function Heatmap({ grid, emptyHint }: { grid: HeatmapGrid; emptyHint?: string }) {
  // 每周的月份标签：只有当这一周出现了"比上一周更晚的月份"时才标（即该月的第一周）
  const monthLabels = useMemo(() => {
    const labels: string[] = []
    let lastMonth = -1
    for (const week of grid.weeks) {
      const first = week[0]
      const month = first ? Number(first.date.slice(5, 7)) - 1 : lastMonth
      if (month === lastMonth) {
        labels.push('')
        continue
      }
      lastMonth = month
      labels.push(MONTH_LABEL[month] ?? '')
    }
    return labels
  }, [grid.weeks])

  return (
    <div className="heatmap">
      <div className="heatmap__body">
        <div className="heatmap__weekdays" aria-hidden="true">
          {WEEKDAY_LABEL.map((label, index) => (
            <span key={index}>{label}</span>
          ))}
        </div>

        <div className="heatmap__grid" role="img" aria-label={`打卡热力图：${grid.from} 至 ${grid.to}，共 ${grid.totalDays} 天有打卡、${grid.totalCount} 张照片`}>
          {grid.weeks.map((week, weekIndex) => (
            <div className="heatmap__week" key={week[0]?.date ?? weekIndex}>
              {week.map((cell) => (
                <span
                  key={cell.date}
                  className={`heatmap__cell heatmap__cell--l${cell.level}`}
                  title={cell.count > 0 ? `${cell.date}：${cell.count} 张` : `${cell.date}：没打卡`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="heatmap__months" aria-hidden="true">
        {monthLabels.map((label, index) => (
          <span key={index}>{label}</span>
        ))}
      </div>

      <div className="heatmap__legend">
        {emptyHint && grid.totalCount === 0 ? (
          <span className="heatmap__empty">{emptyHint}</span>
        ) : (
          <>
            <span>{grid.totalDays} 天有打卡 · 共 {grid.totalCount} 张</span>
            <span className="heatmap__scale">
              少
              {[0, 1, 2, 3, 4].map((level) => (
                <i key={level} className={`heatmap__cell heatmap__cell--l${level}`} />
              ))}
              多
            </span>
          </>
        )}
      </div>
    </div>
  )
}
