import { Link, useLocation } from 'react-router-dom'
import Icon from '@/components/icons/Icon'
import { useFamily } from '@/api/family'
import { useSeasonal } from '@/api/discover-page'
import RecipeImage from '@/pages/recipes/components/RecipeImage'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import '../../shared.scss'
import '../discover.scss'

/**
 * 时令精选（2026-10-16 新增，见 D-110）：**这个季节有什么**。
 *
 * 与旁边两块问的不是同一件事：「摇一桌」配这一餐、「帮我决定」挑一道，
 * 而这一块是"天凉了，这些正当时"——一批可以逛的菜，点进去看做法。
 * 它回答的问题在别处没有：全项目唯一带"时令"两个字的是厨房页底部那张**静态图片**
 * （字烘焙在图里、四季不变、不可点），所以这里给的是**真入口**。
 *
 * 四件事刻意的：
 *
 * - **季节由后端按月份算**（`useSeasonal` 不传任何参数）：前端自己算就会在月初月末
 *   与后端分叉——那种分叉的表现是"标题写秋日时令、点进去 38 道夏菜"，最难查的一类；
 * - **那一行数字（38 道）与点进去之后的总数必须一致**，所以两边都按**标签精确筛**
 *   （后端 `SEASON_TAGS` 的并集，前端只把后端给的 `tagQuery` 原样拼进 URL）。
 *   用搜索兜的话会多出名字里带"秋"的 3 道，数字对不上就没人信这个数了；
 * - **只画一屏**（后端给 6 道）：它是橱窗不是列表——完整的应季菜在菜谱小书里，
 *   那里有排序、有筛选、有无限翻页。挤成 20 张卡会让人以为"时令就只有这些"；
 * - **加载与失败都不占大块**（一行字 / 一行错误 + 重试）：这一块坏了不该把整页堵住，
 *   下面还有家人最爱与翻牌子。
 */
export default function SeasonalPicks() {
  const family = useFamily()
  const location = useLocation()
  // 没家庭就别问：接口按家庭算可见范围（自家上传的菜也要能进这一块）
  const seasonal = useSeasonal({ enabled: Boolean(family.data) })

  // 没加入家庭：这一块是公共菜谱库的内容，理论上没家也能看，但发现页的其余块都要家庭，
  // 而"先建家庭"这件事在页面上已经有别的出口（家人最爱那块会说），这里就不重复占了
  if (!family.isPending && !family.data) return null

  const board = seasonal.data

  return (
    /*
     * `data-season`：这一块的**底色跟着季节变**（四季各一个色，见 discover.scss 的
     * `.season[data-season]`）。值是**后端算的那个季节**，不在前端按月份自己算一遍——
     * 两边各算一次，标题写着秋天而底是夏天绿，是最难查的一类。
     * 还没拿到数据时这个属性不在，样式表里的兜底是暖琥珀（这一页的主色族）。
     */
    <section className="season" data-season={board?.season} aria-label="时令精选">
      <div className="season__head">
        <span className="season__title">{board?.title ?? '时令精选'}</span>
        {board && <span className="season__note">{board.note}</span>}
        {board && (
          <Link
            className="season__more"
            to={`/recipes?tag=${encodeURIComponent(board.tagQuery)}`}
            state={{ from: location.pathname }}
          >
            {board.count} 道 <Icon name="chevron-right" size={13} className="icon--trail" />
          </Link>
        )}
      </div>

      {seasonal.isPending && (
        <div className="season__status">
          <RecipeStatus title="正在翻这一季的菜…" loading />
        </div>
      )}
      {seasonal.isError && (
        <div className="season__status">
          <RecipeStatus title="时令精选暂时打不开" onRetry={() => { void seasonal.refetch() }}>
            这一块不影响下面两块
          </RecipeStatus>
        </div>
      )}

      {board && board.items.length === 0 && (
        <p className="season__empty">这一季的菜还没挑出来，等库里多几道应季的。</p>
      )}

      {board && board.items.length > 0 && (
        <ul className="season__list">
          {board.items.map((dish) => (
            <li key={dish.id}>
              <Link
                className="season__card"
                to={`/recipes/${encodeURIComponent(dish.id)}`}
                state={{ from: `${location.pathname}${location.search}` }}
              >
                {/*
                 * 图与名字之间的这层是 `<span>`：**必须有 `display:block`**
                 * （见 discover.scss 里 `.season__pic` 那段 ⚠️）——
                 * 行内元素吃不上 width/height，里面的图会按原始尺寸铺开，
                 * 这一块的每一张卡都会变成不一样高。
                 */}
                <span className="season__pic">
                  <RecipeImage src={dish.image} name={dish.name} />
                </span>
                <span className="season__name">{dish.name}</span>
                <span className="season__meta">{dish.category}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
