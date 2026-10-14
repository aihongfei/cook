import { expect, it } from 'vitest'
import { badgesOfMeal, firstPrepNotice, firstUnreadMealKey, unreadByMeal } from './unread-badges'

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
    { kind: 'plan', mealKey: '2026-10-13-DINNER', unread: false, tag: '选好了' },
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
    { kind: 'plan', mealKey: '2026-10-13-DINNER', unread: true, tag: '选好了' },
    { kind: 'done', mealKey: '2026-10-13-DINNER', unread: true, tag: '做好了' },
  ])
  expect(badgesOfMeal(map, '2026-10-13-DINNER')).toEqual(['做好了', '选好了'])
})

it('只有一条时也照顺序表走：菜单单独出现就只标菜单', () => {
  const map = unreadByMeal([{ kind: 'plan', mealKey: '2026-10-13-DINNER', unread: true, tag: '选好了' }])
  expect(badgesOfMeal(map, '2026-10-13-DINNER')).toEqual(['选好了'])
})

/*
 * 再点一次「订单」Tab 时滚去哪（用户 2026-10-14：「重复点击订单tab时自动滚到通知的
 * 那个卡片位置」）。列表本身就是"新的在前"，所以取第一条能落到卡上的就够。
 */
it('再点 Tab 滚到最新的那条"有卡的"未读上；已读的、没有卡的都不算', () => {
  const items = [
    { kind: 'prep', mealKey: null, unread: true, tag: '备菜' }, // 最新的这条没有卡
    { kind: 'done', mealKey: '2026-10-13-DINNER', unread: false, tag: '做好了' }, // 已读
    { kind: 'plan', mealKey: '2026-10-12-LUNCH', unread: true, tag: '选好了' }, // ← 该滚到这里
    { kind: 'done', mealKey: '2026-10-11-DINNER', unread: true, tag: '做好了' },
  ]
  expect(firstUnreadMealKey(items)).toBe('2026-10-12-LUNCH')
  // 一条能落到卡上的都没有时，别乱滚（返回 null 就是"什么都不做"）
  expect(firstUnreadMealKey([{ kind: 'expiry', mealKey: null, unread: true, tag: '快过期' }])).toBe(null)
})

/*
 * 「该备菜」那条在列表顶上单说一句。它**没有卡可标**（那一餐还空着），而红点恰恰亮在
 * 订单这一支——用户 2026-10-14 那次未读恰好只有这一条，看到的就是"红点亮着、列表里
 * 一处标记都没有"，于是以为角标没做出来。所以列表顶上必须能看见它。
 */
it('「该备菜」未读时给一句顶上的说明（标题/去处都用后端那条，前端不另拼）', () => {
  const notice = firstPrepNotice([
    { kind: 'prep', unread: true, title: '接下来 3 餐还没安排', body: '最近的是今天晚餐', to: '/prep' },
  ])
  expect(notice).toEqual({ title: '接下来 3 餐还没安排', body: '最近的是今天晚餐', to: '/prep' })
})

it('备菜那条已读就不再说；快过期/菜单/做好了都不走这条路（快过期归冰箱）', () => {
  expect(
    firstPrepNotice([{ kind: 'prep', unread: false, title: 'x', body: null, to: '/prep' }]),
  ).toBe(null)
  for (const kind of ['expiry', 'plan', 'done']) {
    expect(
      firstPrepNotice([{ kind, unread: true, title: 'x', body: null, to: '/x' }]),
      `${kind} 不该走"顶上一句"这条路`,
    ).toBe(null)
  }
})
