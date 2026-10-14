import { Link, useLocation } from 'react-router-dom'
import Page from '@/components/ui/Page'
import PageHeader from '@/components/ui/PageHeader'
import { readBackLink } from '@/pages/back-link'
import FavoritesList from '../components/FavoritesList'
import '../../shared.scss'
import './favorites.scss'

/**
 * 我收藏的菜（M1 / F1-09）——独立路由。
 *
 * F9-02 落地后（D-076），收藏的主入口收进了「我的菜谱」的第二个 tab；
 * **这一页保留**（`/favorites` 仍然可用：旧链接、深链、从别处直接跳过来都不该断）。
 * 列表本体在 `FavoritesList` 里，两处共用同一份实现——各写一遍必然漂移。
 */
export default function FavoritesPage() {
  const location = useLocation()
  const back = readBackLink(location.state, '/mine')

  return (
    <Page>
      <div className="pscreen favorites-page">
        <Link className="page-back" to={back.to}>← {back.label}</Link>
        <PageHeader title="我收藏的菜" subtitle="想做的时候，来这儿找" art="mine" />
        <FavoritesList from={location.pathname} />
      </div>
    </Page>
  )
}
