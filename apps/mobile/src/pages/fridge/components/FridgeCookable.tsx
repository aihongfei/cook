import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useCookable, useFridge, type CookableDish } from '@/api/fridge'
import RecipeImage from '@/pages/recipes/components/RecipeImage'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'

/**
 * 能做点什么（M5 / F5-04 手边食材选菜 + M6 / F6-07 库存↔推荐）。规则见 `pantry.rules.ts`。
 *
 * 这两条需求是**同一个判断的两种问法**，所以合成一块：
 * - F6-07："我家冰箱这些东西能做出来什么"——打开冰箱页就该看到，不用先勾一遍；
 * - F5-04："我今天就想用手边这几样"——给一个「挑几样」，勾自己想用的。
 * 默认是不勾（= 整个冰箱），因为那是用户 90% 时候想问的。
 *
 * 四件事刻意的：
 *
 * ① **"不用买就能做"与"还差一样"必须分开说**，而且差的**列名字**。它们对用户是两件完全不同的事：
 *    前者是"现在就能下厨"，后者是"顺路买一样就行"。混在一起报一个数字，用户还得点进去才知道要不要出门。
 *
 * ② **调料的处理要说出来**（"调料 N 样没算"）。判断时调料两边都跳过（否则每道菜都差盐油），
 *    但"跳过了什么"不能不说——不然用户看着冰箱里 17 条、结果只说用了 6 样，会以为功能漏了东西。
 *
 * ③ **挑几样从"全选"开始**，不是从空开始。空手进挑选模式、结果区一片空白，用户会以为坏了；
 *    而"全选之后去掉不想用的"正好对应他心里的动作（"我今天不想做蘑菇"）。
 *    这也与后端"没传 = 用整个冰箱"同一口径，不会出现"全取消 → 悄悄回落到整个冰箱"的错位
 *    ——**挑到一样不剩时不发请求**，明说"先点几样"，不拿整冰箱的结果冒充。
 *
 * ④ **口味挡掉的菜要说出来**（F5-03）。有人过敏被排掉的菜不能默默消失——不说的话，
 *    用户会以为"我冰箱里这些东西就只能做这么几道"，而其实是家里的档案在起作用。
 *
 * 不做"看全部"入口：这一块给的是"够决定今晚做什么"的一屏（默认 12 道），
 * 列表页是菜谱大全的事（与 FamilyPicks 那条"没有全部榜单就不编入口"同一规矩）。
 */
function DishRow({ dish, from }: { dish: CookableDish; from: string }) {
  const ready = dish.missing.length === 0
  return (
    <li className="cook__item">
      <Link
        className="cook__link"
        to={`/recipes/${encodeURIComponent(dish.id)}`}
        state={{ from }}
        aria-label={`查看${dish.name}菜谱`}
      >
        <span className="cook__pic">
          <RecipeImage src={dish.image} name={dish.name} />
        </span>
        <span className="cook__body">
          <span className="cook__name">{dish.name}</span>
          {/*
           * 两行都是"具体哪几样"，不是数字：
           * 第一行说用掉了冰箱里的什么（这是他最想看到的功劳），第二行说还差什么。
           */}
          <span className="cook__have">用上了 {dish.have.join('、')}</span>
          {!ready && <span className="cook__missing">还差 {dish.missing.join('、')}</span>}
        </span>
        {/*
         * 状态徽章只在**两件确定的事**上出现：能直接做 / 差几样。
         * "不用买"是这一整块唯一敢下的结论（见 pantry.rules 文件头 ③）。
         */}
        <span className={['cook__badge', ready && 'is-ready'].filter(Boolean).join(' ')}>
          {ready ? '不用买' : `差 ${dish.missingCount} 样`}
        </span>
      </Link>
    </li>
  )
}

export default function FridgeCookable({ enabled }: { enabled: boolean }) {
  /*
   * 「挑几样」开着没有，以及挑了哪几样。`null` = 还没进挑选模式（= 用整个冰箱）。
   * 用 `null` 而不是空数组表示"没挑"：[].length === 0 与"全取消"无法区分，
   * 而这两种状态要显示完全不同的东西（见文件头 ③）。
   */
  const [picked, setPicked] = useState<string[] | null>(null)
  /** 只看"不用买就能做"的：默认关（差一样的菜也是有用的候选） */
  const [readyOnly, setReadyOnly] = useState(false)

  const fridge = useFridge({ enabled })
  const board = fridge.data

  /** 挑选模式下勾的那几样；默认模式是 `null`（用整个冰箱） */
  const pickedList = picked ?? []
  /** 挑到一样不剩：不发请求，也不拿整冰箱的结果冒充（见文件头 ③） */
  const nothingPicked = picked !== null && pickedList.length === 0

  /*
   * **两个请求，不是一个**：一个问"整个冰箱能做什么"，一个问"挑好的这几样能做什么"。
   *
   * 为什么非要都留着：默认模式的答案里带着 `pantry`（后端摘掉调料之后的手边清单），
   * 而**标签列表必须用它**——它是"什么算调料"的唯一权威定义（前端自己判一遍必然分叉）。
   *
   * 这里踩过一个真 bug（单测抓到的）：第一版把 `usableItems` 取自**当前那次**请求的
   * `pantry`，于是取消勾选"西红柿"之后，发出去的清单里没有它、回来的 `pantry` 也没有它，
   * **那个标签直接从界面上消失了**——用户再也点不回来。选东西的列表绝不能跟着选择结果变。
   * 现在"有哪些可选"只看整个冰箱那份，与当前勾了什么无关。
   *
   * 成本是零：默认模式下两次调用是**同一个缓存键**，react-query 只发一个请求；
   * 进了挑选模式，"整个冰箱"那份还在缓存里（`staleTime` 内），也不会重取。
   */
  const whole = useCookable({ maxMissing: readyOnly ? 0 : 1 }, { enabled })
  const pickedOnly = useCookable(
    { ingredients: pickedList, maxMissing: readyOnly ? 0 : 1 },
    { enabled: enabled && picked !== null && !nothingPicked },
  )

  /*
   * 一样都没挑时**整个结果区都不画**。
   *
   * 这里踩过一个坑：`enabled: false` 只是"不发新请求"，react-query **会把上一次的缓存数据
   * 照原样交回来**（`data` 不是 undefined）。于是"先点几样"的提示下面，会挂着上一次
   * 整冰箱算出来那串菜——说的和做的不是一回事。所以不是"不更新界面"，是**不画**。
   */
  const active = picked === null ? whole : pickedOnly
  const data = nothingPicked ? undefined : active.data

  /*
   * 可选的那几样：**整个冰箱那份**的 `pantry`，按冰箱的分区顺序排
   * （`FRIDGE_ZONES` = 常温→保鲜→冷藏→冷冻，与上面冰箱那块一致——
   * 用户站在冰箱前的顺序是"哪一格拿什么"）。与当前勾了什么**无关**（见上方注释）。
   */
  const usableItems = useMemo(() => {
    const pantry = whole.data?.pantry
    if (!board || !pantry?.length) return [] as string[]
    const inZoneOrder: string[] = []
    for (const group of board.zones) for (const item of group.items) inZoneOrder.push(item.name)
    return inZoneOrder.filter((name) => pantry.includes(name))
  }, [board, whole.data?.pantry])

  // 空冰箱：FridgeStock 已经说了"冰箱还是空的"，这里不必再说一遍（说了就是两块一样的空话）
  if (board && board.summary.total === 0) return null
  /*
   * 冰箱里只有调料：说清是**调料不算**，而不是"你做不了菜"。
   *
   * 判据取自**整个冰箱那份**（`whole`）而不是当前那份：这个结论讲的是"冰箱里没有真材实料"，
   * 与用户勾了哪几样无关——勾掉仅有的两样真菜之后，不该突然改口说"你的冰箱只有调料"。
   */
  if (board && whole.data && whole.data.usable === 0) {
    return (
      <section className="card cook">
        <div className="cook__head">
          <span className="cook__title">能做点什么</span>
        </div>
        <p className="cook__empty">
          冰箱里的 {whole.data.skipSeasonings} 样都是调料，光有它们做不出菜。
          记几样真材实料（蛋、菜、肉），这里就会告诉你今晚能做什么。
        </p>
      </section>
    )
  }
  if (!board) return null

  const dishes = data?.items ?? []
  const allPicked = picked !== null && pickedList.length === usableItems.length

  return (
    <section className="card cook">
      <div className="cook__head">
        <span className="cook__title">能做点什么</span>
        {/*
         * 「挑几样」在标题上（与冰箱那块「记一样 / 拍照」同一个位置习惯）。
         * 它是个**开关**，开一次就从"全选"开始：点一下把整个冰箱当成手边清单，
         * 用户再取消掉不想用的（见文件头 ③）。
         */}
        <button
          type="button"
          className={['cook__pick', picked !== null && 'is-on'].filter(Boolean).join(' ')}
          onClick={() => setPicked(picked === null ? [...usableItems] : null)}
        >
          {picked === null ? '挑几样' : '用整个冰箱'}
        </button>
      </div>

      {/* 挑选模式：把冰箱里能用的那几样摊成可点的标签 */}
      {picked !== null && (
        <>
          <p className="cook__pick-hint">
            {nothingPicked
              ? '一样都没选：点几样你想用掉的。'
              : allPicked
                ? `现在用的是整个冰箱（${usableItems.length} 样），点一下去掉不想用的。`
                : `挑好了 ${pickedList.length} 样，下面按这几样算。`}
          </p>
          <div className="cook__chips">
            {usableItems.map((name) => {
              const on = pickedList.includes(name)
              return (
                <button
                  key={name}
                  type="button"
                  className={['cook__chip', on && 'is-on'].filter(Boolean).join(' ')}
                  aria-pressed={on}
                  /*
                   * 用**函数式更新**而不是 `setPicked(on ? pickedList.filter(...) : [...pickedList, name])`。
                   *
                   * 直接引用 `pickedList` 会把它闭包在**这次渲染**的那份数组上——同一个 tick 里
                   * 连点两个标签，两次都从同一份旧数组算，后一次把前一次整个覆盖掉。
                   * 真人点不了那么快（每次点击之间都会重渲染），但这是**静默丢状态**：
                   * 浏览器验收时我用脚本连点 9 下，界面显示"挑好了 10 样"，看起来像点击没反应。
                   * 函数式更新让每次都在**上一次的结果**上算，这类问题从根上没有了。
                   */
                  onClick={() =>
                    setPicked((current) => {
                      const list = current ?? []
                      return list.includes(name) ? list.filter((item) => item !== name) : [...list, name]
                    })
                  }
                >
                  {name}
                </button>
              )
            })}
          </div>
        </>
      )}

      {/* 只看不用买的：这是"今晚马上能做"与"顺路买一样"的分界线 */}
      <div className="cook__filters">
        <button
          type="button"
          className={['cook__filter', readyOnly && 'is-on'].filter(Boolean).join(' ')}
          aria-pressed={readyOnly}
          onClick={() => setReadyOnly((value) => !value)}
        >
          只看不用买的
        </button>
        {/*
         * 摘要这句话是这一块的核心结论，各状态都说实话：
         * 有几道能用上、调料跳过了几样、挑了几样。
         */}
        {data && (
          <span className="cook__summary">
            {picked !== null && `用挑好的 ${pickedList.length} 样 · `}
            {data.total === 0 ? '这几样配不出菜' : `${data.total} 道能用上`}
            {data && data.skipSeasonings > 0 && picked === null && ` · 调料 ${data.skipSeasonings} 样没算`}
          </span>
        )}
      </div>

      {active.isPending && !nothingPicked && (
        <div className="cook__status-line">
          <RecipeStatus title="正在翻菜谱，看这些能做什么…" loading />
        </div>
      )}
      {active.isError && (
        <div className="cook__status-line">
          <RecipeStatus title="暂时算不出来" onRetry={() => { void active.refetch() }} />
        </div>
      )}

      {/* 共享关掉时说明只用了自己记的那些（与冰箱那块同一口径） */}
      {data && data.scope === 'mine' && (
        <p className="cook__scope">家里关了共享，这里只按你自己记的那些算。</p>
      )}

      {data && data.filteredOut > 0 && (
        <p className="cook__filtered">
          有 {data.filteredOut} 道被口味档案挡掉了（家里人过敏的东西）——在「我的 · 口味与忌口」里能改。
        </p>
      )}

      {nothingPicked && <p className="cook__empty">先点几样你想用掉的，下面就会给你能做的菜。</p>}

      {data && dishes.length === 0 && (
        <p className="cook__empty">
          {readyOnly
            ? '这几样暂时没有"不用买就能做"的菜。把「只看不用买的」关掉，能看到差一两样的。'
            : '这几样暂时配不出菜。菜谱要的配料得和冰箱里的名字对得上——记的时候尽量用常见的叫法（比如"西红柿"而不是"洋柿子"）。'}
        </p>
      )}

      {dishes.length > 0 && (
        <ul className="cook__list">
          {dishes.map((dish) => (
            <DishRow key={dish.id} dish={dish} from="/fridge" />
          ))}
        </ul>
      )}

      {/* 只说"还有更多"，不给"看全部"——没有那个页面，编一个入口等于给死路（同 FamilyPicks） */}
      {data && data.total > dishes.length && (
        <p className="cook__more-line">还有 {data.total - dishes.length} 道能做，先把眼前这几道做了。</p>
      )}
    </section>
  )
}
