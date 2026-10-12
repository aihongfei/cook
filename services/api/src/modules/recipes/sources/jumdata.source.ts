import { createHash } from 'node:crypto'
import { RecipeSourceAdapter, SourceRecipe, sourceLicense, stripStepNumbering } from './recipe-source'

/**
 * 聚美智数 · 菜谱大全（cookbook_query）
 *
 * ⚠️ 状态：**待验证**——本文件按官方文档实现，但尚未用真实 appId/appSecret 跑通。
 * 首次联调需要：services/api/.env 里配置 JUMDATA_APP_ID / JUMDATA_APP_SECRET，
 * 且账号已开通该接口并有余额（否则返回 code 601 / 603）。
 *
 * 接口（官方文档 2026-10-12 读取）：
 * - 分类查询 POST https://api.jumdata.com/cookbook/type （productCode=cookbook_query）
 * - 菜谱查询 POST https://api.jumdata.com/cookbook/list
 *   参数：appId / timestamp(毫秒) / sign / productCode=cookbook_query /
 *        **type（必填！菜谱分类，用一级或二级分类）** / id? / name? / pageNo? / pageSize?
 *   签名：sign = sha256(appId + appSecret + timestamp)
 *   返回：data.items[] = { type, typeV1/V2/V3, name, desc, tip, id, smallImag, largeImg,
 *                        steps[{orderNum,content}], yl[{ylName,ylUnit}] }
 *   计费：code=200 即计费（charge=true）
 *
 * 待验证的三个风险点（文档示例已暴露）：
 * 1. 示例里 smallImag / largeImg 都是空字符串 —— 若真实数据也无图，则不满足"图片必须有"的要求；
 * 2. steps 只有文字、没有配图（与 uapis 源不同）；
 * 3. 示例里 yl 的 ylName / ylUnit 字段含义疑似写反（ylUnit 里放的是原料名）—— 需实测确认取哪个字段。
 */

const LIST_URL = 'https://api.jumdata.com/cookbook/list'
/** 分类查询路径按同产品命名推断，待首次联调确认 */
const TYPE_URL = 'https://api.jumdata.com/cookbook/type'
const PRODUCT_CODE = 'cookbook_query'
const TIMEOUT_MS = 20_000
/** 串行节流，避免触发源站限流 */
const THROTTLE_MS = 250

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

interface JumdataItem {
  type?: string
  typeV1?: string
  typeV2?: string
  typeV3?: string
  name?: string
  desc?: string
  tip?: string
  id?: string
  smallImag?: string
  largeImg?: string
  steps?: { orderNum?: number; content?: string }[]
  yl?: { ylName?: string; ylUnit?: string }[]
}

interface JumdataResponse<T> {
  code: number
  msg: string
  charge?: boolean
  data?: T
}

function credentials(): { appId: string; appSecret: string } {
  const appId = process.env.JUMDATA_APP_ID
  const appSecret = process.env.JUMDATA_APP_SECRET
  if (!appId || !appSecret) {
    throw new Error('缺少 JUMDATA_APP_ID / JUMDATA_APP_SECRET —— 请写进 services/api/.env（不要提交、不要贴进对话）')
  }
  return { appId, appSecret }
}

function signParams(): Record<string, string> {
  const { appId, appSecret } = credentials()
  const timestamp = Date.now().toString()
  return {
    appId,
    timestamp,
    sign: createHash('sha256').update(`${appId}${appSecret}${timestamp}`).digest('hex'),
    productCode: PRODUCT_CODE,
  }
}

async function post<T>(url: string, form: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`聚美智数 ${url} 返回 HTTP ${response.status}`)
  const body = (await response.json()) as JumdataResponse<T>
  if (body.code !== 200 && body.code !== 201) {
    throw new Error(`聚美智数返回 code=${body.code}：${body.msg}`)
  }
  return (body.data ?? null) as T
}

/** 分类树：{ 一级分类: { 二级分类: [三级...] } } */
type TypeTree = Record<string, Record<string, string[]>>

/** yl 的字段含义在文档示例里疑似写反：这里按"哪个字段含数字哪个就是用量的"来兜底判定 */
function toIngredient(row: { ylName?: string; ylUnit?: string }): { name: string; amount: string } | null {
  const values = [row.ylName, row.ylUnit].map(value => (value ?? '').trim()).filter(Boolean)
  if (!values.length) return null
  if (values.length === 1) return { name: values[0], amount: '' }
  const [first, second] = values
  const firstLooksQuantity = /[0-9０-９]/.test(first)
  const secondLooksQuantity = /[0-9０-９]/.test(second)
  if (secondLooksQuantity && !firstLooksQuantity) return { name: first, amount: second }
  if (firstLooksQuantity && !secondLooksQuantity) return { name: second, amount: first }
  return { name: first, amount: second }
}

function toSourceRecipe(item: JumdataItem): SourceRecipe | null {
  const name = item.name?.trim()
  if (!item.id || !name) return null
  const tags = [item.typeV1, item.typeV2, item.typeV3].filter((tag): tag is string => Boolean(tag && tag.trim()))
  return {
    id: item.id,
    name,
    image: item.largeImg?.trim() || item.smallImag?.trim() || null,
    description: item.tip?.trim() || item.desc?.trim() || null,
    sourceTags: [...new Set(tags)],
    ingredients: (item.yl ?? [])
      .map(toIngredient)
      .filter((row): row is { name: string; amount: string } => row !== null),
    steps: (item.steps ?? [])
      .map(step => stripStepNumbering(step.content ?? ''))
      .filter(text => text.length > 0),
    stepImages: [],
    url: LIST_URL,
  }
}

export const jumdataSource: RecipeSourceAdapter = {
  key: 'jumdata',
  name: '聚美智数 · 菜谱大全',
  license: sourceLicense('paid'),
  apiKeyEnv: 'JUMDATA_APP_ID',
  async search(keyword: string, limit: number): Promise<SourceRecipe[]> {
    // type 是必填参数，所以先取分类树，再逐个一级分类按 name 检索，够数即停。
    const tree = await post<{ items?: TypeTree }>(TYPE_URL, signParams())
    const topCategories = Object.keys(tree?.items ?? {})
    if (!topCategories.length) throw new Error('聚美智数分类查询未返回分类，无法按名检索（检查接口是否已开通）')

    const collected: SourceRecipe[] = []
    for (const [index, category] of topCategories.entries()) {
      if (collected.length >= limit) break
      if (index > 0) await sleep(THROTTLE_MS)
      try {
        const page = await post<{ items?: JumdataItem[] }>(LIST_URL, {
          ...signParams(),
          type: category,
          name: keyword,
          pageNo: '1',
          pageSize: String(Math.min(limit, 20)),
        })
        for (const item of page?.items ?? []) {
          const recipe = toSourceRecipe(item)
          if (recipe) collected.push(recipe)
        }
      } catch (error) {
        console.warn(`  [jumdata] 分类「${category}」检索失败：${(error as Error).message}`)
      }
    }
    return collected.slice(0, limit)
  },
}
