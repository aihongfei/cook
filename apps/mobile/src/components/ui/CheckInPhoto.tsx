import { useEffect, useState } from 'react'
import { fetchPhotoBlobUrl } from '@/api/checkins'

/**
 * 打卡照片（M9 / F9-03）。
 *
 * 不能直接 `<img src={photoUrl}>`：接口要过签名 + 登录令牌两道门（见 api/checkins.ts 的说明），
 * 而 `<img>` 带不上 Authorization 头。所以先取回字节再显示。
 * blob URL 用完必须 revoke，否则每张照片都会在内存里留一份（墙上有几十张时很可观）。
 */
interface Loaded {
  /** 这份结果属于哪张照片：换照片时旧结果自然作废，不必在 effect 里同步清状态 */
  photoUrl: string
  url?: string
  failed?: boolean
}

export default function CheckInPhoto({ photoUrl, alt, className }: { photoUrl: string; alt?: string; className?: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ photoUrl })

  useEffect(() => {
    let released = false
    let created: string | null = null

    fetchPhotoBlobUrl(photoUrl)
      .then((url) => {
        created = url
        // 组件已经卸载/换了照片：立刻释放，不再 setState（否则是卸载后更新状态）
        if (released) {
          URL.revokeObjectURL(url)
          return
        }
        setLoaded({ photoUrl, url })
      })
      .catch(() => {
        if (!released) setLoaded({ photoUrl, failed: true })
      })

    return () => {
      released = true
      if (created) URL.revokeObjectURL(created)
    }
  }, [photoUrl])

  const current = loaded.photoUrl === photoUrl ? loaded : { photoUrl }
  if (current.failed) return <div className={['checkin-photo', 'checkin-photo--failed', className].filter(Boolean).join(' ')}>照片打不开了</div>
  if (!current.url) return <div className={['checkin-photo', 'checkin-photo--loading', className].filter(Boolean).join(' ')} aria-busy="true" />
  return <img className={['checkin-photo', className].filter(Boolean).join(' ')} src={current.url} alt={alt ?? '打卡照片'} />
}
