import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { useCheckInWall, type CheckIn } from '@/api/checkins'
import { useFamily } from '@/api/family'
import CheckInPhoto from '@/components/ui/CheckInPhoto'
import EmptyState from '@/components/ui/EmptyState'
import { readBackLink } from '@/pages/back-link'
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
  const back = readBackLink(location.state, '/mine')

  const wall = useCheckInWall(scope, { enabled: Boolean(family.data) })

  const entries = wall.data?.items ?? []
  const scopeNote = wall.data?.scope === 'mine' && scope === 'family'
    ? '家里关了共享，现在只看得到你自己传的。'
    : null

  return (
    <Page>
      <div className="pscreen">
        <Link className="page-back" to={back.to}>← {back.label}</Link>
        <PageHeader title="家庭打卡墙" subtitle="做好一道菜就拍一张，攒着看特别有成就感" art="checkins" />

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
              onClick={() => setOpened(entry)}
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
      </div>

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
