import { useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import Icon from '@/components/icons/Icon'
import { apiErrorMessage } from '@/api/client'
import { useFamily } from '@/api/family'
import {
  amountLabel,
  fromLabel,
  stockLine,
  useAddShoppingExtra,
  useCheckShoppingItem,
  useRemoveShoppingExtra,
  useRestockShopping,
  useShoppingList,
  type ShoppingItem,
} from '@/api/shopping'
import Page from '@/components/ui/Page'
import PageHeader from '@/components/ui/PageHeader'
import { toast } from '@/components/ui/toast'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import BackLink from '@/components/ui/BackLink'
import { useBackLink } from '@/lib/back-target'
import '@/pages/shared.scss'
import './shopping.scss'

/**
 * 采购清单（M7 / F7-01~F7-03、F7-05）。口径见 D-039、D-059 与 D-064。
 *
 * 这份清单是**从菜单推出来的**：接下来几天定了的那几餐里有哪些菜，那些菜要用什么、要多少。
 * 所以页面第一件事是说清它按哪几天算、由哪几餐汇总而来——不然用户不知道"为什么没有明天那道菜"
 * （明天还没定菜单，不是漏了）。
 *
 * 六件事刻意的：
 * - **只算定了的菜单**（还在收集中的不算）：那时菜还可能变，照它去买会白跑一趟；
 * - **勾选存在库里**（F7-03）：在超市里点一下要立刻划掉（乐观更新），刷新、换台设备都在；
 *   勾的是一样**名字**而不是"某一行"——清单每次现算，没有稳定的行 id，而"这袋盐我买了"
 *   与"哪份菜单要多少盐"本来也无关；
 * - **要买的按货架分组**（F7-03）：买菜不是按拼音买的，是一个区一个区扫过去的。
 *   组由后端给（空组不返回），组内保持名字序；
 * - **与库存比对（F7-02）分两组说**：要买的在上面（勾选进度只算它们），
 *   家里有的收在下面一条可展开的线里。**不把两边混在一张单子里**——
 *   用户拿着手机在超市，第一眼要知道的是"现在该往车里放什么"；
 * - **"算不清"的照实说**（"家里有 半盒，够不够看一眼"）：绝不写"够了"（那是编的），
 *   也不藏起来（那用户会以为漏了）。见 `shopping.rules` 的 `compareWithStock`；
 * - **自己写的菜单独列出来**：它们没有配料表可聚合，但漏掉的话用户会少买一道菜的东西。
 */
function Row({
  item,
  packed,
  onToggle,
  onRemove,
}: {
  item: ShoppingItem
  packed: boolean
  onToggle: (next: boolean) => void
  /** 只有自加的条目才有（菜单推出来的删不了，也不该删） */
  onRemove?: () => void
}) {
  const stock = stockLine(item)
  return (
    <li className="shop__item">
      <label className={['shop__label', packed && 'is-packed'].filter(Boolean).join(' ')}>
        <input
          type="checkbox"
          className="shop__check"
          checked={packed}
          onChange={(event) => onToggle(event.target.checked)}
        />
        <span className="shop__name">{item.name}</span>
        <span className="shop__amount">{amountLabel(item)}</span>
        <span className="shop__from">{fromLabel(item)}</span>
        {/* 家里有但不够：给出"还要买多少"（这是减法真算出来的，不是估的） */}
        {stock && <span className="shop__stock">{stock}</span>}
      </label>
      {/*
       * 「删掉」放在 label **外面**：放里面的话点它也会落在 label 的点击区上
       * （勾选框跟着翻一下，用户以为删不掉还顺手改了个状态）。
       */}
      {onRemove && (
        <button
          type="button"
          className="shop__remove"
          aria-label={`把「${item.name}」从清单上删掉`}
          onClick={onRemove}
        >
          <Icon name="close" size={13} />
        </button>
      )}
    </li>
  )
}

/** 家里已有的一行：**没有勾选框**（不用买的东西画个框会让人以为还要确认一遍） */
function CoveredRow({ item }: { item: ShoppingItem }) {
  return (
    <li className="shop__covered-item">
      <span className="shop__name">{item.name}</span>
      <span className="shop__amount">{amountLabel(item)}</span>
      <span className={['shop__stock', item.stock.verdict === 'unknown' && 'is-unsure'].filter(Boolean).join(' ')}>
        {stockLine(item)}
      </span>
    </li>
  )
}

export default function ShoppingPage() {
  const family = useFamily()
  const location = useLocation()
  // 没有来源时退「发现」：采购清单是从那儿的备菜计划/本周菜单推出来的（入口也在那儿）
  const back = useBackLink(location.state, '/discover')
  const list = useShoppingList({ enabled: Boolean(family.data) })
  /** 「家里有」那一组默认收起来：它不该占着"要买什么"的位置 */
  const [coveredOpen, setCoveredOpen] = useState(false)
  /** 加东西的那一行默认收着：它是偶尔用的，不该常占一块地方 */
  const [addOpen, setAddOpen] = useState(false)
  const [extraName, setExtraName] = useState('')
  const [extraAmount, setExtraAmount] = useState('')

  const check = useCheckShoppingItem()
  const addExtra = useAddShoppingExtra()
  const removeExtra = useRemoveShoppingExtra()
  const restock = useRestockShopping()

  const data = list.data
  const items = data?.items ?? []
  /** 勾掉的（服务端记着，一周内有效） */
  const checked = new Set(data?.checkedNames ?? [])
  /** 要买的（含"家里不够、还要买一点"的）；进度只算这一组 */
  const toBuy = items.filter((item) => item.needsBuy)
  /** 家里已有、不用买的 */
  const covered = items.filter((item) => !item.needsBuy)
  const total = toBuy.length
  const done = toBuy.filter((item) => checked.has(item.name)).length
  /** 要买的按货架分组：组是后端给的，这里只滤出"要买的"那部分，空组丢掉 */
  const toBuyAisles = (data?.aisles ?? [])
    .map((group) => ({ aisle: group.aisle, items: group.items.filter((item) => item.needsBuy) }))
    .filter((group) => group.items.length > 0)

  const toggle = (item: ShoppingItem, next: boolean) => {
    check.mutate(
      { name: item.name, checked: next },
      { onError: (error) => toast.error(apiErrorMessage(error)) },
    )
  }

  const remove = (item: ShoppingItem) => {
    if (!item.extraId) return
    removeExtra.mutate(
      { extraId: item.extraId },
      {
        onSuccess: () => toast.success(`把「${item.name}」从清单上删了`),
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  const submitExtra = (event: FormEvent) => {
    event.preventDefault()
    const name = extraName.trim()
    if (!name || addExtra.isPending) return
    addExtra.mutate(
      { name, amount: extraAmount.trim() || undefined },
      {
        onSuccess: () => {
          setExtraName('')
          setExtraAmount('')
          toast.success(`加上「${name}」了`)
        },
        // 同名会被拒（400）——那句话直接给用户看，不要说成"操作失败"
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  const doRestock = () => {
    restock.mutate(
      { names: [...checked] },
      {
        onSuccess: ({ result }) => {
          const said: string[] = []
          if (result.added.length > 0) said.push(`记进冰箱 ${result.added.length} 样`)
          if (result.skipped.length > 0) {
            said.push(`${result.skipped.length} 样冰箱里已经有了，没重复记（数量自己去冰箱里合并）`)
          }
          toast.success(said.join('；') || '都记好了')
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  return (
    <Page>
      <div className="pscreen shopping-page">
        <BackLink to={back.to} label={back.label} />
        <PageHeader title="采购清单" subtitle="按菜单算的，买菜不用再想一遍" art="order" />

        {!family.isPending && !family.data ? (
          <section className="card shop__tip">
            <p className="shop__tip-text">
              采购清单是按家里一起定的菜单算的。先创建家庭或用邀请码加入，再回来列清单。
            </p>
            <Link className="shop__link" to="/family" state={{ from: location.pathname }}>
              去创建或加入家庭<Icon name="arrow-right" size={13} className="icon--trail" />
            </Link>
          </section>
        ) : (
          <>
            {list.isPending && (
              <div className="card shop__status">
                <RecipeStatus title="正在算要买什么…" loading />
              </div>
            )}
            {list.isError && (
              <div className="card shop__status">
                <RecipeStatus title="采购清单暂时打不开" onRetry={() => { void list.refetch() }} />
              </div>
            )}
            {data?.scope === 'mine' && (
              <p className="shop__scope">家里关了共享，这份清单只按你自己参与的餐算。</p>
            )}

            {data && (
              <p className="shop__summary">
                {data.from.slice(5)} 起 {data.days} 天：{data.meals.length} 餐定了菜单，
                共 {data.dishCount} 道菜。
              </p>
            )}

            {/* 一道菜都没定：说清"为什么是空的"并给出路（去备菜计划排），不编内容 */}
            {data && total === 0 && data.missing.length === 0 && (
              <section className="card shop__empty">
                <p className="shop__empty-text">
                  这几天还没有定下来的菜单，所以没什么要买的。去备菜计划把菜排上，
                  菜一「选好了」就会出现在这里。
                </p>
                <Link className="shop__link" to="/prep" state={{ from: location.pathname }}>
                  去备菜计划<Icon name="arrow-right" size={13} className="icon--trail" />
                </Link>
              </section>
            )}

            {/* 全部都不用买（冰箱里都有）：这是一句好消息，要说得像好消息 */}
            {data && items.length > 0 && total === 0 && (
              <section className="card shop__covered-all">
                <p className="shop__covered-all-text">
                  这 {covered.length} 样冰箱里都有，不用买了。
                  {data.unsureCount > 0 && `其中 ${data.unsureCount} 样的量没法算清，下厨前看一眼。`}
                </p>
                <ul className="shop__covered-list">
                  {covered.map((item) => <CoveredRow key={item.name} item={item} />)}
                </ul>
              </section>
            )}

            {total > 0 && (
              <>
                <div className="shop__progress">
                  <span className="shop__progress-text">
                    买到 {done}/{total}
                  </span>
                  <span className="shop__progress-hint">（勾上是记着的，一周后自动清掉）</span>
                </div>
                <section className="card shop__list">
                  {toBuyAisles.map((group) => (
                    <div className="shop__aisle" key={group.aisle}>
                      <h3 className="shop__aisle-name">{group.aisle}</h3>
                      <ul className="shop__items">
                        {group.items.map((item) => (
                          <Row
                            key={item.name}
                            item={item}
                            packed={checked.has(item.name)}
                            onToggle={(next) => toggle(item, next)}
                            onRemove={item.extraId ? () => remove(item) : undefined}
                          />
                        ))}
                      </ul>
                    </div>
                  ))}
                </section>

                {/*
                 * 一键补货（F7-05）：买回来的东西一次记进冰箱。
                 * **勾了几样就补几样**——勾是"我真的买到了"，没勾的一样都没买。
                 */}
                {done > 0 && (
                  <button
                    type="button"
                    className="shop__restock"
                    disabled={restock.isPending}
                    onClick={doRestock}
                  >
                    {restock.isPending ? '正在记…' : `买到了，把这 ${done} 样记进冰箱`}
                  </button>
                )}

                {/* 加一样清单上没有的（垃圾袋、洗洁精这些没有菜谱的东西） */}
                <div className="shop__add">
                  {addOpen ? (
                    <form className="shop__add-form" onSubmit={submitExtra}>
                      <input
                        className="shop__add-input"
                        aria-label="要加的东西"
                        placeholder="比如 垃圾袋"
                        value={extraName}
                        maxLength={40}
                        onChange={(event) => setExtraName(event.target.value)}
                      />
                      <input
                        className="shop__add-input shop__add-input--amount"
                        aria-label="数量（可不写）"
                        placeholder="数量（可不写）"
                        value={extraAmount}
                        maxLength={24}
                        onChange={(event) => setExtraAmount(event.target.value)}
                      />
                      <button type="submit" className="shop__add-submit" disabled={!extraName.trim() || addExtra.isPending}>
                        {addExtra.isPending ? '加…' : '加上去'}
                      </button>
                    </form>
                  ) : (
                    <button type="button" className="shop__add-open" onClick={() => setAddOpen(true)}>
                      <Icon name="plus" size={14} className="icon--lead" /> 加一样清单上没有的
                    </button>
                  )}
                </div>
              </>
            )}

            {/*
             * 「家里有」那一组：**默认收起来**。
             *
             * 它不该占着"要买什么"的位置（用户在超市第一眼要看的是这个），
             * 但也不能不说——不说的话用户会以为冰箱白记了。
             * 所以给一条可点开的线，说清"有 N 样不用买"。
             */}
            {total > 0 && covered.length > 0 && (
              <>
                <button
                  type="button"
                  className="shop__covered-line"
                  aria-expanded={coveredOpen}
                  onClick={() => setCoveredOpen((open) => !open)}
                >
                  <span className="shop__covered-text">
                    家里有 {covered.length} 样，不用买
                    {data && data.unsureCount > 0 && `（${data.unsureCount} 样的量要自己看一眼）`}
                  </span>
                  <span className="shop__covered-arrow" aria-hidden>
                    <Icon name={coveredOpen ? 'chevron-up' : 'chevron-down'} size={15} />
                  </span>
                </button>
                {coveredOpen && (
                  <section className="card shop__covered-list-card">
                    <ul className="shop__covered-list">
                      {covered.map((item) => <CoveredRow key={item.name} item={item} />)}
                    </ul>
                  </section>
                )}
              </>
            )}

            {/* 冰箱里一条都没记：说清"记了才扣得掉"，而不是让用户以为这功能没用 */}
            {data && data.stockEmpty && items.length > 0 && (
              <p className="shop__stock-empty">
                冰箱里还没记东西，所以这份清单没替你扣掉什么。
                <Link className="shop__stock-link" to="/fridge" state={{ from: location.pathname }}>
                  记一下冰箱里有什么<Icon name="arrow-right" size={13} className="icon--trail" />
                </Link>
              </p>
            )}

            {data && data.missing.length > 0 && (
              <section className="card shop__missing">
                <p className="shop__missing-title">这几道菜没有配料表，要自己记一下：</p>
                <ul className="shop__missing-list">
                  {data.missing.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
                <p className="shop__missing-hint">
                  自己写的菜不会带配料（菜谱库里没有它的用料表）。做法页上有的，可以照着记。
                </p>
              </section>
            )}

            {data && items.length > 0 && (
              <p className="shop__foot">
                清单只算「已安排」「正在做」的菜单；还在收集中的不算——那时菜还可能变。
                勾上的记在库里（换台设备也在），一周后自动清掉，不用了自己点一下就回来。
                名字对得上冰箱的才算"家里有"（五花肉不算猪肉），对不上的会照买。
              </p>
            )}
          </>
        )}
      </div>
    </Page>
  )
}
