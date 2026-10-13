import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useFamily } from '@/api/family'
import { amountLabel, fromLabel, stockLine, useShoppingList, type ShoppingItem } from '@/api/shopping'
import Page from '@/components/ui/Page'
import PageHeader from '@/components/ui/PageHeader'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import { readBackLink } from '@/pages/back-link'
import '@/pages/shared.scss'
import './shopping.scss'

/**
 * 采购清单（M7 / F7-01、F7-02）。口径见 D-039 与 D-059。
 *
 * 这份清单是**从菜单推出来的**：接下来几天定了的那几餐里有哪些菜，那些菜要用什么、要多少。
 * 所以页面第一件事是说清它按哪几天算、由哪几餐汇总而来——不然用户不知道"为什么没有明天那道菜"
 * （明天还没定菜单，不是漏了）。
 *
 * 五件事刻意的：
 * - **只算定了的菜单**（还在收集中的不算）：那时菜还可能变，照它去买会白跑一趟；
 * - **勾选状态只在本地**（`useState`）：F7-03「清单编辑」才做持久化。
 *   现在这是"拿着手机在超市里划掉"的用法——刷新会丢，所以**不假装它记得**（页尾说明）；
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
}: {
  item: ShoppingItem
  packed: boolean
  onToggle: () => void
}) {
  const stock = stockLine(item)
  return (
    <li className="shop__item">
      <label className={['shop__label', packed && 'is-packed'].filter(Boolean).join(' ')}>
        <input type="checkbox" className="shop__check" checked={packed} onChange={onToggle} />
        <span className="shop__name">{item.name}</span>
        <span className="shop__amount">{amountLabel(item)}</span>
        <span className="shop__from">{fromLabel(item)}</span>
        {/* 家里有但不够：给出"还要买多少"（这是减法真算出来的，不是估的） */}
        {stock && <span className="shop__stock">{stock}</span>}
      </label>
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
  const back = readBackLink(location.state, '/discover')
  const list = useShoppingList({ enabled: Boolean(family.data) })
  // 勾掉的只记在这一屏：刷新就没了，页尾会说明（F7-03 才做"记住"）
  const [packed, setPacked] = useState<Set<string>>(new Set())
  /** 「家里有」那一组默认收起来：它不该占着"要买什么"的位置 */
  const [coveredOpen, setCoveredOpen] = useState(false)

  const toggle = (name: string) => {
    setPacked((previous) => {
      const next = new Set(previous)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const data = list.data
  const items = data?.items ?? []
  /** 要买的（含"家里不够、还要买一点"的）；进度只算这一组 */
  const toBuy = items.filter((item) => item.needsBuy)
  /** 家里已有、不用买的 */
  const covered = items.filter((item) => !item.needsBuy)
  const total = toBuy.length
  const done = toBuy.filter((item) => packed.has(item.name)).length

  return (
    <Page>
      <div className="pscreen shopping-page">
        <Link className="page-back" to={back.to}>← {back.label}</Link>
        <PageHeader title="采购清单" subtitle="按菜单算的，买菜不用再想一遍" art="order" />

        {!family.isPending && !family.data ? (
          <section className="card shop__tip">
            <p className="shop__tip-text">
              采购清单是按家里一起定的菜单算的。先创建家庭或用邀请码加入，再回来列清单。
            </p>
            <Link className="shop__link" to="/family" state={{ from: location.pathname }}>
              去创建或加入家庭 →
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
                  去备菜计划 →
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
                  <span className="shop__progress-hint">（勾掉的只记在这一屏，刷新就没了）</span>
                </div>
                <section className="card shop__list">
                  <ul className="shop__items">
                    {toBuy.map((item) => (
                      <Row
                        key={item.name}
                        item={item}
                        packed={packed.has(item.name)}
                        onToggle={() => toggle(item.name)}
                      />
                    ))}
                  </ul>
                </section>
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
                  <span className="shop__covered-arrow" aria-hidden>{coveredOpen ? '⌃' : '⌄'}</span>
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
                  记一下冰箱里有什么 →
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
                名字对得上冰箱的才算"家里有"（五花肉不算猪肉），对不上的会照买。
              </p>
            )}
          </>
        )}
      </div>
    </Page>
  )
}
