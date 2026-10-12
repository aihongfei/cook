import { createHash } from 'node:crypto'
import { Ingredient } from '../recipe.types'
import { IngestRow } from '../recipe.importer'

/**
 * 外部菜谱数据源适配层（F1-03「可插拔 Provider」的入库侧）。
 *
 * 设计要点：
 * - 每个源只需实现 `search()`，把结果归一成 `SourceRecipe`；
 * - 品类/菜系等"我们的口径"由 `classify()` 统一映射，源站原始标签原样保留在 tags 里（便于日后重映射）；
 * - 落库统一走 `toIngestRow()` + `importSourceRecipes()`，继承冲突保护与幂等（重复导入不改动 updatedAt）。
 */
export interface SourceRecipe {
  /** 源站内的稳定 id（用于 sourceKey 去重） */
  id: string
  name: string
  image: string | null
  description: string | null
  /** 源站分类/标签原文，例如 ["家常菜","热菜","红烧"] */
  sourceTags: string[]
  ingredients: Ingredient[]
  steps: string[]
  /** 步骤配图（源站给了就先记下来，当前数据模型暂不落库） */
  stepImages: (string | null)[]
  /** 来源 URL（写进 source.url，便于追溯） */
  url: string
  /** 源站所属分类名（按分类枚举时填写）。源站分类是比菜名猜测强得多的证据，优先用它定品类。 */
  sourceCategory?: string | null
}

export interface RecipeSourceAdapter {
  /** 源标识，同时作为 DB 里的 origin（如 'uapis'） */
  key: string
  /** 人类可读名称 */
  name: string
  /** 许可/授权说明，写进 source.license */
  license: string
  /** 需要哪个环境变量提供密钥（免密钥的源返回 null） */
  apiKeyEnv: string | null
  /** 按关键词检索（现有各家 API 都是搜索式） */
  search(keyword: string, limit: number): Promise<SourceRecipe[]>
  /** 可选：取分类树（支持分类枚举的源才实现，用于批量建库） */
  listCategories?(): Promise<SourceCategory[]>
  /** 可选：按分类批量枚举菜谱 */
  enumerate?(categoryId: string, limit: number): Promise<SourceRecipe[]>
}

/** 数据源的分类节点 */
export interface SourceCategory {
  id: string
  name: string
  children: { id: string; name: string }[]
}

/** 由源内 id 派生稳定的本地 id（前缀区分来源，避免不同源撞 id） */
export function sourceRecipeId(prefix: string, key: string): string {
  return `${prefix}-${createHash('sha256').update(key).digest('hex').slice(0, 20)}`
}

const RULES: { category: string; re: RegExp }[] = [
  { category: '汤', re: /汤|羹|煲|烩/ },
  { category: '主食', re: /面|饭|粥|粉|饼|馒头|包子|饺子|馄饨|米线|馍|花卷|年糕/ },
  { category: '素菜', re: /素|蔬|凉拌|凉菜|豆腐|茄子|土豆|白菜|青菜|黄瓜|番茄|西红柿|菌|菇|笋|藕|萝卜/ },
  { category: '荤菜', re: /肉|鸡|鸭|鱼|虾|蟹|牛|猪|羊|排骨|肘|肚|肠|蛋|鹅|贝|蛤|鱿|海参/ },
]

/** 先剥掉厨具/容器词，避免"电饭锅""面包机"这类词把菜误判成主食 */
const APPLIANCE_WORDS = /电饭[锅煲]|饭盒|面包机|烤箱|微波炉|空气炸锅|高压锅|砂锅|平底锅/g

/**
 * 源站分类名 → 本项目四分类。
 * 只收录「本身就是四分类之一」的分类名（依据极速数据 菜品(301) 的真实叶子名逐个核对），
 * 像"凉菜""热菜""家常菜"这种既可能是素菜也可能是荤菜的，不猜，交给菜名规则。
 */
const SOURCE_CATEGORY_MAP: Record<string, string> = {
  素菜: '素菜',
  斋菜: '素菜',
  汤: '汤',
  羹: '汤',
  海鲜: '荤菜',
  // 主食类叶子（面点/饭粥等），逐条对应源站真实分类名
  饭: '主食',
  炒饭: '主食',
  盖浇饭: '主食',
  煲仔饭: '主食',
  粥: '主食',
  面: '主食',
  面食: '主食',
  炒面: '主食',
  粉: '主食',
  饼: '主食',
  油酥类面点: '主食',
  糕点: '主食',
  汤圆: '主食',
  馄饨: '主食',
  馒头: '主食',
  饺子: '主食',
  包子: '主食',
  卷子: '主食',
  粽子: '主食',
}

/** 真实菜系名（取自极速数据 菜系(223) 的叶子，剔掉混在里面的"减肥""烘焙"等非菜系项） */
const CUISINE_NAMES = [
  '川菜', '湘菜', '粤菜', '闽菜', '浙菜', '鲁菜', '苏菜', '徽菜', '京菜', '天津菜', '上海菜', '渝菜',
  '东北菜', '清真菜', '豫菜', '晋菜', '赣菜', '湖北菜', '云南菜', '贵州菜', '新疆菜', '淮扬菜', '潮州菜',
  '客家菜', '广西菜', '西北菜', '香港美食', '台湾菜', '澳门美食', '西餐', '日本料理', '韩国料理',
  '泰国菜', '越南菜', '意大利菜', '墨西哥菜', '西班牙菜', '法国菜', '美国菜', '东南亚菜', '印度菜',
]

/**
 * 品类映射：源站只给「炒/红烧/家常菜」这类标签，需要归一到本项目的四分类
 * （主食 / 汤 / 素菜 / 荤菜，与现有筛选器口径一致）。
 * 判定顺序：
 *   1. 源站分类名命中 `SOURCE_CATEGORY_MAP` → 直接采用（源站事实，最可信）；
 *   2. 否则按菜名/标签规则：汤 → 主食 → 素菜 → 荤菜；
 *   3. 都不命中时归为「荤菜」（家常菜池子里占比最高）。
 * 2、3 是启发式规则，不是源站事实；原始标签已完整保留在 tags 中，日后可无损重映射。
 */
export function classify(tags: string[], name: string, sourceCategory?: string | null): { category: string; cuisine: string } {
  const cuisine = deriveCuisine(tags, sourceCategory)
  const mapped = sourceCategory ? SOURCE_CATEGORY_MAP[sourceCategory.trim()] : undefined
  if (mapped) return { category: mapped, cuisine }
  // 剥掉厨具词再匹配，避免"电饭锅""面包机"里的"饭""面"把菜误判成主食
  const haystack = [name, ...tags].join(' ').replace(APPLIANCE_WORDS, ' ')
  for (const rule of RULES) {
    if (rule.re.test(haystack)) return { category: rule.category, cuisine }
  }
  return { category: '荤菜', cuisine }
}

/** 菜系：源站分类名或标签里明确出现真实菜系名就用它，否则归「家常」（不臆造） */
export function deriveCuisine(tags: string[], sourceCategory?: string | null): string {
  const haystack = [sourceCategory ?? '', ...tags].join(' ')
  return CUISINE_NAMES.find(cuisine => haystack.includes(cuisine)) ?? '家常'
}

/** 源站若明确标注了辣，就记 1；没标就记 0（不臆造辣度） */
export function deriveSpiciness(tags: string[]): number {
  return /麻辣|香辣|特辣|中辣|微辣|辣/.test(tags.join(' ')) ? 1 : 0
}

/** 去掉步骤文本前的序号（"1." / "1、" / "①"） */
export function stripStepNumbering(text: string): string {
  return text.replace(/^\s*(?:[0-9]{1,2}\s*[.、．)]|[①-⑳])\s*/, '').trim()
}

/**
 * 清理菜名里的编辑性/人群性前缀，如"[原创首发]绿豆糕馅包子"→"绿豆糕馅包子"、"【儿童美食】红薯发糕"→"红薯发糕"。
 * 只剥括号里是「编辑标注或人群标注」的前缀，绝不无条件剥括号：
 * 源站有"【红烧排骨】万用的炒糖上色法""【桂圆银耳羹】"这类**菜名本身在括号里**的写法，剥了就丢了菜名。
 * 因此关键词表保持保守（只收真实见过的），并且剥完为空时原样返回。
 */
const NAME_PREFIX_WORDS = '原创首发|原创|首发|转载|转自|菜谱|美食|儿童美食|儿童|宝宝辅食|宝宝|婴儿|幼儿|孕妇|产妇|月子餐|老人|养生|私房菜谱'

export function cleanDishName(name: string): string {
  const cleaned = name
    .replace(new RegExp(`^\\s*[\\[（(【]\\s*(?:${NAME_PREFIX_WORDS})\\s*[\\]）)】]\\s*`), '')
    .trim()
  return cleaned || name.trim()
}

/** "五花肉,500g" / "玫瑰腐乳,适量" → { name, amount } */
export function parseCommaPair(entry: string): Ingredient | null {
  const text = entry.trim()
  if (!text) return null
  const at = text.indexOf(',')
  if (at < 0) return { name: text, amount: '' }
  return { name: text.slice(0, at).trim(), amount: text.slice(at + 1).trim() }
}

/** "鸡蛋 3个" → { name, amount }；无用量时整串作为名称 */
export function parseSpacePair(entry: string): Ingredient | null {
  const text = entry.trim()
  if (!text) return null
  const match = /^(.*?)[\s　]+([0-9０-９][^]*)$/.exec(text)
  if (!match) return { name: text, amount: '' }
  return { name: match[1].trim(), amount: match[2].trim() }
}

/** 按顺序解析：先按分隔符切条，再逐条交给 `parse` */
export function parseIngredientList(raw: unknown, separator: RegExp, parse: (entry: string) => Ingredient | null): Ingredient[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  return raw.split(separator).map(parse).filter((item): item is Ingredient => item !== null)
}

const SOURCE_LICENSE_KINDS: Record<string, string> = {
  free: '第三方免费 API（数据版权归原站，仅开发期使用）',
  paid: '第三方商业 API（用户自购授权）',
}

export function sourceLicense(kind: keyof typeof SOURCE_LICENSE_KINDS): string {
  return SOURCE_LICENSE_KINDS[kind] ?? SOURCE_LICENSE_KINDS.free
}

/** 把归一后的源数据转成统一的入库行 */
export function toIngestRow(adapter: RecipeSourceAdapter, recipe: SourceRecipe): IngestRow {
  const { category, cuisine } = classify(recipe.sourceTags, recipe.name, recipe.sourceCategory)
  const name = cleanDishName(recipe.name)
  const prefix = adapter.key === 'uapis' ? 'upa' : adapter.key.slice(0, 3)
  return {
    id: sourceRecipeId(prefix, `${adapter.key}:${recipe.id}`),
    origin: adapter.key,
    sourceKey: `${adapter.key}:${recipe.id}`,
    data: {
      // origin/sourceKey 必须写进负载：DB 列有默认值，漏写会被当成 origin='user' 且 sourceKey=NULL，
      // 既破坏去重，也会让下次导入把记录误判成"用户自建"而跳过。
      origin: adapter.key,
      sourceKey: `${adapter.key}:${recipe.id}`,
      name,
      image: recipe.image,
      category,
      cuisine,
      aliases: [],
      tags: recipe.sourceTags,
      calories: null,
      caloriesEstimated: false,
      spiciness: deriveSpiciness(recipe.sourceTags),
      ingredients: recipe.ingredients,
      steps: recipe.steps,
      notes: recipe.description ? [recipe.description] : [],
      tools: [],
      videoUrl: null,
      source: {
        name: adapter.name,
        url: recipe.url,
        license: adapter.license,
        commit: `api-${new Date().toISOString().slice(0, 10)}`,
      },
      sourcePath: recipe.url,
      rawMarkdown: null,
      searchText: [name, ...recipe.sourceTags, ...recipe.ingredients.map(i => i.name)].join('\n').toLowerCase(),
    },
  }
}
