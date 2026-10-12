import {
  RecipeSourceAdapter,
  SourceRecipe,
  parseIngredientList,
  parseSpacePair,
  sourceLicense,
  stripStepNumbering,
} from './recipe-source'

const BASE = 'https://uapis.cn/api/v1/food'
const TIMEOUT_MS = 20_000
/** 官方限流 4 QPS，串行请求间隔留足余量 */
const THROTTLE_MS = 300

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

interface SearchItem { id: string; title: string; cover?: string }
interface DetailStep { step?: number; text?: string; image?: string }
interface DetailPayload {
  id: string
  title: string
  cover?: string
  description?: string
  category?: string
  rating?: string
  ingredients?: string[]
  steps?: DetailStep[]
}

async function getJson<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `${BASE}${path}?${new URLSearchParams(params).toString()}`
  const response = await fetch(url, {
    headers: {
      // 该站对浏览器 UA 更友好；同时避免 Node 默认 UA 被风控
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`uapis ${path} 返回 HTTP ${response.status}`)
  return (await response.json()) as T
}

/**
 * uapis.cn 菜谱源（免密钥，访客积分即可调用）。
 *
 * 实测（2026-10-12）：
 * - 搜索 `GET /food/recipe?keyword=` → 每次最多 20 条，仅 id/title/cover
 * - 详情 `GET /food/recipe/detail?id=` → 成品图 + 配料（带用量）+ 步骤（每步带配图）
 * 因此**必须逐条取详情**才能拿到可用的配料与步骤；调用成本：搜索 1 积分/次、详情 3 积分/次。
 *
 * ⚠️ 该源数据实为豆果美食的转手内容，文档无来源/许可说明 —— 仅可用于开发期，
 * 不可作为上架版本的数据来源（见 DECISIONS D-019、RISKS R-05）。
 */
export const uapisSource: RecipeSourceAdapter = {
  key: 'uapis',
  name: 'UAPI · 菜谱搜索/详情',
  license: sourceLicense('free'),
  apiKeyEnv: null,
  async search(keyword: string, limit: number): Promise<SourceRecipe[]> {
    const found = await getJson<{ items?: SearchItem[] }>('/recipe', { keyword })
    const items = (found.items ?? []).slice(0, Math.max(0, limit))
    const recipes: SourceRecipe[] = []
    for (const [index, item] of items.entries()) {
      if (index > 0) await sleep(THROTTLE_MS)
      try {
        const detail = await getJson<DetailPayload>('/recipe/detail', { id: item.id })
        recipes.push({
          id: item.id,
          name: detail.title || item.title,
          image: detail.cover || item.cover || null,
          description: detail.description?.trim() || null,
          sourceTags: detail.category ? [detail.category] : [],
          ingredients: parseIngredientList(
            (detail.ingredients ?? []).join('\n'),
            /\n/,
            parseSpacePair,
          ),
          steps: (detail.steps ?? [])
            .map(step => stripStepNumbering(step.text ?? ''))
            .filter(text => text.length > 0),
          stepImages: (detail.steps ?? []).map(step => step.image ?? null),
          url: `${BASE}/recipe/detail?id=${item.id}`,
        })
      } catch (error) {
        console.warn(`  [uapis] 跳过 ${item.id}（${item.title}）：${(error as Error).message}`)
      }
    }
    return recipes
  },
}
