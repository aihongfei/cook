import { useEffect, useState } from 'react'
import { attachmentPhotoUrl } from '@/api/ai'
import { useAuth } from '@/stores/auth'
import ImageViewer from '@/components/ui/ImageViewer'

/**
 * 对话里的一张图（F16-05）。
 *
 * **为什么要取 blob 再转 URL，而不是直接把接口地址放进 `<img src>`**：取图接口要过登录令牌，
 * 而 `<img>` 带不上 Authorization 头（与打卡照片同一个问题）。所以用 fetch 带上令牌取回字节，
 * 转成 blob URL 给 `<img>`。
 *
 * 两件必须做的清理：
 * - **组件卸载时要 revoke**：blob URL 不 revoke 会让这些图片字节一直占着内存
 *   （一次对话滚过去几十张，越积越多）；
 * - **取不到时画一句人话而不是破图**：附件有留存上限，很旧的对话里那张图可能已经被清理
 *   （见后端 `ATTACH_KEEP_PER_FAMILY`）——那时候显示"这张图已清理"比一个碎图标清楚得多。
 *
 * 点一下就是看大图（用户 2026-10-13：「图片需要能点击全屏看」）。用的是应用内的全屏层，
 * 不是 `target="_blank"`——打包之后没有"新标签页"，那个写法点了等于没反应。
 * 大图用的**就是我们手里这同一个 blob URL**：不重复请求一次，也不会出现"缩略图有、点开却没有"。
 */
export default function AiTurnAttachment({ id, index }: { id: string; index: number }) {
  const token = useAuth((state) => state.token)
  const [url, setUrl] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'gone'>('loading')
  const [viewing, setViewing] = useState(false)

  useEffect(() => {
    let revoked = false
    let objectUrl: string | null = null
    const controller = new AbortController()

    void (async () => {
      try {
        const response = await fetch(attachmentPhotoUrl(id), {
          headers: token ? { authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
        })
        if (!response.ok) {
          setState('gone')
          return
        }
        const blob = await response.blob()
        objectUrl = URL.createObjectURL(blob)
        if (revoked) {
          // 请求还没回来组件就卸载了：这个 URL 没人会用，当场放掉
          URL.revokeObjectURL(objectUrl)
          return
        }
        setUrl(objectUrl)
        setState('ready')
      } catch {
        // 取消（切会话、卸载）也会走到这里，那不算"图没了"
        if (!revoked) setState('gone')
      }
    })()

    return () => {
      revoked = true
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [id, token])

  if (state === 'gone') {
    return <span className="ai__photo-missing">这张图已清理</span>
  }
  if (state === 'loading' || !url) {
    return <span className="ai__photo ai__photo--loading" aria-label="正在取图" />
  }
  return (
    <>
      <button
        type="button"
        className="ai__photo"
        aria-label={`看第 ${index + 1} 张图的大图`}
        onClick={() => setViewing(true)}
      >
        <img src={url} alt={`对话里的第 ${index + 1} 张图`} />
      </button>
      {viewing && <ImageViewer src={url} alt={`对话里的第 ${index + 1} 张图`} onClose={() => setViewing(false)} />}
    </>
  )
}
