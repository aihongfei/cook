// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { backTargetOf, clearBackTargets, registerBackTarget, unregisterBackTarget } from './back-target'
import { HOME_TAB, isTabPath, resolveBack } from './back-policy'

/**
 * 返回该去哪（用户 2026-10-16 报的两条怪行为，D-105）。
 *
 * 这一段**只在真机上按返回键才跑到**，模拟器的自动化点不到它（没有那个事件），
 * 所以把它写成纯函数 + 一张登记表，在这里把每种落点钉死。
 *
 * 用户报的两条：
 * ①「连续点击菜单，然后返回都能一直返」——原来每次点 Tab 压一条历史，返回键一条条退；
 * ②「点击进入详情再点击其他菜单还能返回去详情」——点 Tab 是 push，把详情埋在了历史里。
 * 两条的根因都是**把浏览器历史当成了导航栈**，现在判据换成"这一页登记的上一层"。
 */

afterEach(clearBackTargets)

describe('resolveBack', () => {
  it('子页：退到它登记的那一层（与页面上那颗箭头同一个值）', () => {
    expect(resolveBack({ pathname: '/recipes/r1', target: '/recipes/mine' })).toEqual({
      type: 'go',
      to: '/recipes/mine',
    })
    expect(resolveBack({ pathname: '/prep', target: '/order' })).toEqual({ type: 'go', to: '/order' })
  })

  it('子页登记的目标带查询串时原样带上（`/recipes?category=汤` 要回到那个品类）', () => {
    expect(resolveBack({ pathname: '/recipes/r1', target: '/recipes?category=汤' })).toEqual({
      type: 'go',
      to: '/recipes?category=汤',
    })
  })

  it('Tab 根页：**回厨房**（另外四个岛都一样，不是退出）', () => {
    for (const tab of ['/order', '/discover', '/fridge', '/mine']) {
      expect(resolveBack({ pathname: tab })).toEqual({ type: 'go', to: HOME_TAB })
    }
  })

  it('首页（厨房）：退出 App', () => {
    expect(resolveBack({ pathname: HOME_TAB })).toEqual({ type: 'exit' })
  })

  it('没登记目标的子页：兜底回厨房（菜谱库归厨房那一族的落点）', () => {
    expect(resolveBack({ pathname: '/recipes' })).toEqual({ type: 'go', to: HOME_TAB })
  })

  it('登录那几页在外壳之外：注册/忘记密码回登录，登录页本身是退出', () => {
    expect(resolveBack({ pathname: '/register' })).toEqual({ type: 'go', to: '/login' })
    expect(resolveBack({ pathname: '/forgot' })).toEqual({ type: 'go', to: '/login' })
    expect(resolveBack({ pathname: '/reset-password' })).toEqual({ type: 'go', to: '/login' })
    expect(resolveBack({ pathname: '/login' })).toEqual({ type: 'exit' })
  })

  it('**登记的目标优先于一切**：Tab 根页自己登记过就按它走', () => {
    // 例如「我的」页把字号弹窗那种"页内"状态记录成返回目标时的将来用法
    expect(resolveBack({ pathname: '/fridge', target: '/shopping' })).toEqual({
      type: 'go',
      to: '/shopping',
    })
  })

  it('空的/缺失的登记值当作没登记（不把空串塞进 Link）', () => {
    expect(resolveBack({ pathname: '/fridge', target: null })).toEqual({ type: 'go', to: HOME_TAB })
    expect(resolveBack({ pathname: '/fridge', target: undefined })).toEqual({ type: 'go', to: HOME_TAB })
  })
})

describe('isTabPath', () => {
  it('五个岛认得出来，子页认不出来', () => {
    for (const tab of [HOME_TAB, '/order', '/discover', '/fridge', '/mine']) {
      expect(isTabPath(tab)).toBe(true)
    }
    expect(isTabPath('/recipes/r1')).toBe(false)
    expect(isTabPath('/order/2026-10-15-DINNER')).toBe(false)
    expect(isTabPath('/')).toBe(false)
  })
})

describe('登记表', () => {
  it('登记 / 读 / 注销', () => {
    registerBackTarget('/recipes/r1', '/recipes/mine')
    expect(backTargetOf('/recipes/r1')).toBe('/recipes/mine')
    expect(backTargetOf('/nope')).toBeNull()

    unregisterBackTarget('/recipes/r1', '/recipes/mine')
    expect(backTargetOf('/recipes/r1')).toBeNull()
  })

  it('注销只删自己那一份：同一路径被新的一页覆盖过，旧页卸载不该把它删掉', () => {
    registerBackTarget('/recipes/r1', '/recipes/mine')
    // 又从别处进了同一个 /recipes/r1（覆盖成新的来源）
    registerBackTarget('/recipes/r1', '/favorites')

    // 旧那一份此时才卸载：不许把新登记的值带走
    unregisterBackTarget('/recipes/r1', '/recipes/mine')
    expect(backTargetOf('/recipes/r1')).toBe('/favorites')
  })
})
