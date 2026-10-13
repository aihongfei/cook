import { describe, expect, it } from 'vitest'
import { pageTurn } from './page-turn'

/**
 * 换页方向（用户 2026-10-14：「前进后退没有那种左右翻页的效果」）。
 *
 * 这一组全是**纯函数**级别：方向是两个页面之间的关系，把它做成纯函数之后
 * 每一条路径都能直接断言，不用起路由、不用等动画（动画本身只能人眼验，
 * 但那只是"滑得对不对"，"该不该滑"在这里钉死）。
 */
describe('换页方向 pageTurn', () => {
  // 三档：forward（从右边推进来）/ back（从左边回来）/ fade（中性淡入）

  it('往一个没去过的地方走 = 往里进', () => {
    expect(pageTurn({ from: '/kitchen', to: '/recipes', fromState: null })).toBe('forward')
    expect(pageTurn({ from: '/recipes', to: '/recipes/abc', fromState: { from: '/recipes' } })).toBe('forward')
  })

  it('「← 返回」回到来处 = 往回退', () => {
    // 详情页是带着 state.from 进来的，它那个「← 返回菜谱」指向的正是来处
    expect(pageTurn({
      from: '/recipes/abc',
      to: '/recipes',
      fromState: { from: '/recipes' },
    })).toBe('back')
  })

  it('安卓返回键 = 往回退（哪怕上一页没带 from）', () => {
    /*
     * 这条路是必须单列的：被退回去的那一页的 state 是**它自己的**旧 state，
     * 里面常常没有 from（比如从底栏进的订单页）。光看 state 会判成 forward，
     * 于是"按返回键"和"往里进"播同一个方向——正是用户抱怨的那件事。
     */
    expect(pageTurn({
      from: '/order/history',
      to: '/order',
      fromState: null,
      navigationType: 'POP',
    })).toBe('back')
  })

  it('从二级页按返回键退回底栏那个 Tab，也是往回退（不是平级切换）', () => {
    expect(pageTurn({
      from: '/checkins',
      to: '/mine',
      fromState: null,
      navigationType: 'POP',
    })).toBe('back')
  })

  it('底栏五个岛之间互跳 = 不滑（既不是进也不是退）', () => {
    for (const [from, to] of [
      ['/kitchen', '/fridge'],
      ['/order', '/discover'],
      ['/mine', '/kitchen'],
    ]) {
      expect(pageTurn({ from, to, fromState: null })).toBe('fade')
    }
  })

  it('底栏 → 二级页仍然是往里进（不能被"目的地是 Tab"那条吃掉）', () => {
    expect(pageTurn({ from: '/fridge', to: '/fridge/cookable', fromState: null })).toBe('forward')
  })

  it('二级页 → 底栏也是"回家"，不滑（实测抓出来的：第一版这里滑了）', () => {
    /*
     * 第一版的判据是"**两边都是** Tab"，于是从打卡墙点底栏「厨房」被判成 forward、
     * 从右边滑进来——那看起来像"厨房在打卡墙的下一层"。
     * 到达顶层永远是"回家"，不是"往里进"。
     */
    for (const [from, to] of [
      ['/checkins', '/kitchen'],
      ['/recipes/abc', '/fridge'],
      ['/taste', '/mine'],
      ['/shopping', '/order'],
    ]) {
      expect(pageTurn({ from, to, fromState: null })).toBe('fade')
    }
  })

  it('同一个地址不动', () => {
    expect(pageTurn({ from: '/recipes', to: '/recipes', fromState: null })).toBe('fade')
  })

  it('来处带查询串时按路径比（列表页筛过之后进详情再返回认得出）', () => {
    expect(pageTurn({
      from: '/recipes/abc',
      to: '/recipes?category=汤',
      fromState: { from: '/recipes?category=汤' },
    })).toBe('back')
    // 用户进详情后改了筛选，返回链接指向新那一串：仍然认得出是"回列表"
    expect(pageTurn({
      from: '/recipes/abc',
      to: '/recipes?category=素',
      fromState: { from: '/recipes?category=汤' },
    })).toBe('back')
  })

  it('state.from 是脏数据时不认（不能拿它当方向依据）', () => {
    for (const dirty of [42, null, undefined, '', {}]) {
      expect(pageTurn({ from: '/recipes/abc', to: '/recipes', fromState: { from: dirty } }))
        .toBe('forward')
    }
  })

  it('POP 优先于一切：连"回 Tab"也算往回退', () => {
    // 从厨房进菜谱小书再按返回键：to 是 Tab，但这一趟是往回退
    expect(pageTurn({
      from: '/recipes',
      to: '/kitchen',
      fromState: { from: '/kitchen' },
      navigationType: 'POP',
    })).toBe('back')
  })
})
