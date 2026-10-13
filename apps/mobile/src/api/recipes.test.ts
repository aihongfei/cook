// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from './client'
import {
  caloriesLabel,
  createRecipe,
  deleteRecipe,
  fetchRecipe,
  fetchRecipes,
  recipeListUrl,
  updateRecipe,
} from './recipes'

beforeEach(() => { vi.restoreAllMocks() })

describe('recipe API contract', () => {
  it('passes all independent filters and paging as axios parameters, with cancellation', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { items: [], total: 0, page: 3, pageSize: 12 } })
    const signal = new AbortController().signal
    await fetchRecipes({ q: '  番茄 & 鸡蛋  ', category: '素菜', cuisine: '家常' }, 3, signal)
    expect(get).toHaveBeenCalledWith('/recipes', {
      params: { q: '番茄 & 鸡蛋', category: '素菜', cuisine: '家常', page: 3, pageSize: 12 }, signal,
    })
  })

  /*
   * `mine`（F1-12「我的菜谱」）。两件事都要对：
   * ① 要筛的时候必须发出去（不发就成了"整个库"，"我的"里会出现别人家的菜）；
   * ② 不筛的时候**干脆不带这个参数**——后端只认 '1'/'true'（见 parseRecipeQuery 的 flag()），
   *    发个 false/0 过去会被当成"多了一个不认识的参数"直接 400。
   */
  it('mine 只在要筛的时候发出（且是 1）；不筛时连参数都不带', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { items: [], total: 0, page: 1, pageSize: 12 } })
    await fetchRecipes({ mine: true })
    const sent = get.mock.calls[0][1]!.params as Record<string, unknown>
    expect(sent.mine).toBe(1)
    await fetchRecipes({ mine: false })
    const unsent = get.mock.calls[1][1]!.params as Record<string, unknown>
    expect('mine' in unsent).toBe(true)
    expect(unsent.mine).toBeUndefined()
  })

  it('「我的菜谱」的列表 URL 也带 mine=1（分享/回退到这一步时筛选不会丢）', () => {
    expect(recipeListUrl({ mine: true })).toBe('/recipes?mine=1')
    expect(recipeListUrl({})).toBe('/recipes')
  })

  it('encodes entry search terms and recipe identifiers without mixing path segments', async () => {
    const url = new URL(recipeListUrl({ q: 'a&b + 汤', category: '素菜' }), 'http://localhost')
    expect(url.searchParams.get('q')).toBe('a&b + 汤')
    expect(url.searchParams.get('category')).toBe('素菜')
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ data: {} })
    await fetchRecipe('汤/一&二')
    expect(get).toHaveBeenCalledWith('/recipes/%E6%B1%A4%2F%E4%B8%80%26%E4%BA%8C', { signal: undefined })
  })

  it('写操作打在菜谱集合与单条上，id 一律走编码（免得 id 里的斜杠被当成路径分段）', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: {} })
    const patch = vi.spyOn(apiClient, 'patch').mockResolvedValue({ data: {} })
    const remove = vi.spyOn(apiClient, 'delete').mockResolvedValue({ data: { id: 'a/b', name: '汤' } })
    const draft = {
      name: '番茄炒蛋', category: '素菜', cuisine: '家常', tags: [], ingredients: [],
      steps: ['打蛋'], notes: [], calories: null, aliases: [],
    }
    await createRecipe(draft)
    expect(post).toHaveBeenCalledWith('/recipes', draft)
    await updateRecipe('a/b', { name: '新名字' })
    expect(patch).toHaveBeenCalledWith('/recipes/a%2Fb', { name: '新名字' })
    expect(await deleteRecipe('a/b')).toEqual({ id: 'a/b', name: '汤' })
    expect(remove).toHaveBeenCalledWith('/recipes/a%2Fb')
  })

  it('distinguishes missing calories, real zero, and estimated nutrition', () => {
    expect(caloriesLabel({ calories: null, caloriesEstimated: true })).toBe('热量暂无')
    expect(caloriesLabel({ calories: 0, caloriesEstimated: false })).toBe('0 千卡')
    expect(caloriesLabel({ calories: 180, caloriesEstimated: true })).toBe('约 180 千卡（估算）')
  })
})
