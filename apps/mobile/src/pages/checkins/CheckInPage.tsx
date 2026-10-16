import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { useCheckInWall, type CheckIn } from '@/api/checkins'
import { useFamily } from '@/api/family'
import CheckInPhoto from '@/components/ui/CheckInPhoto'
import EmptyState from '@/components/ui/EmptyState'
import SwipePager from '@/components/ui/SwipePager'
import BackLink from '@/components/ui/BackLink'
import { useBackLink } from '@/lib/back-target'
import Page from '@/components/ui/Page'
import PageHeader from '@/components/ui/PageHeader'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import CheckInUploadSheet from './components/CheckInUploadSheet'
import CheckInDetailSheet from './components/CheckInDetailSheet'
import './checkins.scss'

/**
 * 家庭打卡墙（M9 / F9-03；口径见 D-023）。
 * 家里人的照片都在这里，最新在前；共享开关关闭时吃货只看得到自己上传的。
 */
/**
 * 能从哪些页面进到打卡墙，以及返回时的文案。
 * 返回目标跟着**来源**走，不写死：从「我的」进来要回「我的」，从点单卡那张成品照进来要回点菜单。
 * （原先写死"返回厨房"，从"我的"进来的人点返回会莫名其妙落到厨房——用户报的正是这个。）
 */
export default function CheckInPage() {
  const location = useLocation()
  const family = useFamily()
  const [scope, setScope] = useState<'family' | 'mine'>('family')
  const [uploading, setUploading] = useState(false)
  /** 点开看详情的那一张（用户 2026-10-14：「打卡墙卡片不能点击查看详情」） */
  const [opened, setOpened] = useState<CheckIn | null>(null)
  // 每次打开都 +1，用来给抽屉换 key：抽屉不在 effect 里清状态，靠重挂载拿回干净的一份
  const [uploadSeq, setUploadSeq] = useState(0)
  const openUpload = () => {
    setUploadSeq((value) => value + 1)
    setUploading(true)
  }

  // 没带来源（直接输地址/刷新丢了 state）时按主要入口「我的」兜底
  const back = useBackLink(location.state, '/mine')

  return (
    /*
     * 「页头不动、只滚主体」+ 两个视角之间**整屏左右滑**（D-091，用户 2026-10-16：
     * 「还有我的打卡页面，也要 tab 能互相滑动，整屏的」「滑动时只滑动主题内容」）。
     * 返回键 / 标题 / 段控 / 「打卡拍照」都交给 `fixed`——拍照是这一页最重要的动作，
     * 滚到相册中段也该够得着（原来它随页面滚走了，想打卡得先滚回顶上）。
     */
    <Page
      fixed={(
        <div className="pscreen">
          <BackLink to={back.to} label={back.label} />
          <PageHeader title="家庭打卡墙" subtitle="做好一道菜就拍一张，攒着看特别有成就感" art="checkins" />

          {/*
            段控现在**也能滑**（左右滑 = 换视角），所以它得落在 `SwipePager` 外面：
            那套手势是认"划在谁身上"的，放在里面会与"翻页"抢同一次划动。
            它与 tab 条是同一类东西——两个选项之间切换——用户对 tab 的预期就是能滑。
          */}
          <div className="segmented">
            <button
              type="button"
              className={['segmented__item', scope === 'family' && 'is-active'].filter(Boolean).join(' ')}
              onClick={() => setScope('family')}
            >
              全家
            </button>
            <button
              type="button"
              className={['segmented__item', scope === 'mine' && 'is-active'].filter(Boolean).join(' ')}
              onClick={() => setScope('mine')}
            >
              只看我的
            </button>
          </div>

          <button type="button" className="recipe-button checkin-add" disabled={!family.data} onClick={openUpload}>
            打卡拍照
          </button>
        </div>
      )}
    >
      {/*
        两个视角各是一页（`SwipePager` + `fill`：整屏、跟手、内容不足一屏时不留可滑的空白）。
        每一页**各自取数**（`useCheckInWall` 按 scope 缓存），所以跟手拖到一半时邻页已经画得出来。
      */}
      <SwipePager
        keys={['family', 'mine']}
        activeKey={scope}
        onChange={(key) => setScope(key as 'family' | 'mine')}
        fill
        renderPanel={(key) => <CheckInScope key={key} scope={key as 'family' | 'mine'} onOpen={setOpened} />}
      />

      {family.data && (
        <CheckInUploadSheet
          key={`upload-${uploadSeq}`}
          visible={uploading}
          onClose={() => setUploading(false)}
          onUploaded={() => setScope('family')}
        />
      )}

      {/* 详情抽屉。**只在点开时才挂载**（与上传抽屉同一做法）：它自己会取一次照片字节，
          墙上一屏十几张不该因为"可能会点"就各自多取一份 */}
      {opened && <CheckInDetailSheet entry={opened} onClose={() => setOpened(null)} />}
    </Page>
  )
}

/**
 * 一个视角（全家 / 只看我的）的内容。
 *
 * 抽出来是因为它现在有**两个**画它的地方：跟手拖动时两页要同时在屏上
 * （用户 2026-10-15 的同一要求），所以这一支必须能被独立渲染两次。
 *
 * 「没加入家庭」那条引导留在**这一层**（而不是页头固定区）：它是"这一页现在看不了"的说明，
 * 属于内容；固定区里摆一段"你还没加入家庭"会把页头撑得很高，而它只在没家庭时出现。
 */
function CheckInScope({
  scope,
  onOpen,
}: {
  scope: 'family' | 'mine'
  onOpen: (entry: CheckIn) => void
}) {
  const family = useFamily()
  const location = useLocation()
  const wall = useCheckInWall(scope, { enabled: Boolean(family.data) })
  const entries = wall.data?.items ?? []
  const scopeNote = wall.data?.scope === 'mine' && scope === 'family'
    ? '家里关了共享，现在只看得到你自己传的。'
    : null

  return (
    <>
      {!family.isPending && !family.data && (
        <div className="order-empty">
          <p>打卡墙是全家人一起攒的相册。</p>
          <Link className="recipe-button" to="/family" state={{ from: location.pathname }}>
            去创建或加入家庭
          </Link>
        </div>
      )}

      {scopeNote && <p className="checkin-note">{scopeNote}</p>}

      {family.data && wall.isPending && <div className="checkin-status"><RecipeStatus title="正在翻相册…" loading /></div>}
      {family.data && wall.isError && (
        <div className="checkin-status">
          <RecipeStatus title="相册暂时打不开" onRetry={() => { void wall.refetch() }}>
            {apiErrorMessage(wall.error)}
          </RecipeStatus>
        </div>
      )}

      {family.data && wall.data && entries.length === 0 && (
        <EmptyState
          title={scope === 'mine' ? '你还没打过卡' : '还没有人打卡'}
          desc={scope === 'mine' ? '做了一道好菜就拍一张。' : '第一张照片会出现在这里。'}
        />
      )}

      <div className="checkin-grid">
        {entries.map((entry) => (
          /*
           * 卡片是**按钮**（用户 2026-10-14：「打卡墙卡片不能点击查看详情」）。
           *
           * 原来是纯 `<figure>`：一屏照片谁做的、几点拍的、当时说了什么，
           * 全都塞不进那张小卡里，而**没处点**就等于这些信息不存在。
           * 用 `<button>` 而不是给 `<figure>` 挂 onClick：键盘/读屏能聚焦、能回车打开
           * （给 `figure` 加 tabIndex 只是把"可点"画上去，语义仍然是一张插图）。
           */
          <button
            type="button"
            className="checkin-card"
            key={entry.id}
            onClick={() => onOpen(entry)}
            aria-label={`看${entry.isMe ? '我' : entry.nickname} ${entry.checkDate} 的打卡详情`}
          >
            <CheckInPhoto photoUrl={entry.photoUrl} alt={entry.note ?? `${entry.nickname}的打卡`} />
            <figcaption>
              <span className="checkin-card__who">
                {entry.avatar} {entry.isMe ? '我' : entry.nickname}
                {entry.mealLabel && <b className="checkin-card__meal">{entry.mealLabel}的成品</b>}
              </span>
              {entry.note && <span className="checkin-card__note">{entry.note}</span>}
              <span className="checkin-card__date">{entry.checkDate}</span>
            </figcaption>
          </button>
        ))}
      </div>

      {wall.data?.hasMore && (
        <p className="checkin-note">只显示最近 {entries.length} 张。更早的相册翻页功能在后面的里程碑里做。</p>
      )}
    </>
  )
}
