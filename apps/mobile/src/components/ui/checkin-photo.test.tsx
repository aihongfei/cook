// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import { apiErrorMessage } from '@/api/client'
import CheckInPhoto from './CheckInPhoto'
import Heatmap from './Heatmap'
import type { HeatmapGrid } from '@/api/checkins'

// 打卡照片的显示与热力图（M9 / F9-03）。两处最容易坏的地方：
// ① 照片不能直接 <img src>（接口要令牌），必须走 blob；
// ② blob URL 必须释放，否则墙上几十张照片会一直占内存。

function gridFixture(overrides: Partial<HeatmapGrid> = {}): HeatmapGrid {
  return {
    weeks: [
      [
        { date: '2026-10-05', count: 0, level: 0 },
        { date: '2026-10-06', count: 1, level: 1 },
        { date: '2026-10-07', count: 2, level: 2 },
        { date: '2026-10-08', count: 3, level: 3 },
        { date: '2026-10-09', count: 9, level: 4 },
        { date: '2026-10-10', count: 0, level: 0 },
        { date: '2026-10-11', count: 0, level: 0 },
      ],
      [
        { date: '2026-10-12', count: 1, level: 1 },
        { date: '2026-10-13', count: 0, level: 0 },
      ],
    ],
    from: '2026-10-05',
    to: '2026-10-13',
    totalDays: 4,
    totalCount: 15,
    streak: 1,
    ...overrides,
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  URL.createObjectURL = vi.fn(() => 'blob:mock-1')
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => { cleanup() })

it('照片按 blob 方式取回再显示（接口要令牌，不能直接放进 img src）', async () => {
  const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ data: new Blob(['x'], { type: 'image/png' }) } as never)
  render(<CheckInPhoto photoUrl="/checkins/photos/ck-1?e=1&s=abc" alt="妈妈的打卡" />)

  const image = await screen.findByRole('img', { name: '妈妈的打卡' })
  expect(image.getAttribute('src')).toBe('blob:mock-1')
  expect(get).toHaveBeenCalledWith('/checkins/photos/ck-1?e=1&s=abc', { responseType: 'blob' })
})

it('照片取回失败时给一句话，不留一个破图', async () => {
  vi.spyOn(apiClient, 'get').mockRejectedValue(new Error('404'))
  render(<CheckInPhoto photoUrl="/checkins/photos/gone?e=1&s=abc" />)
  expect(await screen.findByText('照片打不开了')).toBeTruthy()
})

it('组件卸载时释放 blob URL（否则每张照片都在内存里留一份）', async () => {
  vi.spyOn(apiClient, 'get').mockResolvedValue({ data: new Blob(['x']) } as never)
  const view = render(<CheckInPhoto photoUrl="/checkins/photos/ck-2?e=1&s=abc" />)
  await screen.findByRole('img')
  view.unmount()
  await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1'))
})

it('放大图：按等级给格子上的类，等级 0 与 4 都区分得开', () => {
  render(<Heatmap grid={gridFixture()} />)
  // 每个等级都要有对应的类（前端只上色，阈值由后端给）
  for (const level of [0, 1, 2, 3, 4]) {
    expect(document.querySelectorAll(`.heatmap__cell--l${level}`).length).toBeGreaterThan(0)
  }
  // 有打卡的那天在 title 里说清数量
  expect(document.querySelector('[title="2026-10-09：9 张"]')).toBeTruthy()
  expect(document.querySelector('[title="2026-10-13：没打卡"]')).toBeTruthy()
})

it('放大图：说明行给出"多少天有打卡 / 共几张"', () => {
  render(<Heatmap grid={gridFixture()} />)
  expect(screen.getByText('4 天有打卡 · 共 15 张')).toBeTruthy()
})

it('放大图：一张都没有时显示引导文案而不是空网格', () => {
  render(<Heatmap grid={gridFixture({ totalCount: 0, totalDays: 0 })} emptyHint="还没有打卡照片：做了一道好菜就拍一张。" />)
  expect(screen.getByText('还没有打卡照片：做了一道好菜就拍一张。')).toBeTruthy()
})

it('放大图：可访问名里带上区间与总数（读屏用户也能知道这是什么图）', () => {
  render(<Heatmap grid={gridFixture()} />)
  expect(screen.getByRole('img', { name: /2026-10-05 至 2026-10-13，共 4 天有打卡、15 张照片/ })).toBeTruthy()
})

it('apiErrorMessage 对 401（照片链接失效）给出可读提示', () => {
  const error = { isAxiosError: true, response: { status: 401, data: { message: '照片链接已过期，刷新页面重新加载' } } }
  expect(apiErrorMessage(error)).toBe('照片链接已过期，刷新页面重新加载')
})
