import type { ChangeEvent } from 'react'
import { photoSourceIds } from './photo-source'

/**
 * 「拍照」与「从相册选」两个隐藏的原生 file 控件（这个组件只管这一半，另一半是调用方写的 label）。
 *
 * **为什么必须是两个控件**（用户 2026-10-13：「需要能拍照或者从相册选两种」）：
 * 只有一个 `accept="image/*"` 时，能拿到什么完全看系统菜单——iOS 上相机与相册塞在同一个
 * "照片"入口里，安卓各家 WebView 给的东西又不一样，有些机型干脆只进相册，相机永远不出现
 * （用户报的正是"只能选、不能拍"）。`capture="environment"` 才是"确定开相机"的标准做法，
 * 而它**必须挂在不带相册选择的那个控件上**（挂了 capture 就只剩相机）——所以拆成两个。
 *
 * id 的规矩在 `./photo-source`：调用方的 label 要 `htmlFor` 指过来，两边不能各写一遍字符串。
 *
 * ⚠️ 隐藏这两个控件**不能用 `display:none`**：部分安卓 WebView 上那样点 label 不触发选择器
 * （打卡、菜谱配图都踩过）。隐藏样式见 `ui.scss` 的 `.photo-source__input`。
 */
export default function PhotoSourceInputs({
  id,
  onPick,
}: {
  /** 唯一前缀：同一页可能有好几处（AI 助手、冰箱面板），id 不能撞 */
  id: string
  /** 选完就回调；取消选择时也会以 undefined 调一次（调用方按"没选"处理即可） */
  onPick: (file: File | undefined) => void
}) {
  const { cameraId, albumId } = photoSourceIds(id)

  const handle = (event: ChangeEvent<HTMLInputElement>) => {
    onPick(event.target.files?.[0])
    /*
     * 清掉 value：否则**连着选同一张图**不会触发 change（浏览器认为值没变，没变化就没事件）。
     * 用户看到的是"点第二次没反应"。
     */
    event.target.value = ''
  }

  return (
    <>
      <input
        id={cameraId}
        className="photo-source__input"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handle}
      />
      <input id={albumId} className="photo-source__input" type="file" accept="image/*" onChange={handle} />
    </>
  )
}
