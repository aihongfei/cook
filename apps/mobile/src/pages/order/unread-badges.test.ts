import { expect, it } from 'vitest'
import { badgesOfMeal, unreadByMeal } from './unread-badges'

/*
 * 卡片未读标记的纯判据（用户 2026-10-14：「订单有红点，但是里面的卡片看不出来哪个是提醒的」）。
 *
 * 组件那一侧由 `order.test.tsx` 验（标在哪张卡上、卡有没有换样子）；这里钉的是
 * **哪一类不该出现**——那是组件测不出来的：它要么编一个指不到东西的标记，
 * 要么把已读的也标上，两种都"看起来正常"。
 *
 * 键是 `餐次:类别`，所以同一餐的 plan 与 done **互不覆盖**；快过期 / 该备菜
 * 本就是 `mealKey: null`——它们不是"漏了"，是**没有那张卡**
 * （快过期指向冰箱；备菜说的正是"这一餐还空着"）。
 */
it('只看未读：已读过的不进标记（点过了还挂着，用户会以为没生效）', () => {
  const map = unreadByMeal([
    { kind: 'plan', mealKey: '2026-10-13-DINNER', unread: false, tag: '菜单' },
    { kind: 'done', mealKey: '2026-10-14-LUNCH', unread: true, tag: '做好了' },
  ])
  expect(badgesOfMeal(map, '2026-10-13-DINNER')).toEqual([])
  expect(badgesOfMeal(map, '2026-10-14-LUNCH')).toEqual(['做好了'])
})

it('只收带餐次的：快过期 / 该备菜标不到卡上（它们本来就没有那张卡）', () => {
  const map = unreadByMeal([
    { kind: 'expiry', mealKey: null, unread: true, tag: '快过期' },
    { kind: 'prep', mealKey: null, unread: true, tag: '备菜' },
  ])
  expect(map.size).toBe(0)
  // 不给任何一餐编标记，也不误挂到别的餐上
  expect(badgesOfMeal(map, '2026-10-13-DINNER')).toEqual([])
})

it('同一餐两条各占各的：顺序固定「做好了」在前（不随列表时刻变）', () => {
  const map = unreadByMeal([
    { kind: 'plan', mealKey: '2026-10-13-DINNER', unread: true, tag: '菜单' },
    { kind: 'done', mealKey: '2026-10-13-DINNER', unread: true, tag: '做好了' },
  ])
  expect(badgesOfMeal(map, '2026-10-13-DINNER')).toEqual(['做好了', '菜单'])
})

it('只有一条时也照顺序表走：菜单单独出现就只标菜单', () => {
  const map = unreadByMeal([{ kind: 'plan', mealKey: '2026-10-13-DINNER', unread: true, tag: '菜单' }])
  expect(badgesOfMeal(map, '2026-10-13-DINNER')).toEqual(['菜单'])
})
