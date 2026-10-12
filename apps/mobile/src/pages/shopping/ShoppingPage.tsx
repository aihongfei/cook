import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useFamily } from '@/api/family'
import { amountLabel, fromLabel, useShoppingList, type ShoppingItem } from '@/api/shopping'
import Page from '@/components/ui/Page'
import PageHeader from '@/components/ui/PageHeader'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import { readBackLink } from '@/pages/back-link'
import '@/pages/shared.scss'
import './shopping.scss'

/**
 * 采购清单（M7 / F7-01）。口径见 D-039。
 *
 * 这份清单是**从菜单推出来的**：接下来几天定了的那几餐里有哪些菜，那些菜要用什么、要多少。
 * 所以页面第一件事是说清它按哪几天算、由哪几餐汇总而来——不然用户不知道"为什么没有明天那道菜"
 * （明天还没定菜单，不是漏了）。
 *
 * 四件事刻意的：
 * - **只算定了的菜单**（还在收集中的不算）：那时菜还可能变，照它去买会白跑一趟；
 * - **勾选状态只在本地**（`useState`）：F7-03「清单编辑」才做持久化。
 *   现在这是"拿着手机在超市里划掉"的用法——刷新会丢，所以**不假装它记得**（页尾说明）；
 * - **不显示"库存充足"之类**：冰箱（M6）还没建，装不知道比编数字诚实（F7-02 才做对比库存）；
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
  return (
    <li className="shop__item">
      <label className={['shop__label', packed && 'is-packed'].filter(Boolean).join(' ')}>
        <input type="checkbox" className="shop__check" checked={packed} onChange={onToggle} />
        <span className="shop__name">{item.name}</span>
        <span className="shop__amount">{amountLabel(item)}</span>
        <span className="shop__from">{fromLabel(item)}</span>
      </label>
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

  const toggle = (name: string) => {
    setPacked((previous) => {
      const next = new Set(previous)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const data = list.data
  const total = data?.items.length ?? 0
  const done = data ? data.items.filter((item) => packed.has(item.name)).length : 0

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
                    {data?.items.map((item) => (
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

            {data && total > 0 && (
              <p className="shop__foot">
                清单只算「已安排」「正在做」的菜单；还在收集中的不算——那时菜还可能变。
              </p>
            )}
          </>
        )}
      </div>
    </Page>
  )
}
