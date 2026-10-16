import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import Icon from '@/components/icons/Icon'
import { apiErrorMessage } from '@/api/client'
import { can, useFamily } from '@/api/family'
import { useAddOrderItem, useOrderOptions } from '@/api/orders'
import { caloriesLabel, type RecipeSummary } from '@/api/recipes'
import { toast } from '@/components/ui/toast'
import { useLongPress } from '@/lib/long-press'
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
 *
 * ## 给 `select` 就是"可以管的那张卡"（2026-10-16）
 *
 * 只有「我的菜谱 → 原创的」传它：长按这张卡进多选模式、此后点卡片=勾选
 * （用户 2026-10-16：「删除改为按住弹出复选框这种形式的」）。不传的那些页面
 * （菜谱小书 / 首页）翻的是公共菜谱库，本来就不许改，**长按也不该有反应**。
 *
 * 三件跟着它走的：
 * - **长按的判定用 `useLongPress`**（与点菜单同一个 hook、同一份"移动超过 10px 就不算长按"
 *   的规矩）：列表里按住本来是为了滚动，不放手滑一下不该弹出复选框；
 * - **多选模式下这张卡不再是链接**（与 OrderPage 同一条）：这时候点整张卡的意思是
 *   "勾选它"，留一个会跳走的链接等于在最需要多选的时候把人带走；
 * - **长按抬手补的那一次 click 要吐掉**（`consumeClick`），否则刚选中就被紧接着的点击取消。
 */
export default function DishCard({
  dish,
  favorited = false,
  onToggleFavorite,
  select,
}: {
  dish: RecipeSummary
  /** 我收藏过这道没有（由**父级批量查**一次给下来，见下） */
  favorited?: boolean
  /** 点那颗心。**不给就不画心**（没登录时父级不传，别让用户白点一次再收 401） */
  onToggleFavorite?: () => void
  /** 多选（长按进模式、点卡片勾选）。**只有"自己写的菜"才给**，见文件头 */
  select?: {
    /** 现在在多选模式里没有 */
    active: boolean
    /** 这一张被勾上了没有 */
    picked: boolean
    /** 点它＝勾选/取消 */
    onToggle: () => void
    /** 长按它＝进多选并勾上它 */
    onLongPress: () => void
  }
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

  // 卡片自己是这一张的组件实例，所以 hook 可以就在这一层（点菜单那边是一个实例服务整个列表，
  // 因为它的卡片是在 .map() 里画的——见 OrderPage）。
  const { handlers, consumeClick } = useLongPress(() => select?.onLongPress(), { disabled: !select })
  const picking = Boolean(select?.active)

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

  /*
   * 图与文字块（点它进详情）。多选模式下**换成 `<div>`**：那时候点整张卡的意思是"勾选它"，
   * 留一个会跳走的链接等于在最需要多选的时候把人带走（与 OrderPage 同一条）。
   */
  const face = (
    <>
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
    </>
  )

  return (
    <article
      className={[
        'dish-card',
        picking && 'is-picking',
        picking && select?.picked && 'is-picked',
      ].filter(Boolean).join(' ')}
      /*
       * 选择模式下这张卡是一个**复选框**：`role` + `aria-checked` 让读屏也念得出
       * "已选/未选"（只画一个 ✓ 的方块对读屏等于没有）。
       */
      role={picking ? 'checkbox' : undefined}
      aria-checked={picking ? select?.picked : undefined}
      onPointerDown={select ? handlers.onPointerDown : undefined}
      onPointerMove={select ? handlers.onPointerMove : undefined}
      onPointerUp={select ? handlers.onPointerUp : undefined}
      onPointerCancel={select ? handlers.onPointerCancel : undefined}
      onPointerLeave={select ? handlers.onPointerLeave : undefined}
      onContextMenu={select ? handlers.onContextMenu : undefined}
      onClick={(event) => {
        /*
          **长按抬手时浏览器会补一次 click**：不吐掉的话，"长按选中"会被紧接着的
          这次点击立刻取消（表现为"按半天选不上"），而且它还会顺着链接跳进详情页。
          这一句必须在最前面，且两种情况下都要 `preventDefault` 挡住链接的默认跳转
          （默认动作在事件走完冒泡之后才执行，所以这里拦得住）。
        */
        if (consumeClick()) {
          event.preventDefault()
          return
        }
        if (picking) {
          event.preventDefault()
          select?.onToggle()
        }
      }}
    >
      {/*
        选择模式下的勾选方块（用户 2026-10-16：「按住弹出复选框」）。挂在**左上角**：
        右上角是收藏那颗心的位置，两个挤在一起会互相盖住。
        `aria-hidden`：状态已经由卡片的 role/aria-checked 说了，这里只是给眼睛看的。
      */}
      {picking && (
        <span
          className={['dish-card__pick', select?.picked && 'is-on'].filter(Boolean).join(' ')}
          aria-hidden="true"
        >
          {select?.picked && <Icon name="tick" size={12} white />}
        </span>
      )}

      {/* 多选模式下不画收藏那颗心：这一屏上唯一的动作是"勾选"，多一颗心会抢走误触 */}
      {!picking && onToggleFavorite && (
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
          <Icon name={favorited ? 'heart' : 'heart-outline'} size={17} />
        </button>
      )}

      {picking ? (
        <div className="dish-card__link">{face}</div>
      ) : (
        <Link
          className="dish-card__link"
          to={`/recipes/${encodeURIComponent(dish.id)}`}
          state={{ from: `${location.pathname}${location.search}`, ...(plan ? { plan } : {}) }}
          aria-label={`查看${dish.name}菜谱`}
        >
          {face}
        </Link>
      )}

      {/*
        两个动作**并排一行**（用户 2026-10-13：「看做法和点这道放在一行」）。
        多选模式下整行不画：这一屏上点卡片是勾选，两颗按钮既指不到详情、也不该加菜。

        它们是两个独立的可点元素，所以**不能一个套一个**：把「点这道」放进链接里，
        点它会冒泡到链接上——用户想加菜，结果进了详情页（F1-10 上线的老问题）。
        「看做法」于是也做成独立的 `<Link>`（同一个目标、带上同样的 state），
        两个并排，靠 `.dish-card__actions` 那一行兜住。
      */}
      {!picking && (
        <div className="dish-card__actions">
          <Link
            className="dish-card__browse"
            to={`/recipes/${encodeURIComponent(dish.id)}`}
            state={{ from: `${location.pathname}${location.search}`, ...(plan ? { plan } : {}) }}
            aria-label={`查看${dish.name}做法`}
          >
            看做法<Icon name="arrow-right" size={13} className="icon--trail" />
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
      )}
    </article>
  )
}
