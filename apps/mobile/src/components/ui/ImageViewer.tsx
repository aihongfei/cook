import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon } from '@/components/icons/TabIcons'
import { registerBackCloser } from '@/lib/android-back'

/**
 * 全屏看大图（F16-05；用户 2026-10-13：「图片需要能点击全屏看」）。
 *
 * **为什么必须自己做一个，而不是 `<a target="_blank">`**：打包成 App 之后没有"新标签页"
 * 这回事，点了要么什么都不发生、要么把用户丢出应用。手机上"点一下图看大图"是肌肉记忆，
 * 在应用内做掉才是对的。
 *
 * 三个做法上的选择：
 * - **画到 `document.body`（portal）**：抽屉里那个面板有 `transform`（弹簧动画），
 *   而带 transform 的祖先是 `position: fixed` 的包含块——不 portal 出去的话，
 *   这个"全屏"遮罩会被关在抽屉那一块里（看起来是半屏）。
 * - **点哪儿都关**：手机上退出全屏最自然的动作就是再点一下（微信、相册都是这样）。
 *   所以整层可点关闭，不要求用户去瞄准右上角那颗小按钮（那颗也留着，给"我知道有个×"的人）。
 * - **打开时锁住背后滚动**：否则手指滑一下，底下的对话/页面跟着滚，回来就不是原来的位置了。
 */
export default function ImageViewer({
  src,
  alt,
  onClose,
}: {
  /** 要显示的那张图。调用方负责它的生命周期（blob URL 不能在这里 revoke） */
  src: string
  alt?: string
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)

    // 记下原值而不是写死 ''：可能别处也锁着（比如另一个弹层）
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

  useEffect(() => {
    /* 系统返回键（安卓）也关掉大图（F14-01 / R-13 ①）：与 Esc 同一条语义。
       它是从抽屉里点开的、压在抽屉之上，所以登记在最上面，返回时先关它。 */
    return registerBackCloser(onClose)
  }, [onClose])

  return createPortal(
    <div className="photo-viewer" role="dialog" aria-modal="true" aria-label="看大图" onClick={onClose}>
      <button type="button" className="photo-viewer__close" aria-label="关掉大图" onClick={onClose}>
        {/*
          描边图形而不是文字 `×`：那个字形在 38px 的圆里实测**偏下 3.4px**
          （与附件那颗 ＋ 同一个病根，见 CloseIcon 的说明）
        */}
        <CloseIcon width={20} height={20} />
      </button>
      <img className="photo-viewer__img" src={src} alt={alt ?? '大图'} />
    </div>,
    document.body,
  )
}
