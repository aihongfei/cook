// @vitest-environment jsdom
import { matchRoutes } from 'react-router-dom'
import { expect, it } from 'vitest'
import { router } from './index'
import MyRecipesPage from '@/pages/recipes/MyRecipesPage'
import RecipeFormPage from '@/pages/recipes/RecipeFormPage'
import RecipeDetailPage from '@/pages/recipes/RecipeDetailPage'

/**
 * 路由表（F1-12 新增三条）。这一条**必须真的跑一遍匹配**：
 * `/recipes/mine` 与 `/recipes/:id` 长得一模一样，`matchRoutes` 若把前者判给 `:id`，
 * 「我的菜谱」就会以 id='mine' 去请求详情——症状是"这一页打不开"，
 * 而读代码时完全看不出来（顺序、具体度、层级三条规则都可能影响）。
 *
 * 用 `matchRoutes` 对着真实的 `router.routes` 匹配，而不是自己再写一份路由表：
 * 自己写一份就只测了那份副本，产品路由漏加一条这里照样绿。
 */

/**
 * 匹配到的叶子路由**渲染的是哪个组件**。
 * 比组件本身而不是比 JSX 字面量：`<X />` 每次都是新对象，`toBe` 永远不成立
 * （第一版就是这么红的）；而组件身份相等已经足以说明"匹配到了哪一页"。
 */
function pageFor(path: string) {
  const matches = matchRoutes(router.routes, path)
  const leaf = matches?.[matches.length - 1]
  return { type: (leaf?.route.element as { type?: unknown } | undefined)?.type, params: leaf?.params }
}

it('/recipes/mine 匹配「我的菜谱」，不被 /recipes/:id 抢走', () => {
  expect(pageFor('/recipes/mine').type).toBe(MyRecipesPage)
})

it('/recipes/new 匹配表单页（新建），也不被 /recipes/:id 抢走', () => {
  expect(pageFor('/recipes/new').type).toBe(RecipeFormPage)
})

it('/recipes/:id/edit 匹配表单页（编辑），且带 id 参数', () => {
  const matched = pageFor('/recipes/own-1/edit')
  expect(matched.type).toBe(RecipeFormPage)
  expect(matched.params?.id).toBe('own-1')
})

it('/recipes/:id 仍是详情页（新增路由没把原来的入口挡住）', () => {
  expect(pageFor('/recipes/tomato').type).toBe(RecipeDetailPage)
})

it('三条新路由都在**需要登录**的外壳里（RequireAuth 之下）', () => {
  for (const path of ['/recipes/mine', '/recipes/new', '/recipes/own-1/edit']) {
    const matches = matchRoutes(router.routes, path) ?? []
    // 顶层那两条是 `/`（带 RequireAuth 的壳）与 `*`（兜底跳厨房），子路由挂在 `/` 之下
    expect(matches.length, `${path} 没挂在需要登录的外壳下`).toBeGreaterThan(1)
    expect(matches[0].route.path).toBe('/')
  }
})
