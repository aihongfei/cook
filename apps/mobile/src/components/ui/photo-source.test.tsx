// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import PhotoSourceInputs from './PhotoSource'
import { photoSourceIds } from './photo-source'

/**
 * 「拍照 / 从相册选」这对隐藏控件（F16-05）。
 *
 * 它只有两个契约，但两个都是**错了就静默失效**那种：
 * ① **相机与相册必须是两个控件**，且相机那个带 `capture="environment"`——
 *    只有一个 `accept="image/*"` 时进相机还是进相册由系统决定，有些安卓 WebView
 *    只进相册，相机永远不出现。而"带了 capture 就只剩相机"，所以两者不能合并；
 * ② **选完要清 `value`**：不清的话连着选同一张图不会触发 change（浏览器认为值没变），
 *    用户看到的是"点第二次没反应"。
 */

afterEach(cleanup)

it('两个控件：相机那个带 capture，相册那个不带（合并成一个就必然丢掉一种入口）', () => {
  render(<PhotoSourceInputs id="t" onPick={() => {}} />)

  const { cameraId, albumId } = photoSourceIds('t')
  const camera = document.getElementById(cameraId) as HTMLInputElement
  const album = document.getElementById(albumId) as HTMLInputElement

  expect(camera).toBeTruthy()
  expect(album).toBeTruthy()
  // 这里断的是**真的那个属性**：`capture` 是"直接开相机"的唯一开关
  expect(camera.getAttribute('capture')).toBe('environment')
  expect(album.getAttribute('capture')).toBeNull()
  expect(camera.accept).toBe('image/*')
  expect(album.accept).toBe('image/*')
})

it('选完把 value 清掉（否则连着选同一张图第二次不触发 change）', () => {
  const onPick = vi.fn()
  render(<PhotoSourceInputs id="t" onPick={onPick} />)
  const input = document.getElementById(photoSourceIds('t').albumId) as HTMLInputElement

  const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' })
  // jsdom 里 files 只能这样塞（它是只读的 FileList）
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  fireEvent.change(input)

  expect(onPick).toHaveBeenCalledWith(file)
  // 关键那一条：value 回到空，下一次 change 才算"有变化"
  expect(input.value).toBe('')
})

it('取消选择（没拿到文件）也如实回调 undefined，调用方不用自己判空', () => {
  const onPick = vi.fn()
  render(<PhotoSourceInputs id="t" onPick={onPick} />)
  const input = document.getElementById(photoSourceIds('t').cameraId) as HTMLInputElement

  Object.defineProperty(input, 'files', { value: [], configurable: true })
  fireEvent.change(input)

  expect(onPick).toHaveBeenCalledWith(undefined)
})

it('隐藏样式**不能是 display:none**（部分安卓 WebView 上那样点 label 不触发选择器）', () => {
  // 这条是踩过的坑（打卡、菜谱配图都栽过），所以在这里钉住：控件必须在布局里
  render(<PhotoSourceInputs id="t" onPick={() => {}} />)
  const input = document.getElementById(photoSourceIds('t').albumId) as HTMLInputElement

  expect(getComputedStyle(input).display).not.toBe('none')
  // 而且不能被"藏"成不可见的另一种方式骗过断言：它自己带我们的隐藏类
  expect(input.className).toContain('photo-source__input')
})

it('同一个页面上的两处入口 id 不撞（AI 助手与冰箱面板会同时挂在树上）', () => {
  render(
    <>
      <PhotoSourceInputs id="ai-attachment" onPick={() => {}} />
      <PhotoSourceInputs id="fridge-scan" onPick={() => {}} />
    </>,
  )

  const ids = [...document.querySelectorAll('.photo-source__input')].map((el) => el.id)
  expect(new Set(ids).size).toBe(ids.length)
  // label 靠 htmlFor 指过来，id 撞了就会点到别人的控件上（表现是"点了没反应"或选错入口）
  expect(ids).toContain('ai-attachment-camera')
  expect(ids).toContain('fridge-scan-album')
})

it('两个 label 指到各自那个控件（相机标签不会开到相册）', () => {
  // 这一条验的是"用户点哪颗、开哪个"这条链路：label 的 htmlFor 必须落在对的控件上
  render(
    <>
      <label htmlFor={photoSourceIds('x').cameraId}>拍一张</label>
      <label htmlFor={photoSourceIds('x').albumId}>从相册选</label>
      <PhotoSourceInputs id="x" onPick={() => {}} />
    </>,
  )

  expect(screen.getByText('拍一张').getAttribute('for')).toBe('x-camera')
  expect(screen.getByText('从相册选').getAttribute('for')).toBe('x-album')
})
