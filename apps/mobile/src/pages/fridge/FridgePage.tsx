import { Link, useLocation } from 'react-router-dom'
import { useFamily } from '@/api/family'
import { useShoppingList } from '@/api/shopping'
import Page from '@/components/ui/Page'
import PageHeader from '@/components/ui/PageHeader'
import FridgeStock from './components/FridgeStock'
import FridgeCookable from './components/FridgeCookable'
import '../shared.scss'
import './fridge.scss'

/**
 * 冰箱（M6 库存 / M7 采购清单 / M16 拍照入库）。形态见 D-040。
 *
 * 这一页 2026-10-13 改了两轮：
 * - 原先是 M0 拼版面时写死的示例（12 在库 / 3 临期 / 今日先吃两道 / 四个存放区），
 *   用户会当真——先把假数据撤了；
 * - 第一版改法把采购清单整块预览搬进来（标题 + 由来 + 三样预览 + 按钮），
 *   **用户当场指出"占据太大位置了，冰箱相关应该才是主题"**。
 *   所以现在：采购是**一行入口**（要去买什么 · 共 N 样 ›），主体留给冰箱自己。
 *
 * 两条规矩：
 * - **主体是冰箱**：这一页讲的是"家里有什么"（分区、临期、先吃），
 *   采购清单只是从这里点出去的下一站（它在 `/shopping` 有完整的一页）；
 * - **一个假数字都不写**：库存数据模型（M6）还没做，所以那块**只画将来会长什么样**、
 *   不填任何数字。写死几个数比空着更糟——用户会以为家里真有那些东西。
 */
export default function FridgePage() {
  const family = useFamily()
  const location = useLocation()
  const list = useShoppingList({ enabled: Boolean(family.data) })
  const data = list.data
  const total = data?.items.length ?? 0

  return (
    <Page>
      <div className="pscreen">
        <PageHeader title="我的冰箱" subtitle="家里有什么、要买什么，都在这儿" art="fridge" />

        {!family.isPending && !family.data ? (
          <section className="card fridge-tip">
            <p className="fridge-tip__text">
              采购清单是按家里一起定的菜单算的。先创建家庭或用邀请码加入，再回来买菜。
            </p>
            <Link className="fridge-tip__link" to="/family" state={{ from: location.pathname }}>
              去创建或加入家庭 →
            </Link>
          </section>
        ) : (
          /*
           * 采购清单入口：**一行**。它是这一页的出口而不是主体——
           * 完整清单（可勾选、按名字排序、每样写明为哪几道菜买）在 `/shopping`。
           * 三种状态都只占一行，这样无论取不取得到数据，冰箱那块的位置都不会被挤走。
           */
          <Link className="card shopline" to="/shopping" state={{ from: location.pathname }}>
            <span className="shopline__icon" aria-hidden>🛒</span>
            <span className="shopline__main">
              <span className="shopline__title">要去买什么</span>
              <span className="shopline__meta">
                {list.isPending && '正在算…'}
                {list.isError && '暂时打不开，点进去重试'}
                {data && total === 0 && '这几天还没定菜单'}
                {data && total > 0 && `${data.from.slice(5)} 起 ${data.days} 天 · 共 ${total} 样`}
              </span>
            </span>
            {/* 有没写配料表的菜时给个记号：那是"别漏买"的提醒，但只用一个点，不铺开 */}
            {data && data.missing.length > 0 && (
              <span className="shopline__warn" title={`有 ${data.missing.length} 道菜没有配料表`}>!</span>
            )}
            <span className="shopline__arrow" aria-hidden>›</span>
          </Link>
        )}

        {data && data.scope === 'mine' && (
          <p className="fridge-scope">家里关了共享，采购清单只按你自己参与的餐算。</p>
        )}

        <FridgeStock enabled={Boolean(family.data)} />

        {/*
         * 能做点什么（F5-04 / F6-07）：排在冰箱之后，读法是"这里有什么 → 能做点什么"。
         * 它依赖 FridgeStock 那份数据（自己又取了一次，走的同一个 react-query 缓存键，
         * 不会多发一次请求），所以必须在同一个 `enabled` 条件下一起出现。
         */}
        <FridgeCookable enabled={Boolean(family.data)} />
      </div>
    </Page>
  )
}
