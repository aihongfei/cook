// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import CategoryRow from './CategoryRow'

// 厨房页的品类入口（F1-01）。这里要盯住的是**图文对应**：
// 素材是手绘实物（cat-3 是鱼、cat-4 是叶子），曾经按数组下标取图，
// 而接口按「主食 / 汤 / 素菜 / 荤菜」返回，于是**素菜配了鱼、荤菜配了叶子**（用户看到"文字和图片反了"）。
// 所以断言按"名字 → 图"来写，并特意把顺序打乱一次，防止有人改回按下标取图。

afterEach(() => { cleanup() })

function iconOf(name: string): string | null {
  const button = screen.getByRole('button', { name })
  return button.querySelector('img')?.getAttribute('src') ?? null
}

it('素菜配叶子的图、荤菜配鱼的图（不是反的）', () => {
  render(<CategoryRow categories={['主食', '汤', '素菜', '荤菜']} onSelect={() => {}} />)

  expect(iconOf('素菜')).toBe('/img/cat-4.png')
  expect(iconOf('荤菜')).toBe('/img/cat-3.png')
  // 明确断言没有反：素菜不该是鱼，荤菜不该是叶子
  expect(iconOf('素菜')).not.toBe('/img/cat-3.png')
  expect(iconOf('荤菜')).not.toBe('/img/cat-4.png')
})

it('汤用汤碗的图', () => {
  render(<CategoryRow categories={['汤']} onSelect={() => {}} />)
  expect(iconOf('汤')).toBe('/img/cat-5.png')
})

it('接口换个顺序回来，图文仍然对得上（按名字取图，不是按下标）', () => {
  render(<CategoryRow categories={['荤菜', '素菜', '汤', '主食']} onSelect={() => {}} />)

  expect(iconOf('荤菜')).toBe('/img/cat-3.png')
  expect(iconOf('素菜')).toBe('/img/cat-4.png')
  expect(iconOf('汤')).toBe('/img/cat-5.png')
})

it('没见过的品类用中性图兜底，不会随便配一张食材图', () => {
  render(<CategoryRow categories={['预制菜']} onSelect={() => {}} />)
  expect(iconOf('预制菜')).toBe('/img/cat-2.png')
})

it('点某个品类就把名字回调出去', () => {
  const onSelect = vi.fn()
  render(<CategoryRow categories={['素菜']} onSelect={onSelect} />)
  fireEvent.click(screen.getByRole('button', { name: '素菜' }))
  expect(onSelect).toHaveBeenCalledWith('素菜')
})
