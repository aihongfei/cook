import { Link, useLocation } from 'react-router-dom'
import { useFamily } from '@/api/family'
import { pickReason, useFamilyPicks, type FamilyPick } from '@/api/discover'
import RecipeImage from '@/pages/recipes/components/RecipeImage'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import '../../shared.scss'
import '../discover.scss'

/**
 * 家人最爱 / 家人常点（M5 / F5-02）。口径见 D-038。
 *
 * 这一块回答的是"我们家平时吃什么"——而这个问题只有**已经发生过的事**能回答：
 * 哪些菜被真正做出来过（点单推到"已做好"）、哪些菜被家里人收着。
 * 所以它不让人打分、不让人排序，就是把这两件事合起来排个序给人看。
 *
 * 四件事刻意的：
 * - **没信号就不给内容**：一道菜都没做过也没人收藏时，说清"做几顿、收几道就会出来"，
 *   而不是拿库里随机的菜凑成一份"榜单"（那正是 600 道菜谱列表已经做的事）；
 * - **每一行都带一句理由**（"做过 3 次 · 2 人收着"）：没有理由的排名等于命令，
 *   用户看不懂为什么它在这儿，也就不会信它；
 * - **点一行直接进详情**（能看做法、能点这道）——榜单是入口不是终点；
 * - **共享关着时说明原因**（`scope === 'mine'`）：这时算的只是自己的份，
 *   不说的话用户会以为"家里只做过这几道"（与本周菜单同一口径）。
 *
 * 零新请求口径：它自己发一个请求（`useFamilyPicks`），与「摇一道」并列在发现页，
 * 不并入任何既有接口——榜单要家庭关系与共享开关，而发现页其它块（AI 推荐）走的是另一套。
 */
function PickRow({ pick, scope, from, rank }: { pick: FamilyPick; scope: 'family' | 'mine'; from: string; rank: number }) {
  const reason = pickReason(pick, scope)
  return (
    <li className="picks__item">
      {/* 前三名给名次；第 4 名往后就是"列表"，再编号只会占地方 */}
      {rank <= 3 && <span className="picks__rank">{rank}</span>}
      <Link
        className="picks__link"
        to={`/recipes/${encodeURIComponent(pick.id)}`}
        state={{ from }}
        aria-label={`查看${pick.name}菜谱`}
      >
        <span className="picks__pic"><RecipeImage src={pick.image} name={pick.name} /></span>
        <span className="picks__body">
          <span className="picks__name">{pick.name}</span>
          <span className="picks__reason">{reason}</span>
        </span>
      </Link>
    </li>
  )
}

export default function FamilyPicks() {
  const family = useFamily()
  const location = useLocation()
  // 没家庭就别问：接口按家庭算，没家时回 404（`enabled` 拦在请求之前）
  const picks = useFamilyPicks({ enabled: Boolean(family.data) })

  // 没加入家庭：这块的意义是"我们家的口味"，一个人没有"家"可算（与本周菜单同一处理）
  if (!family.isPending && !family.data) {
    return (
      <section className="card picks">
        <div className="picks__head">
          <span className="picks__title">家人最爱</span>
        </div>
        <p className="picks__empty">
          一家人一起点过、做过几顿之后，这里会排出你们家的常点菜。
          <Link className="picks__link-text" to="/family" state={{ from: location.pathname }}>
            去创建或加入家庭 →
          </Link>
        </p>
      </section>
    )
  }

  const items = picks.data?.items ?? []
  const scope = picks.data?.scope ?? 'family'

  return (
    <section className="card picks">
      <div className="picks__head">
        <span className="picks__title">家人最爱</span>
        {/* 只给"做过"与"收着"两个来源，所以出路只有两条：去点菜（做过）与去收藏 */}
        <span className="picks__links">
          <Link className="picks__more" to="/favorites" state={{ from: location.pathname }}>
            我收藏的菜 →
          </Link>
          <Link className="picks__more" to="/recipes" state={{ from: location.pathname }}>
            去点菜 →
          </Link>
        </span>
      </div>

      {picks.isPending && (
        <div className="picks__status-line">
          <RecipeStatus title="正在数你们家做过哪些菜…" loading />
        </div>
      )}
      {picks.isError && (
        <div className="picks__status-line">
          <RecipeStatus title="家人最爱暂时打不开" onRetry={() => { void picks.refetch() }} />
        </div>
      )}
      {picks.data && scope === 'mine' && (
        <p className="picks__scope">家里关了共享，现在只算你自己做过和收着的菜。</p>
      )}

      {picks.data && items.length === 0 && (
        <p className="picks__empty">
          还没有信号：做过的菜和收藏的菜都会出现在这里。先点一道、做完它，或者翻菜谱时收几道。
        </p>
      )}

      {items.length > 0 && (
        <ul className="picks__list">
          {items.map((pick, index) => (
            <PickRow
              key={pick.id}
              pick={pick}
              scope={scope}
              rank={index + 1}
              from={`${location.pathname}${location.search}`}
            />
          ))}
        </ul>
      )}

      {/* 只说"还有更多"，不给"看全部"——没有"全部榜单"这个页面，编一个入口等于给死路 */}
      {picks.data && picks.data.total > items.length && (
        <p className="picks__more-line">
          还有 {picks.data.total - items.length} 道做过或收过的菜，做过的会慢慢往上排。
        </p>
      )}
    </section>
  )
}
