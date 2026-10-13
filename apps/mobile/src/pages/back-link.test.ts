import { expect, it } from 'vitest'
import { readBackLink, readCarry } from './back-link'

// 子页面的「返回」目标（F0-05）。要盯住的事：
// ① **每个 Tab 都认得出来**（发现页「摇一道」那条 bug 就是这里漏了 /discover：
//    白名单只列了 /kitchen 与 /recipes，'/discover' 被静默丢掉、返回按钮指向菜谱小书）；
// ② 认不出来时退回兜底，而不是把未校验的字符串塞进链接；
// ③ 带查询串的来源（/recipes?q=鱼）要保留（丢了就等于把用户的搜索也丢了）。

it('底部每个 Tab 都能当返回目标，文案跟着 Tab 名走', () => {
  for (const [path, label] of [
    ['/kitchen', '← 返回厨房'],
    ['/order', '← 返回订单'],
    ['/discover', '← 返回发现'],
    ['/fridge', '← 返回冰箱'],
    ['/mine', '← 返回我的'],
  ] as const) {
    const back = readBackLink({ from: path }, '/recipes')
    expect(back.to).toBe(path)
    expect(`← ${back.label}`).toBe(label)
  }
})

it('菜谱小书（不在 Tab 里）也认得，带查询串的原样保留', () => {
  expect(readBackLink({ from: '/recipes' }, '/mine').to).toBe('/recipes')
  const searched = readBackLink({ from: '/recipes?q=鱼&category=汤羹' }, '/mine')
  expect(searched.to).toBe('/recipes?q=鱼&category=汤羹')
  expect(searched.label).toBe('返回菜谱小书')
})

it('「我的菜谱」也认得（卡片的来源就是它，不列在这儿会静默退到菜谱小书）', () => {
  const back = readBackLink({ from: '/recipes/mine' }, '/recipes')
  expect(back.to).toBe('/recipes/mine')
  expect(back.label).toBe('返回我的菜谱')
})

it('发现页来的返回发现（这条是回归钉：曾因白名单漏了 /discover 而退到菜谱小书）', () => {
  const back = readBackLink({ from: '/discover' }, '/recipes')
  expect(back.to).toBe('/discover')
  expect(back.label).toBe('返回发现')
})

it('认不出来就用兜底（路由 state 是外部输入，不能原样塞进链接）', () => {
  for (const bad of [
    undefined,
    null,
    {},
    { from: 123 },
    { from: '' },
    { from: '/nope' },
    { from: 'https://evil.example.com' },
    { from: '/../etc/passwd' },
    { from: '/recipes-evil' },
    { from: ['/kitchen'] },
  ]) {
    const back = readBackLink(bad, '/mine')
    expect(back.to).toBe('/mine')
    expect(back.label).toBe('返回我的')
  }
})

it('前缀伪装不能蒙过去（/recipes-evil 不是菜谱小书）', () => {
  // 前缀放行只对"已知入口 + 查询串"成立，不能拿它当任意路径的通行证
  expect(readBackLink({ from: '/recipes-evil' }, '/mine').to).toBe('/mine')
  expect(readBackLink({ from: '/kitchen/x' }, '/mine').to).toBe('/mine')
})

it('编辑页返回的目标是**这道菜的详情**，文案说得出是哪一层（不是干巴巴一个"返回"）', () => {
  const back = readBackLink(undefined, '/recipes/own-1')
  expect(back.to).toBe('/recipes/own-1')
  expect(back.label).toBe('返回这道菜谱')
})

it('中间页交还的来源能原样读回来（我的菜谱 → 详情 → 编辑 → 详情 → 我的菜谱 那条链）', () => {
  // 详情进编辑时把这一份塞进 carry，编辑页回详情时原样还回去
  const carried = { from: '/recipes/mine', plan: { date: '2026-10-14', meal: 'DINNER' } }
  expect(readCarry({ carry: carried })).toEqual(carried)
  // 详情页照着读，返回目标仍然是"我的菜谱"——链条没断（用户 2026-10-13 报的 bug 就断在这里）
  expect(readBackLink(readCarry({ carry: carried }), '/recipes').to).toBe('/recipes/mine')
})

it('carry 只收普通对象（路由 state 是外部输入，数组/字符串/缺失都当没有）', () => {
  for (const bad of [undefined, null, {}, { carry: null }, { carry: 'x' }, { carry: 5 }, { carry: ['/mine'] }]) {
    expect(readCarry(bad)).toBeUndefined()
  }
})
