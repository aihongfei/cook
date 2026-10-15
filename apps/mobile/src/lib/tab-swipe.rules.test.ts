// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  SWIPE_EDGE_GUARD,
  SWIPE_FLICK_VX,
  SWIPE_LOCK_DX,
  SWIPE_SETTLE_RATIO,
  dragOffset,
  releaseVelocity,
  settleIndex,
  swipeIntent,
  type SwipeStartFacts,
} from './tab-swipe.rules'

/**
 * 「跟手翻页」的判定（用户 2026-10-15：「要跟随手指拖动，滑到中间时，两个页是都能看见的」）。
 *
 * 这里钉的是**时机**，不是动画：什么时候算"在翻页"、什么时候算"在滚页面"、
 * 什么时候根本不该接、抬手时该翻还是该弹回去。接线那一层在 `SwipePager.test.tsx`。
 */

const WIDTH = 400

/** 起手事实的默认值：屏幕中间、三页、不挡 */
function facts(overrides: Partial<SwipeStartFacts> = {}): SwipeStartFacts {
  return { startX: 200, viewportWidth: 360, total: 3, blocked: false, ...overrides }
}

describe('swipeIntent：这一下算不算在翻页', () => {
  it('横向走够 8px 才算接过来；在那之前不动手（手指先抖一下很正常）', () => {
    expect(swipeIntent({ ...facts(), dx: 5, dy: 1 })).toBe('pending')
    expect(swipeIntent({ ...facts(), dx: 12, dy: 2 })).toBe('horizontal')
    expect(SWIPE_LOCK_DX).toBe(8)
  })

  it('斜着划但纵向明显更多 → 那是想滚页面，不接（列表里几乎人人都是斜着划的）', () => {
    expect(swipeIntent({ ...facts(), dx: 20, dy: 30 })).toBe('vertical')
    // 横向要压过纵向 1.6 倍才算"在翻页"
    expect(swipeIntent({ ...facts(), dx: 40, dy: 30 })).toBe('pending')
    expect(swipeIntent({ ...facts(), dx: 60, dy: 30 })).toBe('horizontal')
  })

  it('起点落在自己要横滚的那一行（`data-no-swipe`）→ 一律不接', () => {
    expect(swipeIntent({ ...facts({ blocked: true }), dx: -200, dy: 3 })).toBe('blocked')
  })

  it('屏幕左右边缘那条带留给系统返回手势（左右 24px 都不接）', () => {
    expect(swipeIntent({ ...facts({ startX: SWIPE_EDGE_GUARD - 1 }), dx: -200, dy: 0 })).toBe('blocked')
    expect(swipeIntent({ ...facts({ startX: 360 - SWIPE_EDGE_GUARD + 1 }), dx: -200, dy: 0 })).toBe('blocked')
    // 贴着带边上一像素就可以
    expect(swipeIntent({ ...facts({ startX: SWIPE_EDGE_GUARD }), dx: -200, dy: 0 })).toBe('horizontal')
  })

  it('只有一页时什么都不接（没什么可翻的）', () => {
    expect(swipeIntent({ ...facts({ total: 1 }), dx: -200, dy: 0 })).toBe('blocked')
  })
})

describe('dragOffset：跟手时画多少', () => {
  it('中间那几页 1:1 跟手（手指移多少页面移多少）', () => {
    expect(dragOffset({ dx: -120, width: WIDTH, index: 1, total: 3 })).toBe(-120)
    expect(dragOffset({ dx: 90, width: WIDTH, index: 1, total: 3 })).toBe(90)
  })

  it('到头那一侧打折（第一页往右、最后一页往左）：拉得动但拉不远——这就是"到头了"', () => {
    const forward = dragOffset({ dx: 100, width: WIDTH, index: 0, total: 3 })
    expect(forward).toBeGreaterThan(0)
    expect(forward).toBeLessThan(100)

    const backward = dragOffset({ dx: -100, width: WIDTH, index: 2, total: 3 })
    expect(backward).toBeLessThan(0)
    expect(backward).toBeGreaterThan(-100)
  })

  it('拖过一整页之后也打折：邻页已经整个进来了，再拉只会露白', () => {
    expect(dragOffset({ dx: -WIDTH, width: WIDTH, index: 1, total: 3 })).toBe(-WIDTH)
    const beyond = dragOffset({ dx: -WIDTH * 2, width: WIDTH, index: 1, total: 3 })
    expect(beyond).toBeLessThan(-WIDTH)
    expect(beyond).toBeGreaterThan(-WIDTH * 2)
  })

  it('量不到宽度时按 1:1 走（宁可跟手，也不要因为量不到就僵住）', () => {
    expect(dragOffset({ dx: -120, width: 0, index: 1, total: 3 })).toBe(-120)
  })
})

describe('settleIndex：抬手之后翻不翻', () => {
  const base = { width: WIDTH, index: 1, total: 3, vx: 0 }

  it('走够这一页的 22% 就翻（不必甩）', () => {
    expect(settleIndex({ ...base, dx: -(WIDTH * SWIPE_SETTLE_RATIO + 1) })).toBe(2)
    expect(settleIndex({ ...base, dx: WIDTH * SWIPE_SETTLE_RATIO + 1 })).toBe(0)
  })

  it('没走够就走回去（回弹给 null）', () => {
    expect(settleIndex({ ...base, dx: -30 })).toBeNull()
  })

  it('甩得够快也翻——但方向要与位移一致，且真的动过', () => {
    expect(settleIndex({ ...base, dx: -30, vx: -SWIPE_FLICK_VX - 0.1 })).toBe(2)
    // 位移往前、速度往后（最后那一下是往回带）：不替他做决定
    expect(settleIndex({ ...base, dx: -30, vx: 0.9 })).toBeNull()
    // 够快但几乎没动（原地抖）也是走回去
    expect(settleIndex({ ...base, dx: -10, vx: -2 })).toBeNull()
  })

  it('到头那一侧不循环：第一页往右、最后一页往左，都只是弹回去', () => {
    expect(settleIndex({ ...base, index: 0, dx: 200 })).toBeNull()
    expect(settleIndex({ ...base, index: 2, dx: -200 })).toBeNull()
    expect(settleIndex({ ...base, index: 2, dx: -200, vx: -2 })).toBeNull()
  })

  it('量不到宽度时只有"甩"能翻（距离那一半没法判）', () => {
    expect(settleIndex({ ...base, width: 0, dx: -300 })).toBeNull()
    expect(settleIndex({ ...base, width: 0, dx: -300, vx: -1 })).toBe(2)
  })
})

describe('releaseVelocity：抬手那一下有多快', () => {
  it('用最近这一小段而不是整段：起步慢、收尾猛地一甩，抬手速度要读出"快"', () => {
    const samples = [
      { x: 300, t: 0 },
      { x: 290, t: 60 },
      { x: 200, t: 100 },
      { x: 160, t: 140 },
    ]
    // 最近 40ms 往左走了 40px → -1 px/ms（往左是负，见文件头）
    expect(releaseVelocity(samples, 140)).toBeCloseTo(-1, 5)
  })

  it('手指停在半路（最后一个点已经过了一阵）→ 当没甩：抬手时歪一下不该替他翻页', () => {
    const samples = [
      { x: 300, t: 0 },
      { x: 160, t: 140 },
    ]
    expect(releaseVelocity(samples, 400)).toBe(0)
  })

  it('点太少或时间没走 → 0（不猜）', () => {
    expect(releaseVelocity([{ x: 300, t: 0 }], 10)).toBe(0)
    expect(releaseVelocity([{ x: 300, t: 10 }, { x: 200, t: 10 }], 10)).toBe(0)
  })
})
