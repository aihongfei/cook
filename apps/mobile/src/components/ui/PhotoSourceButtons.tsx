import PhotoSourceInputs from './PhotoSource'
import { photoSourceIds } from './photo-source'
import './ui.scss'

/**
 * 「拍一张 / 从相册选」两个入口，成对出现（打卡上传、菜谱配图用它）。
 *
 * **为什么必须成对**：一个只带 `accept="image/*"` 的控件进相机还是进相册**完全由系统决定**，
 * 有些机型干脆只进相册——用户看到的就是"点了『拍照』弹出的是选图"（他在 2026-10-16
 * 报的正是这个）。确定开相机只能靠 `capture="environment"`，而 `capture` 与"给相册选择"
 * 在同一个控件上互斥，所以拆成两个：**主入口带 capture、次入口不带**。
 * 冰箱识别与 AI 附件早就是这么做的（`PhotoSourceInputs` 的文件头写了完整来由），
 * 打卡与菜谱配图当时漏了，这一版补齐——四处入口从此同一个形态。
 *
 * 安卓上"点了带 capture 的控件仍进相册"还有第二个原因（清单里缺 `<queries>` 声明，
 * Capacitor 的 `resolveActivity()` 判不出相机就静默回退），那一条在
 * `android/app/src/main/AndroidManifest.xml` 里修，与这里无关——两处都对了才真的开相机。
 */
export default function PhotoSourceButtons({
  id,
  onPick,
  busy,
  cameraLabel = '拍一张',
  albumLabel = '从相册选',
}: {
  /** 唯一前缀：同一页可能有好几处入口，id 不能撞 */
  id: string
  onPick: (file: File | undefined) => void
  /** 处理中：两个入口都不接（等价于原来那颗被禁用的按钮） */
  busy?: boolean
  cameraLabel?: string
  albumLabel?: string
}) {
  const { cameraId, albumId } = photoSourceIds(id)
  /*
   * `label` 没有 disabled 属性，所以"忙时不接"只能拦它引发的那次点击。
   * `preventDefault()` 会阻止它去激活关联的控件——正是要的效果
   * （只置 `pointer-events: none` 挡住了手指，键盘回车与读屏激活仍会穿过去）。
   */
  const guard = (event: { preventDefault: () => void }) => {
    if (busy) event.preventDefault()
  }

  return (
    <>
      <div className="photo-buttons">
        <label
          className={['photo-buttons__item', 'photo-buttons__item--camera', busy && 'is-busy'].filter(Boolean).join(' ')}
          htmlFor={cameraId}
          onClick={guard}
        >
          {cameraLabel}
        </label>
        <label
          className={['photo-buttons__item', busy && 'is-busy'].filter(Boolean).join(' ')}
          htmlFor={albumId}
          onClick={guard}
        >
          {albumLabel}
        </label>
      </div>
      <PhotoSourceInputs id={id} onPick={onPick} />
    </>
  )
}
