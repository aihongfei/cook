// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  SWIPE_EDGE_GUARD,
  SWIPE_MIN_DX,
  swipeTargetIndex,
  type SwipeFacts,
} from './tab-swipe.rules'

/**
 * 「左右滑动切换 tab」判定（用户 2026-10-15 要求）。
 *
 * 这一条盯的是**"什么时候不算滑动"**——列表页里几乎每一次划动都是斜的、每一次点按都带一点位移，
 * 判定宽一点就会"我明明在滚页面它却换了个 tab"（比不能滑更烦人）。
 */

/** 默认一份"该切下一页"的事实：在正中、横着划了 120px */
function facts(overrides: Partial<SwipeFacts> = {}): SwipeFacts {
  return {
    dx: -120, dy: 8, startX: 200, viewportWidth: 411, index: 0, total: 3, blocked: false,
    ...overrides,
  }
}

describe('滑动方向：往左划看下一个、往右划看上一个', () => {
  it('往左划（dx<0）→ 下一个', () => {
    expect(swipeTargetIndex(facts({ dx: -120, index: 0 }))).toBe(1)
    expect(swipeTargetIndex(facts({ dx: -120, index: 1 }))).toBe(2)
  })

  it('往右划（dx>0）→ 上一个', () => {
    expect(swipeTargetIndex(facts({ dx: 120, index: 2 }))).toBe(1)
    expect(swipeTargetIndex(facts({ dx: 120, index: 1 }))).toBe(0)
  })

  it('到头了不循环：在最后一个往左划、在第一个往右划都不动', () => {
    expect(swipeTargetIndex(facts({ dx: -120, index: 2, total: 3 }))).toBeNull()
    expect(swipeTargetIndex(facts({ dx: 120, index: 0, total: 3 }))).toBeNull()
  })
})

describe('什么时候**不算**滑动', () => {
  it('位移太小：那多半是"点了一下"（tap 也会带几像素抖动）', () => {
    expect(swipeTargetIndex(facts({ dx: SWIPE_MIN_DX - 1 }))).toBeNull()
    expect(swipeTargetIndex(facts({ dx: 0, dy: 0 }))).toBeNull()
  })

  it('纵向比横向明显：那是在滚列表，不能顺手把 tab 换了', () => {
    // 横 60 / 纵 200：斜着滚页面时最常见的一种
    expect(swipeTargetIndex(facts({ dx: 60, dy: 200 }))).toBeNull()
    /*
     * 门槛是"横向位移 ≥ 纵向的 1.6 倍"（120 / 1.6 = 75）：
     * 纵 74 时刚过线（切到上一个），纵 80 时不算横向意图。
     * 索引给 1 是为了让"切到上一个"有一个合法的落点（0 起，往右划＝上一个）。
     */
    expect(swipeTargetIndex(facts({ index: 1, dx: 120, dy: 74 }))).toBe(0)
    expect(swipeTargetIndex(facts({ index: 1, dx: 120, dy: 80 }))).toBeNull()
  })

  it('起点在屏幕边缘那一条带：留给系统的返回手势，不跟它抢', () => {
    expect(swipeTargetIndex(facts({ startX: SWIPE_EDGE_GUARD - 1 }))).toBeNull()
    expect(swipeTargetIndex(facts({ startX: 411 - SWIPE_EDGE_GUARD + 1, viewportWidth: 411 }))).toBeNull()
    expect(swipeTargetIndex(facts({ startX: SWIPE_EDGE_GUARD + 1 }))).toBe(1)
  })

  it('起点在"自己会横着滚"的东西上（筛选胶囊、tab 条）：那是在看后面的选项，不是换页', () => {
    expect(swipeTargetIndex(facts({ blocked: true }))).toBeNull()
  })

  it('只有一个 tab（或索引越界）时什么都不做', () => {
    expect(swipeTargetIndex(facts({ total: 1 }))).toBeNull()
    expect(swipeTargetIndex(facts({ index: 3, total: 3 }))).toBeNull()
    expect(swipeTargetIndex(facts({ index: -1 }))).toBeNull()
  })
})
