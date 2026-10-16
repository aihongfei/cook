import { Link } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { useCooked } from '@/api/cooked'
import EmptyState from '@/components/ui/EmptyState'
import RecipeImage from '@/pages/recipes/components/RecipeImage'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import { caloriesLabel } from '@/api/recipes'
import '@/pages/shared.scss'
import './cooked.scss'

/**
 * 我做过（M9 / F9-01）的**列表本体**。口径见 D-075。
 *
 * 抽成组件与 `FavoritesList` 同一个理由（D-076）：「我的菜谱」的 tab 与保留的
 * `/cooked` 独立路由共用同一份实现——各写一遍必然漂移。
 *
 * **这一页是怎么来的**：用户说「家庭任何人都可以点击做好，但是要记录是谁点的，
 * 谁点的就是谁掌勺的」。"谁点的"一直都有记录（点菜时那条 `OrderItem.userId`），
 * 所以这个功能不需要新字段——它就是**把那条记录翻出来给用户看**。
 *
 * 四件事刻意的：
 *
 * - **按最近做的排前面**（不是按次数）：这是"我的手艺账本"，用户来找的多半是
 *   "上周做的那道排骨"；做过几次是卡上的一行事实，不是排序依据；
 * - **那行字由后端拼**（`cookedLabel`："做过 3 次 · 最近 3 天前"）：与采购清单那句
 *   `stockLabel`、冰箱的 `addedLabel` 同一条规矩（D-059 四），两边各拼一遍必然漂移；
 * - **不受共享开关影响**：那个开关管"家人之间互相可见"，看自己的记录不需要别人允许。
 *   所以措辞只提"我"，不提"家里"（与收藏页同一条）；
 * - **空态给出去处**：第一次进来必然为空，要说清怎么才能让这儿有东西。
 */
export default function CookedList({ from, emptyTo = '/recipes' }: { from: string; emptyTo?: string }) {
  const cooked = useCooked()

  const items = cooked.data?.items ?? []
  const total = cooked.data?.total ?? 0
  /** 还有多少道没显示（后端一次给 30，超了要说清"还有 N 道"而不是默默截断） */
  const hidden = Math.max(0, total - items.length)

  return (
    <>
      {cooked.isPending && (
        <div className="cooked__status">
          <RecipeStatus title="正在翻你的下厨记录…" loading />
        </div>
      )}
      {cooked.isError && (
        <div className="cooked__status">
          <RecipeStatus title="下厨记录暂时打不开" onRetry={() => { void cooked.refetch() }}>
            {apiErrorMessage(cooked.error)}
          </RecipeStatus>
        </div>
      )}

      {cooked.data && items.length === 0 && (
        <div className="cooked__empty">
          <EmptyState
            title="还没有做好的菜"
            desc="点一道菜，等这一餐标成「做好了」，它就会出现在这儿——做过的次数也一次次长起来。"
          />
          <Link className="recipe-button cooked__go" to={emptyTo} state={{ from }}>
            去菜谱小书点一道
          </Link>
        </div>
      )}

      {/*
        数量走右上角，与同一页「原创的」那个 `共 N 道` 同一个位置（用户 2026-10-15：
        「这个放在这里不好看」——原来是左对齐、紧贴 tab 的下划线，读起来像一句
        没有下文的标题）。截断的说明折进这一行，不再单独占一行。
      */}
      {items.length > 0 && (
        <p className="cooked__summary">
          {hidden > 0 ? `做过 ${total} 道 · 只列了最近 ${items.length} 道` : `做过 ${total} 道`}
        </p>
      )}

      <div className="cooked__grid">
        {items.map((dish) => (
          <article className="cooked-card" key={dish.id}>
            <Link
              className="cooked-card__link"
              to={`/recipes/${encodeURIComponent(dish.id)}`}
              /*
               * 用**传进来的 `from`**，不要自己拼 `location.pathname`（2026-10-16 修）。
               *
               * 差别只有一处，但正是用户报的那一处：`pathname` **丢查询串**，
               * 而"这个列表是「我的菜谱」的第几个 tab / 菜谱小书的哪个品类"恰恰只写在
               * 查询串里。原先这里写 `location.pathname`，于是从「收藏的」点进详情、
               * 返回时落到 `/recipes/mine`（无参数＝默认「做过的」）——用户看到的就是
               * "返回后 tab 被重置了"。空态那条链接一直用的是 `from`，所以两处行为分叉。
               */
              state={{ from }}
            >
              <div className="cooked-card__pic">
                <RecipeImage src={dish.image} name={dish.name} />
              </div>
              <div className="cooked-card__body">
                <div className="cooked-card__name">{dish.name}</div>
                {/* 那行字由后端拼好（"做过 3 次 · 最近 3 天前"），前端只渲染 */}
                <div className="cooked-card__times">{dish.cookedLabel}</div>
                <div className="cooked-card__meta">
                  <span>{dish.category || '品类暂无'}</span>
                  <span>{dish.cuisine || '菜系暂无'}</span>
                </div>
                <div className="cooked-card__calories">{caloriesLabel(dish)}</div>
              </div>
            </Link>
          </article>
        ))}
      </div>
    </>
  )
}
