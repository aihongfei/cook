/**
 * 菜谱的写规则（F1-11 / F1-12；用户 2026-10-13：「自己上传的要和极速 api 的区分下」）。
 *
 * 这块的关键不是字段校验，而是**谁能改哪一道**：
 * 库里的菜有两个来源，权限完全不同——
 *
 * - **全局库**（`familyId` 为空）：导入器从第三方源（极速/jumdata/uapis）抓来的，**只读**。
 *   任何人都不许改：它是外部数据的镜像，改了会在下次导入时对不上（`recipe.importer` 里
 *   就是靠 origin/sourceKey 判断"这条是不是我导的"）。用户想改就自己复制一份成自建。
 * - **自建**（`familyId` 有值）：这个家自己上传的，**只给自家人看**（与冰箱、组合同一个口径：
 *   一家人的东西不给外人看）；本家人可改可删。
 *
 * 所以 `canWriteRecipe` 是**纯函数**、且是唯一判据——服务层与将来 AI 的工具层都用它，
 * 不允许各自再写一遍（那种"两边各判一次"迟早分叉，一处放行一处拦截）。
 *
 * 字段上限**刻意比第三方源的宽松一点**（名字 40 字、配料 30 条）：用户自己写的家常菜
 * 常有"记得放点啥"这种长备注，卡太死会让人写不完就放弃。
 */

import { BadRequestException } from '@nestjs/common'

/** 菜谱的来源（写进 `origin`）。自建的必须是这一个值 */
export const RECIPE_ORIGIN_USER = 'user'

export const RECIPE_NAME_MAX = 40
export const RECIPE_CATEGORY_MAX = 12
export const RECIPE_CUISINE_MAX = 12
export const RECIPE_TAGS_MAX = 8
export const RECIPE_TAG_MAX = 10
export const RECIPE_INGREDIENTS_MAX = 30
export const RECIPE_INGREDIENT_NAME_MAX = 20
export const RECIPE_INGREDIENT_AMOUNT_MAX = 20
export const RECIPE_STEPS_MAX = 30
export const RECIPE_STEP_MAX = 200
export const RECIPE_NOTES_MAX = 5
export const RECIPE_NOTE_MAX = 60

export interface RecipeIngredientDraft {
  name: string
  amount: string
}

/**
 * 一份自建菜谱的可写字段（创建与更新共用）。
 *
 * `image` 是 dataURL（前端已缩过图），**不在这个接口里**：它会被换成对象存储的地址与
 * key 再落库（见 `recipe-write.service` 的 `storeImage`），所以它是**请求字段、不是存储字段**。
 */
export interface RecipeDraft {
  name: string
  category: string
  cuisine: string
  tags: string[]
  ingredients: RecipeIngredientDraft[]
  steps: string[]
  notes: string[]
  calories: number | null
  aliases: string[]
}

/**
 * 判断这条菜谱能不能被"这个家/这个人"改/删。
 *
 * 三种情况，判据都在这里（**别处不许再写一遍**：两处各判一次必然分叉，
 * 一处放行一处拦截——"能不能改"与"界面上画不画编辑键"必须同一个来源）：
 *
 * - **全局库**（`familyId` 为空、`createdById` 也为空）：导入器抓来的，一律不许改；
 * - **个人菜谱**（`familyId` 为空、`createdById` 是某人）：一个人还没建家庭时先记下的，
 *   只归他自己——**只有他能改**；
 * - **家庭菜谱**（`familyId` 有值）：`familyId` 必须**完全相等**（别人家的看不见、也改不了）。
 */
export function canWriteRecipe(
  recipe: { familyId: string | null; createdById: string | null },
  actor: { userId: string; familyId: string | null },
): boolean {
  if (!recipe.familyId) return recipe.createdById !== null && recipe.createdById === actor.userId
  return recipe.familyId === actor.familyId
}

/**
 * 谁能**看见**这条菜谱（列表与详情共用；详情不做这一步就是经典的越权口子）。
 *
 * - 全局库（两个归属字段都空）：谁都能看，登录与否都一样；
 * - 个人菜谱（没家庭但有主人）：**只有主人**能看。这是"还没建家庭先记下自家菜谱"
 *   那条路的隐私边界——漏掉它的话，一个人的私人笔记会变成全站可见（实测撞到过）；
 * - 家庭菜谱：自家人能看（`familyId` 精确相等）。
 */
export function canReadRecipe(
  recipe: { familyId: string | null; createdById: string | null },
  viewer: { userId: string; familyId: string | null } | null,
): boolean {
  if (recipe.familyId !== null) return recipe.familyId === viewer?.familyId
  if (recipe.createdById === null) return true
  return recipe.createdById === viewer?.userId
}

/** 拒绝的理由（直接给用户看，所以是人话；分两种，因为用户的下一步动作不同） */
export function writeRefusal(recipe: { familyId: string | null; createdById: string | null }): string {
  if (!recipe.familyId && recipe.createdById === null) {
    return '这是菜谱库里的公共菜谱，改不了。想调整的话，把它复制成自己的一道（「我的菜谱」里新建一份）。'
  }
  return '这道菜谱不是你们家的，改不了'
}

function text(raw: unknown, field: string, max: number, { required = true } = {}): string {
  if (raw === undefined || raw === null) {
    if (required) throw new BadRequestException(`${field}不能为空`)
    return ''
  }
  if (typeof raw !== 'string') throw new BadRequestException(`${field}只能是文字`)
  const value = raw.trim()
  if (required && value === '') throw new BadRequestException(`${field}不能为空`)
  if (value.length > max) throw new BadRequestException(`${field}最多 ${max} 个字`)
  return value
}

/** 一列文字（标签/备注/别名）：去空、去重、保序、上限 */
function textList(raw: unknown, field: string, max: number, itemMax: number): string[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new BadRequestException(`${field}要是一个列表`)
  if (raw.length > max) throw new BadRequestException(`${field}最多 ${max} 条`)
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') throw new BadRequestException(`${field}里只能放文字`)
    const value = item.trim()
    if (value === '') continue
    if (value.length > itemMax) throw new BadRequestException(`${field}里每条最多 ${itemMax} 个字`)
    if (!out.includes(value)) out.push(value)
  }
  return out
}

/**
 * 配料：`{name, amount}` 列表。**只有名字是必填的**——家常菜谱里"盐适量""来一点糖"
 * 很常见，逼人把用量写清楚等于逼他编一个数（那比留空糟得多）。
 */
function ingredients(raw: unknown): RecipeIngredientDraft[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new BadRequestException('配料要是一个列表')
  if (raw.length > RECIPE_INGREDIENTS_MAX) throw new BadRequestException(`配料最多 ${RECIPE_INGREDIENTS_MAX} 条`)
  return raw.map((item) => {
    const row = item as { name?: unknown; amount?: unknown }
    return {
      name: text(row?.name, '配料名', RECIPE_INGREDIENT_NAME_MAX),
      amount: text(row?.amount, '配料用量', RECIPE_INGREDIENT_AMOUNT_MAX, { required: false }),
    }
  })
}

/** 步骤：字符串列表。空行丢掉；**至少一步**——没有步骤的"菜谱"没法做 */
function steps(raw: unknown): string[] {
  const list = textList(raw, '步骤', RECIPE_STEPS_MAX, RECIPE_STEP_MAX)
  if (list.length === 0) throw new BadRequestException('至少写一步做法')
  return list
}

/** 卡路里：可空（不填就是"不知道"，不编数——与导入器同一条口径） */
function calories(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null
  const value = typeof raw === 'string' ? Number(raw) : raw
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new BadRequestException('热量只能是数字')
  if (value < 0 || value > 10_000) throw new BadRequestException('热量看着不太对（0～10000 千卡）')
  return Math.round(value)
}

/**
 * 解析一份**新建**菜谱的请求体。必填：名字、品类、菜系、至少一步做法。
 *
 * 品类/菜系**不收固定枚举**：用户自建菜时最自然的是跟着库里的词（家常/川菜…），
 * 但硬卡枚举会让"我家祖传的糊辣汤算什么菜系"变成一个填不下去的框。
 * 去重交给库里的 filters 接口（它本来就按实际值聚合）。
 */
export function parseRecipeCreate(raw: unknown): RecipeDraft {
  const body = (raw ?? {}) as Record<string, unknown>
  return {
    name: text(body.name, '菜名', RECIPE_NAME_MAX),
    category: text(body.category, '品类', RECIPE_CATEGORY_MAX),
    cuisine: text(body.cuisine, '菜系', RECIPE_CUISINE_MAX),
    tags: textList(body.tags, '标签', RECIPE_TAGS_MAX, RECIPE_TAG_MAX),
    ingredients: ingredients(body.ingredients),
    steps: steps(body.steps),
    notes: textList(body.notes, '备注', RECIPE_NOTES_MAX, RECIPE_NOTE_MAX),
    calories: calories(body.calories),
    aliases: textList(body.aliases, '别名', RECIPE_TAGS_MAX, RECIPE_TAG_MAX),
  }
}

/**
 * 解析**更新**：只处理请求里真正出现的字段（`undefined` = 没提，保持原样）。
 *
 * 与冰箱那条"只记模型动过的字段"同一个道理：把没提的字段当成"要清空"，
 * 会把用户没打算改的东西抹掉——AI 改一句话就可能清掉别人写的步骤。
 * 用 `undefined` 当哨兵，而不是空值：`notes: []` 是明确的"清空备注"。
 *
 * @param options.allowEmpty 没有可改字段时**不报错**，返回空对象。
 *   给"这一次只换了配图"用：配图不走这个 patch（它直接写 image 那几列，
 *   见 `recipe-write.service`），但那次请求仍然是有效的改动——
 *   这里如果照旧报 400「没有要改的内容」，用户点「存好」就会莫名其妙地失败。
 */
export function parseRecipePatch(raw: unknown, options: { allowEmpty?: boolean } = {}): Partial<RecipeDraft> {
  const body = (raw ?? {}) as Record<string, unknown>
  const patch: Partial<RecipeDraft> = {}
  if (body.name !== undefined) patch.name = text(body.name, '菜名', RECIPE_NAME_MAX)
  if (body.category !== undefined) patch.category = text(body.category, '品类', RECIPE_CATEGORY_MAX)
  if (body.cuisine !== undefined) patch.cuisine = text(body.cuisine, '菜系', RECIPE_CUISINE_MAX)
  if (body.tags !== undefined) patch.tags = textList(body.tags, '标签', RECIPE_TAGS_MAX, RECIPE_TAG_MAX)
  if (body.ingredients !== undefined) patch.ingredients = ingredients(body.ingredients)
  if (body.steps !== undefined) patch.steps = steps(body.steps)
  if (body.notes !== undefined) patch.notes = textList(body.notes, '备注', RECIPE_NOTES_MAX, RECIPE_NOTE_MAX)
  if (body.calories !== undefined) patch.calories = calories(body.calories)
  if (body.aliases !== undefined) patch.aliases = textList(body.aliases, '别名', RECIPE_TAGS_MAX, RECIPE_TAG_MAX)
  if (Object.keys(patch).length === 0 && !options.allowEmpty) throw new BadRequestException('没有要改的内容')
  return patch
}

/**
 * 搜索文本：名称 + 别名 + 标签 + 配料名，**分隔符与大小写都与导入器逐字对齐**
 * （见 `recipe.importer` 与 `sources/recipe-source.ts`：`join('\n').toLowerCase()`）。
 *
 * 为什么必须一模一样：搜索是 `searchText contains`，两种拼法会让同一句搜索词在
 * "导入的菜"与"自己写的菜"上表现不同——第一版我多拼了品类与菜系，结果是
 * 搜「素菜」只命中自己写的那几道、库里那些素菜一个都不出来（看着像搜索坏了）。
 * 用户自建的那条往往恰恰是他最想搜到的（"我上次做过的那道"），更不能不一致。
 */
export function buildSearchText(draft: {
  name: string
  aliases: string[]
  ingredients: { name: string }[]
  tags: string[]
}): string {
  return [
    draft.name,
    ...draft.aliases,
    ...draft.tags,
    ...draft.ingredients.map((item) => item.name),
  ].join('\n').toLowerCase()
}

/**
 * 来源标签（前端拿它显示"这道菜哪来的"）。
 *
 * 用户要的是**区分得出来**（「自己上传的要和极速 api 的区分下」）。所以这里
 * 直接给人话，而不是把 `origin` 原样丢给前端去查表：将来加了新源，
 * 前端不用跟着改（不改就会把新源显示成一个空白或英文串）。
 */
export function sourceLabel(origin: string): string {
  if (origin === RECIPE_ORIGIN_USER) return '自己上传'
  if (origin === 'jisu') return '极速数据'
  if (origin === 'jumdata') return 'jumdata'
  if (origin === 'uapis') return 'uapis'
  if (origin === 'howtocook') return 'HowToCook'
  return origin
}
