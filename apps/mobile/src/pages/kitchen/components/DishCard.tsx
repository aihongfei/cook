import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { can, useFamily } from '@/api/family'
import { useAddOrderItem, useOrderOptions } from '@/api/orders'
import { caloriesLabel, type RecipeSummary } from '@/api/recipes'
import { toast } from '@/components/ui/toast'
import { nextMealDefaults } from '@/pages/order/next-meal'
import { readPlanTarget } from '@/pages/order/plan-target'
import RecipeImage from '@/pages/recipes/components/RecipeImage'
import RecipeOriginBadge from '@/pages/recipes/components/RecipeOriginBadge'
import '../kitchen.scss'

/**
 * 真实菜谱卡：点进详情看做法；若是从「去安排某一餐」进来的，把目标原样带下去。
 *
 * **卡片上还有一个「点这道」（F1-10）**：翻菜谱时"看到就想吃"是最强的那个瞬间，
 * 非让人先点进详情、再点一次「想吃这道」是白多一步。它一次点击就落进某一餐，
 * 落进哪一餐由两件事决定：
 * - **带目标进来就用目标**（从本周菜单/备菜计划的「去安排」过来时，这一路都带着 `plan`）——
 *   用户正在排"后天晚餐"，看到一道就点，当然该进后天晚餐，不能落到默认的下一餐；
 * - 没带目标就用**下一餐**（`nextMealDefaults`，与「想吃这道」「整组加入」共用同一条规则）。
 *
 * **那颗心（F1-09）的状态由父级传下来**，卡片自己不去查：一屏十几张卡各查各的
 * 就是十几个请求（还会撞限流），所以由父级用 `useFavoriteStatus(一屏的 id)` 一次问清。
 *
 * 三件事刻意的：
 * - **按钮是 `<Link>` 的兄弟而不是子节点**：嵌套可点元素既是无效结构，点击也会冒泡到链接上，
 *   变成"想加菜却进了详情页"；
 * - **加过就置灰**（与「AI 帮你想」的推荐卡同一做法）：同一张卡连点两次会变成两份，
 *   而多数时候那是误触；真想再加一份的人可以进详情页点「想吃这道」；
 * - **不能点菜时不画按钮**（没加入家庭 / 角色没有 `order.create`）：给个按钮让用户白点一次、
 *   再拿 403 告诉他不行，比不给他按钮更糟。
 */
export default function DishCard({
  dish,
  favorited = false,
  onToggleFavorite,
  manage,
}: {
  dish: RecipeSummary
  /** 我收藏过这道没有（由**父级批量查**一次给下来，见下） */
  favorited?: boolean
  /** 点那颗心。**不给就不画心**（没登录时父级不传，别让用户白点一次再收 401） */
  onToggleFavorite?: () => void
  /**
   * 自己写的菜的**改/删**入口（用户 2026-10-15：「我的菜谱里面现在也没有删除和编辑这种操作」
   * → 选的是"卡片上直接放"）。只有「我的菜谱 → 原创的」传它。
   *
   * 为什么不是每张卡都有：另外两处（菜谱小书、首页）翻的是**公共菜谱库**，
   * 本来就不许改——给个按钮再拿 403 告诉用户不行，比不给更糟（与"不能点菜时不画点这道"同一条）。
   */
  manage?: { onEdit: () => void; onDelete: () => void }
}) {
  const location = useLocation()
  // 路由 state 是不可信输入，统一走 readPlanTarget 校验（见该文件）；这里只负责"原样传下去"
  const plan = readPlanTarget(location.state)

  const family = useFamily()
  const options = useOrderOptions()
  const addItem = useAddOrderItem()
  const [added, setAdded] = useState(false)

  // 与点菜抽屉同一套判定：能力来自后端下发的 myCapabilities，前端不自己算角色
  const mayOrder = Boolean(family.data) && can(family.data, 'order.create')

  const days = options.data?.dayOptions ?? []
  const fallback = nextMealDefaults(days)
  const day = plan?.date ?? fallback.day
  const meal = plan?.meal ?? fallback.meal

  const point = () => {
    if (!day || !meal) return
    addItem.mutate(
      { recipeId: dish.id, mealDate: day, meal },
      {
        onSuccess: (card) => {
          const dayLabel = days.find((option) => option.value === card.date)?.label ?? card.date
          setAdded(true)
          // 一次点击就写完的动作，必须说清它写到哪一餐了
          toast.success(`已加入${dayLabel}${card.mealLabel}，等掌勺人安排`)
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  return (
    <article className="dish-card">
      {onToggleFavorite && (
        /*
         * 心放在图片上（与手绘稿一致），但**必须是 `<Link>` 的兄弟**：
         * 放进 Link 里，点心的那次点击会冒泡到链接上——用户想收藏，结果进了详情页。
         * 所以它靠 `.dish-card` 的定位压到图片右上角（见 kitchen.scss 的 .dish-card__fav）。
         */
        <button
          type="button"
          className={['dish-card__fav', favorited && 'is-on'].filter(Boolean).join(' ')}
          aria-pressed={favorited}
          aria-label={favorited ? `取消收藏${dish.name}` : `收藏${dish.name}`}
          onClick={onToggleFavorite}
        >
          {favorited ? '❤' : '♡'}
        </button>
      )}

      {/* 图与文字块（点它进详情）。两个动作按钮在这一层之外，见下面那段 */}
      <Link
        className="dish-card__link"
        to={`/recipes/${encodeURIComponent(dish.id)}`}
        state={{ from: `${location.pathname}${location.search}`, ...(plan ? { plan } : {}) }}
        aria-label={`查看${dish.name}菜谱`}
      >
        <div className="dish-card__pic"><RecipeImage src={dish.image} name={dish.name} /></div>
        <div className="dish-card__body">
          <div className="dish-card__name">{dish.name}</div>
          <div className="dish-card__meta">
            <span>{dish.category || '品类暂无'}</span>
            <span>{dish.cuisine || '菜系暂无'}</span>
            {/* 来源徽标（F1-12）放在这一行、不放在菜名旁边：这行本来就小一号，
                徽标跟着弱下去，不会把整张卡的注意力从菜名上抢走 */}
            <RecipeOriginBadge origin={dish.origin} sourceLabel={dish.sourceLabel} />
          </div>
          <div className="dish-card__calories">{caloriesLabel(dish)}</div>
        </div>
      </Link>

      {/*
       * 两个动作**并排一行**（用户 2026-10-13：「看做法和点这道放在一行」）。
       *
       * 它们是两个独立的可点元素，所以**不能一个套一个**：把「点这道」放进链接里，
       * 点它会冒泡到链接上——用户想加菜，结果进了详情页（F1-10 上线的老问题）。
       * 「看做法」于是也做成独立的 `<Link>`（同一个目标、带上同样的 state），
       * 两个并排，靠 `.dish-card__actions` 那一行兜住。
       */}
      <div className="dish-card__actions">
        <Link
          className="dish-card__browse"
          to={`/recipes/${encodeURIComponent(dish.id)}`}
          state={{ from: `${location.pathname}${location.search}`, ...(plan ? { plan } : {}) }}
          aria-label={`查看${dish.name}做法`}
        >
          看做法 →
        </Link>

        {/* 不能点菜时不画按钮（没加入家庭 / 角色没有 `order.create`）：给个按钮让用户白点一次、
            再拿 403 告诉他不行，比不给他按钮更糟。此时「看做法」自己占满那一行 */}
        {mayOrder && (
          added ? (
            <span className="dish-card__order-done">已加入</span>
          ) : (
            <button
              type="button"
              className="dish-card__order-btn"
              disabled={addItem.isPending || !day || !meal}
              onClick={point}
            >
              点这道
            </button>
          )
        )}
      </div>

      {/*
        自己写的菜：改与删（见 `manage` 的说明）。与上面两个动作**同一层**（都是 `<Link>` 的兄弟），
        所以点它们不会冒泡到"进详情"上。做成安静的一行而不是两颗大按钮：
        这一页最常做的事仍然是"点卡片进去看做法"，管理动作要够得着、但不抢眼。
      */}
      {manage && (
        <div className="dish-card__manage">
          <button type="button" className="dish-card__edit" onClick={manage.onEdit}>编辑</button>
          <button type="button" className="dish-card__remove" onClick={manage.onDelete}>删除</button>
        </div>
      )}
    </article>
  )
}
