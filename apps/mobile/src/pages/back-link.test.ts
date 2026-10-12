import { expect, it } from 'vitest'
import { readBackLink } from './back-link'

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
