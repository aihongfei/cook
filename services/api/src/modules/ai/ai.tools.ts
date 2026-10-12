import { MealSlot } from '@prisma/client'
import { MEAL_LABEL, ORDER_DAY_SPAN } from '../orders/orders.rules'

/**
 * AI 的**内置工具**（用户 2026-10-12 第③项需求）。口径见 D-026 第三次补充。
 *
 * 用户原话：「写几个内置的工具，比如说我在对话中可以直接插入点菜什么的，然后每句话的最后，
 * 或者说如果有菜的情况下的每句话的后面，询问我一下是否需要点击加入菜单这种」。
 *
 * 因此这里有两条铁律，都由本文件设计保证：
 * 1. **模型不许自己造 id**：要推荐菜就得先 `search_dishes` 拿真实 id，`propose_menu_items`
 *    里的 id 一律再拿库核对一遍——对不上就丢掉。模型编一个 id 就等于界面上凭空多出一道没的菜。
 * 2. **工具只"提名"，不"下单"**：`propose_menu_items` 一个字节都不写库，它只把建议回给界面，
 *    **用户点了"加入菜单"才真的写入**（走与手点同一套 `/orders/items`）。
 *    让模型直接改用户家的菜单是不可接受的——它可能理解错"今晚想吃鱼"里的"鱼"。
 *
 * 这个文件**不碰网络也不碰数据库**（拿库核对的部分由调用方把数据查好传进来），
 * 所以校验逻辑可以直接单测，不用起 MySQL 也不用真模型。
 */

/** 工具名常量：字符串散在各处迟早拼错（拼错的表现是模型收到一个不存在的工具，静默不调） */
export const TOOL_SEARCH_DISHES = 'search_dishes'
export const TOOL_PROPOSE_MENU_ITEMS = 'propose_menu_items'
export const TOOL_READ_PLAN = 'read_plan'

/** 一轮里最多核几个提议（模型偶尔会把整周的菜一次性倒出来） */
export const PROPOSALS_MAX = 6
/** 搜索一次最多回几道（回太多模型挑花眼，也吃掉上下文） */
export const SEARCH_RESULTS_MAX = 8
/** 工具循环最多几轮。3 轮够"搜→提→收尾"；再多就是模型在原地打转，烧时间也烧额度 */
export const TOOL_ROUNDS_MAX = 3

/** OpenAI 兼容的工具声明。`additionalProperties:false` + `required` 是为了让参数形状确定 */
export const AI_TOOLS = [
  {
    type: 'function',
    function: {
      name: TOOL_SEARCH_DISHES,
      description: '在家庭菜谱库里按关键词搜菜，返回真实的菜名与 id。想给用户推荐菜、或要往菜单里加菜时，必须先调用它拿到真实 id，不要凭记忆写菜名。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，如「番茄」「清淡」「快手」「汤」' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_PROPOSE_MENU_ITEMS,
      description: '把挑好的菜作为「要加进菜单」的建议提给用户，界面上会出现确认按钮，用户点了才会真的加。你必须先调 search_dishes 拿到真实 id 再来调这个。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: `要提给用户确认的菜，最多 ${PROPOSALS_MAX} 道`,
            items: {
              type: 'object',
              properties: {
                recipeId: { type: 'string', description: 'search_dishes 返回的真实 id' },
                mealDate: { type: 'string', description: '日期，YYYY-MM-DD。用户没说就用今天' },
                meal: { type: 'string', enum: ['LUNCH', 'DINNER'], description: '午餐还是晚餐' },
                note: { type: 'string', description: '可选的备注，如「少放辣」' },
              },
              required: ['recipeId', 'mealDate', 'meal'],
              additionalProperties: false,
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_READ_PLAN,
      description: '读这个家最近的菜单安排（哪一天哪一餐已经点了什么），用来避免重复推荐。',
      parameters: {
        type: 'object',
        properties: { days: { type: 'integer', description: '往后看几天，默认 3' } },
        required: [],
        additionalProperties: false,
      },
    },
  },
] as const

/** 模型要求调用的一个工具（从回包里摘出来的形状） */
export interface ToolCall {
  id: string
  name: string
  /** 原始 JSON 字符串（模型可能给非法 JSON，解析失败要当成"这次调用无效"而不是崩掉） */
  arguments: string
}

/** 一条待用户确认的"加菜"建议 */
export interface MenuProposal {
  recipeId: string
  name: string
  mealDate: string
  meal: MealSlot
  note: string
  /** 界面按钮上的人话，如「今天晚餐」 */
  when: string
}

const MEAL_VALUES: MealSlot[] = ['LUNCH', 'DINNER']

/**
 * 把模型给的日期收敛到"今天起 N 天"里。
 *
 * 为什么要收敛而不是照单全收：模型会写出 `2026-13-45`、去年的日期、或干脆不写。
 * 点菜窗口本来就是"今天/明天/后天"（`ORDER_DAY_SPAN`），超出窗口的建议即使提给用户，
 * 点下去也会被接口拒（400），不如在会合处就对齐到最近的可选日期。
 */
export function clampMealDate(raw: unknown, todayKey: string, span = ORDER_DAY_SPAN): string {
  const allowed = allowedDates(todayKey, span)
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (allowed.includes(text)) return text
  return allowed[0]
}

/** 允许的日期键（`YYYY-MM-DD`），从今天起 span 天。按 UTC 半夜存，与库里的日期口径一致 */
export function allowedDates(todayKey: string, span = ORDER_DAY_SPAN): string[] {
  const [year, month, day] = todayKey.split('-').map(Number)
  const base = Date.UTC(year, (month ?? 1) - 1, day ?? 1)
  return Array.from({ length: span }, (_, index) => {
    const date = new Date(base + index * 86_400_000)
    return date.toISOString().slice(0, 10)
  })
}

/**
 * 解析 `propose_menu_items` 的参数，并用**库里的真实菜**核对。
 *
 * `known` 是调用方按 id 查出来的菜（`Map<id, name>`）。对不上的 id **整条丢掉**，
 * 理由与推荐那条路一样：模型会编 id，放行就等于在界面上造一道不存在的菜。
 * 丢掉之后在 tool 结果里**告诉模型**丢了哪些，让它有机会换个真实 id 重来
 * （静默丢掉的话它会以为一切顺利，然后跟用户说"已经帮你加好了"）。
 */
export function readProposals(
  rawArguments: string,
  known: Map<string, string>,
  todayKey: string,
  span = ORDER_DAY_SPAN,
): { proposals: MenuProposal[]; rejected: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return { proposals: [], rejected: ['（参数不是合法 JSON）'] }
  }
  const items = (parsed as { items?: unknown })?.items
  if (!Array.isArray(items)) return { proposals: [], rejected: ['（缺少 items 数组）'] }

  const proposals: MenuProposal[] = []
  const rejected: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (proposals.length >= PROPOSALS_MAX) break
    const recipeId = typeof (item as { recipeId?: unknown })?.recipeId === 'string'
      ? (item as { recipeId: string }).recipeId.trim() : ''
    const name = known.get(recipeId)
    if (!name) {
      rejected.push(recipeId || '(空 id)')
      continue
    }
    const mealRaw = (item as { meal?: unknown })?.meal
    const meal = MEAL_VALUES.includes(mealRaw as MealSlot) ? (mealRaw as MealSlot) : 'DINNER'
    const mealDate = clampMealDate((item as { mealDate?: unknown })?.mealDate, todayKey, span)
    const note = typeof (item as { note?: unknown })?.note === 'string'
      ? (item as { note: string }).note.trim().slice(0, 60) : ''
    // 同一道菜同一个餐次只提一次（模型偶尔重复输出）
    const key = `${recipeId}|${mealDate}|${meal}`
    if (seen.has(key)) continue
    seen.add(key)
    proposals.push({ recipeId, name, mealDate, meal, note, when: describeWhen(mealDate, todayKey, meal) })
  }
  return { proposals, rejected }
}

/** 「今天晚餐」「明天午餐」「10-15 晚餐」——按钮上要给用户看的人话 */
export function describeWhen(mealDate: string, todayKey: string, meal: MealSlot): string {
  const dates = allowedDates(todayKey, 7)
  const offset = dates.indexOf(mealDate)
  const day = offset === 0 ? '今天' : offset === 1 ? '明天' : offset === 2 ? '后天' : mealDate.slice(5)
  return `${day}${MEAL_LABEL[meal]}`
}

/** 当天日期键（服务器本地日历，与点单口径一致——见 RISKS R-18 的时区假设） */
export function todayKey(now = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 给模型看的 tool 结果一律是**紧凑 JSON 字符串**：模型对 JSON 的服从度比散文高，
 * 而且字段名能当"用法说明"用（`recipeId` 这个词会提醒它下一个工具要传什么）。
 */
export function toolResult(payload: Record<string, unknown>): string {
  return JSON.stringify(payload)
}

export interface DishHit {
  id: string
  name: string
  category: string
  tags: string[]
}

/** 搜索结果的回包形状：只给模型用得上的字段（多余的会挤掉上下文） */
export function searchResult(hits: DishHit[], query: string): string {
  if (hits.length === 0) {
    return toolResult({ query, dishes: [], hint: '库里没有匹配的菜，换个关键词再搜，或者直接告诉用户没找到' })
  }
  return toolResult({
    query,
    dishes: hits.slice(0, SEARCH_RESULTS_MAX).map((dish) => ({
      recipeId: dish.id,
      name: dish.name,
      category: dish.category,
      tags: dish.tags.slice(0, 4),
    })),
  })
}
