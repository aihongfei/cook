import { BadRequestException } from '@nestjs/common'
import { RecipeQuery } from './recipe.types'

export function parseRecipeQuery(query: Record<string, unknown>): RecipeQuery {
  /*
   * `mine=1`：只看自己家传的（F1-12 的「我的菜谱」入口用）。
   * 它是个**筛选开关而不是权限**——登录了才有"我的"，未登录时它匹配不到任何东西
   * （自建菜谱都挂在某个家庭上），所以不必额外报错。
   */
  const allowed = new Set(['q', 'category', 'cuisine', 'page', 'pageSize', 'mine'])
  for (const key of Object.keys(query)) if (!allowed.has(key)) throw new BadRequestException(`Unknown query parameter: ${key}`)
  function text(key: string): string | undefined {
    const value = query[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.length > 100) throw new BadRequestException(`${key} must be a string of at most 100 characters`)
    return value.trim() || undefined
  }
  function integer(key: string, fallback: number, max: number): number {
    const value = query[key]
    if (value === undefined) return fallback
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new BadRequestException(`${key} must be an integer from 1 to ${max}`)
    return Number(value)
  }
  function flag(key: string): boolean {
    const value = query[key]
    if (value === undefined) return false
    if (value !== '1' && value !== 'true') throw new BadRequestException(`${key} 只接受 1`)
    return true
  }
  return { q: text('q'), category: text('category'), cuisine: text('cuisine'), page: integer('page', 1, 10000), pageSize: integer('pageSize', 12, 100), mine: flag('mine') }
}
