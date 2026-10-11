// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from './client'
import { caloriesLabel, fetchRecipe, fetchRecipes, recipeListUrl } from './recipes'

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

  it('encodes entry search terms and recipe identifiers without mixing path segments', async () => {
    const url = new URL(recipeListUrl({ q: 'a&b + 汤', category: '素菜' }), 'http://localhost')
    expect(url.searchParams.get('q')).toBe('a&b + 汤')
    expect(url.searchParams.get('category')).toBe('素菜')
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ data: {} })
    await fetchRecipe('汤/一&二')
    expect(get).toHaveBeenCalledWith('/recipes/%E6%B1%A4%2F%E4%B8%80%26%E4%BA%8C', { signal: undefined })
  })

  it('distinguishes missing calories, real zero, and estimated nutrition', () => {
    expect(caloriesLabel({ calories: null, caloriesEstimated: true })).toBe('热量暂无')
    expect(caloriesLabel({ calories: 0, caloriesEstimated: false })).toBe('0 千卡')
    expect(caloriesLabel({ calories: 180, caloriesEstimated: true })).toBe('约 180 千卡（估算）')
  })
})
