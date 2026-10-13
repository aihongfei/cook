import { useEffect, useState } from 'react'
import { fetchPhotoBlobUrl, type CheckIn } from '@/api/checkins'
import BottomSheet from '@/components/ui/BottomSheet'
import ImageViewer from '@/components/ui/ImageViewer'

/**
 * 打卡详情（用户 2026-10-14：「打卡墙卡片不能点击查看详情」）。
 *
 * 卡片上能放的信息很少：照片、谁、哪一餐、一行被 CSS 截断的备注、日期。
 * 一件真事（"这道菜是谁做的、什么时候拍的、他当时说了什么"）在墙上挤不下，
 * 所以点开看——**这一屏只读**，不写库也不摆假按钮
 * （点赞/评论是另一个功能，这一版不做）。
 *
 * 三件事刻意的：
 * - **复用 `BottomSheet` 与 `ImageViewer`**（项目里已有、十几处用过）：
 *   不新造弹层，拖拽关闭与安卓返回键的语义自动继承；
 * - **照片点一下能全屏**：墙上那张是上传时缩过的（最长边 1600px），全屏看还是同一张
 *   ——**不假装有更大的图**，但要看仔细能全屏；
 * - **图挂了也得能看字**：照片加载失败时不能整屏白掉，
 *   "谁什么时候打了卡"与照片能不能解码是两件事。
 */
export default function CheckInDetailSheet({ entry, onClose }: { entry: CheckIn; onClose: () => void }) {
  const [viewing, setViewing] = useState(false)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  /*
   * 详情**自己取一份照片**，不复用墙上那张卡的 blob URL。
   *
   * 墙上那张由 `CheckInPhoto` 自己持有、卸载时 revoke（那是对的：几十张图谁也不该替谁管
   * 生命周期）。把它借过来给全屏用，就会出现"抽屉还开着、卡片先卸载了 → URL 被 revoke
   * → 全屏变白"这种只在快速返回时才复现的错。
   *
   * 也**不走 `useQuery`**：它的缓存会把 blob URL 留到缓存过期，而那个 URL 的生命周期
   * 是"到本组件卸载为止"——缓存里存一个随时会被释放的地址，第二次点开就是坏图。
   * 一次 `useEffect` 拿一次、卸载释放，最简单也最不容易错（与 `CheckInPhoto` 同一手法）。
   */
  useEffect(() => {
    let released = false
    let created: string | null = null
    setBlobUrl(null)
    setFailed(false)
    fetchPhotoBlobUrl(entry.photoUrl)
      .then((url) => {
        created = url
        if (released) {
          URL.revokeObjectURL(url)
          return
        }
        setBlobUrl(url)
      })
      .catch(() => {
        if (!released) setFailed(true)
      })
    return () => {
      released = true
      if (created) URL.revokeObjectURL(created)
    }
  }, [entry.photoUrl])

  const takenAt = formatTakenAt(entry.createdAt)
  const meta = [entry.checkDate, entry.mealLabel ? `${entry.mealLabel}的成品` : null, takenAt].filter(Boolean)

  return (
    <BottomSheet visible title="这一张" onClose={onClose}>
      <div className="checkin-detail">
        {blobUrl ? (
          <button type="button" className="checkin-detail__photo" onClick={() => setViewing(true)} aria-label="看大图">
            <img src={blobUrl} alt={entry.note ?? `${entry.nickname}的打卡`} />
          </button>
        ) : (
          <div className="checkin-detail__photo checkin-detail__photo--empty" aria-busy={!failed}>
            {failed ? '照片打不开了' : '照片加载中…'}
          </div>
        )}

        <p className="checkin-detail__who">
          {entry.avatar} {entry.isMe ? '我' : entry.nickname}
        </p>
        <p className="checkin-detail__meta">{meta.join(' · ')}</p>

        {/* 备注**完整显示**：卡片上那两行是 CSS 截断的（line-clamp），
            详情里再截一次就等于这条备注永远读不全 */}
        {entry.note
          ? <p className="checkin-detail__note">{entry.note}</p>
          : <p className="checkin-detail__note checkin-detail__note--empty">这一张没写备注。</p>}
      </div>

      {viewing && blobUrl && (
        <ImageViewer src={blobUrl} alt={entry.note ?? `${entry.nickname}的打卡`} onClose={() => setViewing(false)} />
      )}
    </BottomSheet>
  )
}

/**
 * 拍下来的时刻（`createdAt` 是上传时间）。
 *
 * 卡片上只有日期（`checkDate`），"几点做的"只有详情里看得到——而它正是打卡记录的东西
 * （一天做两道菜时，中午那道与晚上那道不是一回事）。用**本地时区**显示：
 * 用户在哪儿看的就按哪儿的钟点念，不做时区换算。
 */
function formatTakenAt(iso: string): string | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
