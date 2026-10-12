import {
  RecipeSourceAdapter,
  SourceCategory,
  SourceRecipe,
  sourceLicense,
  stripStepNumbering,
} from './recipe-source'

/**
 * 极速数据 · 菜谱大全（jisuapi）
 *
 * 实测确认（2026-10-12，用真实 key 调通）：
 * - `GET /recipe/class`：`result` 是**数组** —— `[{ classid, name, parentid, list[{classid,name,parentid}] }]`，
 *   实测 14 个顶级分类、子类合计 900+（菜品 88 个、菜系 106 个……）。
 * - `GET /recipe/byclass`：参数 `classid`(必填，**只认叶子分类**，传顶级 id 返回 205 没有信息) /
 *   `start` / `num`。`result` 是**对象** `{ total, num, list: [...] }`，不是数组。
 *   `num` 实测**硬上限 20**（传 50、100 都只回 20 条），翻页只能靠 `start`。
 *   一次即返回含 `material`/`process` 的完整菜谱，无需逐条再调详情。
 * - `GET /recipe/search`：同样返回 `{ total, num, list }`。
 * - 菜谱字段：`id/classid/name/peoplenum/preparetime/cookingtime/content/pic/tag/material/process`
 *   - `pic` 实测 230×230 JPEG，形如 `http://api.jisuapi.com/recipe/upload/...`；该域名 **https 同样可用**，
 *     这里统一升到 https，否则打包成 APK 后 http 图会被 WebView 当混合内容拦掉。
 *   - `material[] = { mname, type, amount }`，`type` 是**数字**：1 主料、0 辅料（主料排在数组末尾）。
 *   - `process[] = { pcontent, pic }`，每步带配图。
 * - 鉴权：`appkey` 查询参数；成功 `status=0`；`103` = APPKEY 无请求此数据权限。
 *
 * 数据规模（实测 `total`）：家常菜 12710、热菜 2681、川菜 456 —— 足够撑起菜谱库；
 * 但每页上限 20 条，拉满家常菜需 ~636 次调用，建库要按调用次数配额分批跑。
 */

const BASE = 'https://api.jisuapi.com/recipe'
const TIMEOUT_MS = 25_000
/** byclass/search 的 num 实测硬上限，传更大也只返回 20 条 */
const PAGE_SIZE = 20
const THROTTLE_MS = 150

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

interface JisuMaterial { mname?: string; type?: number | string; amount?: string }
interface JisuProcess { pcontent?: string; pic?: string }
interface JisuRecipe {
  id?: string | number
  classid?: string | number
  name?: string
  peoplenum?: string
  preparetime?: string
  cookingtime?: string
  content?: string
  pic?: string
  tag?: string
  material?: JisuMaterial[]
  process?: JisuProcess[]
}
interface JisuPage { total?: number; num?: number; list?: JisuRecipe[] }
interface JisuClassNode { classid?: string | number; name?: string; list?: JisuClassNode[] }
interface JisuEnvelope<T> { status: number | string; msg?: string; result?: T }

function appKey(): string {
  const key = process.env.JISU_APP_KEY
  if (!key) throw new Error('缺少 JISU_APP_KEY —— 请写进 services/api/.env（不要提交、不要贴进对话）')
  return key
}

async function call<T>(path: string, params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams({ appkey: appKey(), ...params })
  const response = await fetch(`${BASE}/${path}?${query.toString()}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`极速数据 ${path} 返回 HTTP ${response.status}`)
  const body = (await response.json()) as JisuEnvelope<T>
  // 该平台成功码为 0；103 表示密钥有效但未开通该接口
  if (String(body.status) !== '0') {
    throw new Error(`极速数据 ${path} 返回 status=${body.status}：${body.msg ?? '未知错误'}`)
  }
  return body.result as T
}

/** 该源成品图与步骤图都是 http 外链，统一升到 https，避免 APK 内被混合内容策略拦截 */
function secureImage(url: string | undefined): string | null {
  const trimmed = (url ?? '').trim()
  if (!trimmed) return null
  return trimmed.replace(/^http:\/\//i, 'https://')
}

/** id → 分类名。分类名会写进 `sourceCategory` 参与品类判定，所以必须拿到，不能在 enumerate 里丢成裸 id。 */
const classNames = new Map<string, string>()

/** 源站会用「无」「暂无」占位，不能当成内容显示（会渲染出"准备 无"这种句子） */
function meaningful(value: string | undefined): string {
  const text = (value ?? '').trim()
  return /^(无|暂无|未知|不限|-|—|\/)$/.test(text) ? '' : text
}

/** 把接口返回的一条菜谱归一成 SourceRecipe */
function toSourceRecipe(item: JisuRecipe, sourceCategory: string | null = null): SourceRecipe | null {
  const name = (item.name ?? '').trim()
  const id = item.id === undefined || item.id === null ? '' : String(item.id)
  if (!id || !name) return null

  const notes: string[] = []
  const meta = [
    meaningful(item.peoplenum) ? `份量 ${meaningful(item.peoplenum)}` : '',
    meaningful(item.preparetime) ? `准备 ${meaningful(item.preparetime)}` : '',
    meaningful(item.cookingtime) ? `烹饪 ${meaningful(item.cookingtime)}` : '',
  ].filter(Boolean)
  // 该源没有「小贴士」字段，但给了份量/耗时与背景简介，都是详情页有用的信息
  if (meta.length) notes.push(meta.join(' · '))
  if (item.content?.trim()) notes.push(item.content.trim())

  const materials = item.material ?? []
  const steps = item.process ?? []

  return {
    id,
    name,
    image: secureImage(item.pic),
    description: notes.length ? notes.join('\n') : null,
    sourceTags: (item.tag ?? '').split(/[,，;；]/).map(tag => tag.trim()).filter(Boolean),
    ingredients: materials
      .map(row => ({
        // type 是数字：1 主料、0 辅料。主料排在前面更符合配料表的阅读习惯
        name: (row.mname ?? '').trim(),
        amount: (row.amount ?? '').trim(),
        isMain: Number(row.type) === 1,
      }))
      .filter(row => row.name.length > 0)
      .sort((a, b) => Number(b.isMain) - Number(a.isMain))
      .map(({ name: ingredientName, amount }) => ({ name: ingredientName, amount })),
    steps: steps.map(step => stripStepNumbering(step.pcontent ?? '')).filter(text => text.length > 0),
    stepImages: steps.map(step => secureImage(step.pic)),
    url: `${BASE}/detail?id=${id}`,
    sourceCategory,
  }
}

export const jisuSource: RecipeSourceAdapter = {
  key: 'jisu',
  name: '极速数据 · 菜谱大全',
  license: sourceLicense('paid'),
  apiKeyEnv: 'JISU_APP_KEY',

  /** 分类树：顶级 14 个、子类 900+；注意 byclass 只认叶子分类的 id */
  async listCategories(): Promise<SourceCategory[]> {
    const nodes = await call<JisuClassNode[]>('class', {})
    const categories = (Array.isArray(nodes) ? nodes : [])
      .map(node => ({
        id: String(node.classid ?? ''),
        name: node.name ?? '',
        children: (node.list ?? []).map(child => ({ id: String(child.classid ?? ''), name: child.name ?? '' })),
      }))
      .filter(node => node.id && node.name)
    classNames.clear()
    for (const node of categories) {
      classNames.set(node.id, node.name)
      for (const child of node.children) classNames.set(child.id, child.name)
    }
    return categories
  },

  /** 按叶子分类批量枚举：每页最多 20 条，靠 start 翻页直到取满 limit 或翻到底 */
  async enumerate(categoryId: string, limit: number): Promise<SourceRecipe[]> {
    if (!classNames.size) await this.listCategories!()
    const categoryName = classNames.get(categoryId) ?? null
    const collected: SourceRecipe[] = []
    for (let start = 0; collected.length < limit; start += PAGE_SIZE) {
      if (start > 0) await sleep(THROTTLE_MS)
      const page = await call<JisuPage>('byclass', {
        classid: categoryId,
        start: String(start),
        num: String(PAGE_SIZE),
      })
      const items = page?.list ?? []
      if (!items.length) break
      for (const item of items) {
        const recipe = toSourceRecipe(item, categoryName)
        if (recipe) collected.push(recipe)
      }
      if (items.length < PAGE_SIZE) break
    }
    return collected.slice(0, limit)
  },

  async search(keyword: string, limit: number): Promise<SourceRecipe[]> {
    // 搜索结果自带 classid，映射成分类名后同样能参与品类判定（一次分类树调用，之后缓存复用）
    if (!classNames.size) await this.listCategories!()
    const page = await call<JisuPage>('search', {
      keyword,
      start: '0',
      num: String(Math.min(limit, PAGE_SIZE)),
    })
    return (page?.list ?? [])
      .map(item => toSourceRecipe(item, classNames.get(String(item.classid ?? '')) ?? null))
      .filter((recipe): recipe is SourceRecipe => recipe !== null)
      .slice(0, limit)
  },
}
