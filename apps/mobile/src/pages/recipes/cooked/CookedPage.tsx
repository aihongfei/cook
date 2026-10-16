import { useLocation } from 'react-router-dom'
import Page from '@/components/ui/Page'
import PageHeader from '@/components/ui/PageHeader'
import BackLink from '@/components/ui/BackLink'
import { useBackLink } from '@/lib/back-target'
import CookedList from './CookedList'
import '@/pages/shared.scss'
import './cooked.scss'

/**
 * 我做过（M9 / F9-01）——独立路由。
 *
 * F9-02 落地后（D-076），「做过的」成了「我的菜谱」的第一个 tab；
 * **这一页保留**（`/cooked` 仍然可用：旧链接、深链、从别处直接跳过来都不该断）。
 * 列表本体在 `CookedList` 里，两处共用同一份实现——各写一遍必然漂移。
 */
export default function CookedPage() {
  const location = useLocation()
  const back = useBackLink(location.state, '/mine')

  return (
    <Page>
      <div className="pscreen cooked-page">
        <BackLink to={back.to} label={back.label} />
        <PageHeader title="我做过" subtitle="我点的菜，做好了的都在这儿" art="mine" />
        <CookedList from={location.pathname} />
      </div>
    </Page>
  )
}
