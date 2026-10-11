import { BadRequestException } from '@nestjs/common'
import { RecipeQuery } from './recipe.types'

export function parseRecipeQuery(query: Record<string, unknown>): RecipeQuery {
  const allowed = new Set(['q', 'category', 'cuisine', 'page', 'pageSize'])
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
  return { q: text('q'), category: text('category'), cuisine: text('cuisine'), page: integer('page', 1, 10000), pageSize: integer('pageSize', 12, 100) }
}
