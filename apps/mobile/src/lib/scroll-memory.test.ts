import { expect, it } from 'vitest'
import { createScrollMemory, pageKeyOf } from './scroll-memory'

/*
 * 滚动位置记忆的纯判据（用户 2026-10-14：「我从下方点进去，再返回就滚动到最上面了，
 * 需要保留上次的位置，包括厨房那页也是，整个系统都是」）。
 *
 * 组件那一侧（真的摆回位置、DOM 没重挂）由 `KeepAlivePages.test.tsx` 与模拟器实测验；
 * 这里钉的是两件**看起来都正常**的事：`save` 收了一个不能当位置用的数（页面会跳到
 * 莫名其妙的地方），以及"哪一页"算得跟别处不一致（位置记到别人头上）。
 */

it('页面键 = 路径 + 查询串：品类/菜系这些存进地址的筛选各算一页', () => {
  expect(pageKeyOf({ pathname: '/recipes' })).toBe('/recipes')
  // 缺 search 也要能用（调用方给的可能没有 search 字段）
  expect(pageKeyOf({ pathname: '/recipes', search: '' })).toBe('/recipes')
  expect(pageKeyOf({ pathname: '/recipes', search: '?category=主食' })).toBe('/recipes?category=主食')
  // 同一路径、不同筛选 → 两个键，各记各的位置
  expect(pageKeyOf({ pathname: '/recipes', search: '?category=汤' })).not.toBe(
    pageKeyOf({ pathname: '/recipes', search: '?category=主食' }),
  )
})

it('没记过就是 0（新页面从头看），记过就是记过的那个数', () => {
  const memory = createScrollMemory()
  expect(memory.read('/kitchen')).toBe(0)
  memory.save('/kitchen', 300)
  expect(memory.read('/kitchen')).toBe(300)
  // 别页不受影响
  expect(memory.read('/order')).toBe(0)
})

it('不能当位置用的数一律不收：有限、非负', () => {
  const memory = createScrollMemory()
  memory.save('/kitchen', 120)
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
    memory.save('/kitchen', bad)
    // 上一次记的好值必须还在——记进去的话页面会跳到莫名的地方，
    // 而"退回顶部"至少是能理解的行为（见 scroll-memory.ts 顶部注释）
    expect(memory.read('/kitchen')).toBe(120)
  }
  // 0 是合法位置（确实滚到了顶）
  memory.save('/kitchen', 0)
  expect(memory.read('/kitchen')).toBe(0)
})

it('0 是合法位置（真的滚回了顶），不是一个"没记过"的记号', () => {
  const memory = createScrollMemory()
  memory.save('/kitchen', 300)
  memory.save('/kitchen', 0)
  expect(memory.read('/kitchen')).toBe(0)
  // 没记过的页读回来也是 0——两者在这里不可区分，也不影响使用
  // （摆回 0 与"不摆"看起来一样；见 scroll-memory.ts 顶部注释）
  expect(memory.read('/order')).toBe(0)
})

it('两张表互不串：每个 TabLayout 实例一张（退出登录随实例消失）', () => {
  const first = createScrollMemory()
  first.save('/kitchen', 300)
  const second = createScrollMemory()
  expect(second.read('/kitchen')).toBe(0)
  expect(first.read('/kitchen')).toBe(300)
})
