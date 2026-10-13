/**
 * 采购清单的纯规则（M7 / F7-01、F7-02）。口径见 D-039 与 D-059。
 *
 * 这块的全部难度在一件事上：**菜谱里的用量是自由文本**（"2朵"、"1袋"、"3-4颗"、"适量"、空串）。
 * 它来自各家菜谱的写法，我们不曾、也不该把它"归一"成数字——那需要一个人工维护的度量衡表，
 * 而且"适量"本来就不是一个数。
 *
 * 所以这里的做法是：**能加的时候才加，不能加就照原样列出来**。
 * 宁可写成"2朵、1袋"，也不写成"3（朵+袋）"这种假数字。
 *
 * F7-02（与库存比对"只买缺的"）沿用同一条规矩：**算得清才算减法**，
 * 算不清就照实说"家里有，够不够自己看"（见下方 `compareWithStock`）。
 */

import { canonicalName } from '../fridge/pantry.rules'

/** 一道菜（或一餐里的一组菜）的配料表：菜名 + 它的配料 */
export interface DishIngredients {
  dish: string
  ingredients: readonly { name: string; amount: string }[]
}

export interface ShoppingItem {
  /** 食材名（按写法归一后的显示名） */
  name: string
  /**
   * 要买多少。`null` = 菜谱里压根没写用量（不是"0"也不是"适量"——
   * 那是"我们不知道要多少"，界面上要说"用量没写"）。
   */
  amount: string | null
  /** 哪几道菜要用它（去重、保持首次出现的顺序） */
  from: string[]
}

/**
 * 食材名归一：只去首尾空白。
 *
 * **刻意不做更多**（不去括号、不做同义词合并、不按方言别名归并）：
 * "生抽"与"酱油"是不是一回事，只有人知道；归并错了会让用户少买一样东西，
 * 而这比"多列一行"严重得多。要归并得有一份可维护的同义词表，那是另一个功能。
 */
export function normalizeIngredientName(raw: string): string {
  return raw.trim()
}

/**
 * 把用量文本拆成"数字 + 单位"。
 *
 * 认得的形状：`2朵`、`1.5勺`、`100 g`（数字与单位之间的空格吃掉）。
 * 认不得的原样返回 null：`适量`、`少许`、``（空）、`一大把`、`半个`。
 *
 * **区间一律不认**（`3-4颗`、`2~3个`、`5—6片`、`3到4个`）：不是算不出中间值，而是**不该算**——
 * 菜谱写"3-4 颗"的意思就是"两三颗都行"，替它求成 3.5 是把一个选择变成一句假精确。
 * 这层判断是必须的：`3-4颗` 若只按下面的正则截取，会得到"值 3、单位 -4颗"这种荒唐结果
 * （曾经就是这么写的，被单测逮住）。
 */
export function parseAmount(raw: string): { value: number; unit: string } | null {
  const text = raw.trim()
  // 区间：数字后紧跟 - ~ ～ — – ），或"到/至"（"3到4个"）—— 一律不认，原样列出
  if (/^\d+(?:\.\d+)?\s*[-~～—–]/.test(text) || /^\d+(?:\.\d+)?\s*[到至]/.test(text)) return null
  const match = /^(\d+(?:\.\d+)?)\s*(.*)$/.exec(text)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  return { value, unit: match[2].trim() }
}

/** 求和结果的显示：整数不带小数点（`5` 而不是 `5.0`），小数最多两位（浮点加法的尾巴要收掉） */
function formatNumber(value: number): string {
  return String(Number(value.toFixed(2)))
}

/**
 * 把同一样食材的几处用量合成一句话。规则只有三条：
 *
 * 1. **全是数字且单位一致** → 加起来（`2朵` + `3朵` → `5朵`）。这是"买菜"最想要的结果；
 * 2. **单位不一致，或含认不出的写法** → 原样列出、去重（`2朵、1袋`、`适量`、`2g、适量`）；
 *    **不跨单位求和**（`2朵` + `1袋` 不等于 `3`），也不把"适量"折算成数字；
 * 3. **一处都没写用量** → `null`（界面上说"用量没写"，不说"适量"——那是在替菜谱编话）。
 *
 * 数字那部分能合就先合（`2g` + `适量` → `2g、适量`）：用户一眼能把能算的和不能算的分开。
 */
export function mergeAmounts(amounts: readonly string[]): string | null {
  const texts = amounts.map((amount) => amount.trim())
  const parsed = texts.map((text) => (text ? parseAmount(text) : null))
  const numbers = parsed.filter((entry): entry is { value: number; unit: string } => entry !== null)
  const unrecognized = [...new Set(texts.filter((text, index) => text !== '' && parsed[index] === null))]

  if (numbers.length === 0) {
    // 全是"适量/少许"这类：去重后原样列出；一处都没写就是 null
    return unrecognized.length > 0 ? unrecognized.join('、') : null
  }

  const units = new Set(numbers.map((entry) => entry.unit))
  const sumText =
    units.size === 1
      ? `${formatNumber(numbers.reduce((total, entry) => total + entry.value, 0))}${numbers[0].unit}`
      : // 单位不一致：各自原样列出（含数字与单位），不与认不出的一起求
        [...new Set(numbers.map((entry) => `${formatNumber(entry.value)}${entry.unit}`))].join('、')

  if (unrecognized.length > 0) return [sumText, ...unrecognized].join('、')
  return sumText
}

/**
 * 把几道菜的配料表合成一张买菜单。
 *
 * 三件事刻意的：
 * - **同名食材跨菜合并**（这是"按菜单汇总"的全部意义：五道菜都要葱，就买一次葱）；
 * - **顺序按食材名排**（`localeCompare('zh')` 让中文按拼音走）：买菜单要能一眼扫过去、
 *   两次打开位置一致；按"哪道菜先出现"排的话，改一餐顺序整张单子就重排，用户会以为内容变了；
 * - **`from` 里保留菜名**：买菜的人要能回答"我为什么要买这个"（"银耳是给哪道菜的？"）。
 */
export function aggregateIngredients(
  dishes: readonly DishIngredients[],
  locale = 'zh',
): ShoppingItem[] {
  const byName = new Map<string, { amounts: string[]; from: string[] }>()
  for (const dish of dishes) {
    for (const ingredient of dish.ingredients) {
      const name = normalizeIngredientName(ingredient.name)
      if (!name) continue
      const entry = byName.get(name) ?? { amounts: [], from: [] }
      entry.amounts.push(ingredient.amount)
      if (!entry.from.includes(dish.dish)) entry.from.push(dish.dish)
      byName.set(name, entry)
    }
  }
  return [...byName]
    .map(([name, entry]) => ({ name, amount: mergeAmounts(entry.amounts), from: entry.from }))
    .sort((a, b) => a.name.localeCompare(b.name, locale))
}

/* ------------------------------------------------------------------ *
 * 与库存比对（M7 / F7-02「只买缺的」）
 * ------------------------------------------------------------------ */

/**
 * 冰箱里的一样东西（比对用的最小形状）。
 *
 * 数量是**自由文本**（「一盒」「3个」「半颗」「若干」，也可以没写）——与菜谱那侧同一套口径。
 */
export interface StockRow {
  name: string
  amount: string | null
}

/**
 * 比对结论。
 *
 * 四档而不是"要买/不用买"两档，是因为**有两件事我们真的不知道**：
 * - 菜谱要多少（它可能写"适量"，或者压根没写）；
 * - 家里有多少（他可能只记了"一盒"，而"一盒"是几个只有他知道）。
 *
 * 这两件事只要有一件不知道，就**不能算减法**——只能照实说"家里有，自己看一眼"。
 * 这与 `parseAmount` 拒绝给区间求平均是同一个立场：不编一个看起来精确的假数字。
 */
export type StockVerdict =
  /** 家里没有（或没对上）：照买 */
  | 'missing'
  /** 家里有，而且**算得清、确实够了**：不用买 */
  | 'enough'
  /** 家里有，**算得清但不够**：还要买一点（`remaining` 给了差多少） */
  | 'notEnough'
  /** 家里有，但**量算不清**（单位不同、有一边不是数字、或压根没写）：够不够自己看 */
  | 'unknown'

export interface StockComparison {
  verdict: StockVerdict
  /** 家里那一样**按他记的名字**回显（他说"西红柿"就不回"番茄"） */
  stockName: string | null
  /** 家里记的量原样回显（可能有几条：同一样东西放在两个区） */
  stockAmount: string | null
  /** 扣掉家里已有的之后还要买多少（**只有算得清时才给**，其余为 null） */
  remaining: string | null
}

export interface ShoppingItemWithStock extends ShoppingItem {
  stock: StockComparison
  /** 还要不要买（`missing` 与 `notEnough` 要；`enough` 与 `unknown` 不要） */
  needsBuy: boolean
  /**
   * 那一行的人话（**后端拼好**，与冰箱的 `expiryLabel` 同一条规矩：两边各拼一次
   * 必然有一边先改，而"家里有/还差"这种话一旦不一致用户就不信它了）。
   * `missing` 是 `null`——家里没有的东西不需要在清单上说一句话。
   */
  stockLabel: string | null
}

/**
 * 拿一样要买的食材去冰箱里找。
 *
 * 匹配**复用 `pantry.rules` 的那一套**（等值 / 别名 / 切法，不做品类推断）：
 * 那个文件是"这两个名字是不是同一样东西"的唯一权威定义，采购清单、手边食材选菜、
 * 冰箱推荐三处都调它。各写一套的话，同一样东西在三个页面会给出三个答案
 * （"辣椒算不算辣椒面"这种问题不该有三份回答）。
 *
 * 算减法**只在同单位且两边都是数字时**做：
 * - 菜谱要 `2个`、冰箱有 `3个` → 够了；
 * - 菜谱要 `5个`、冰箱有 `3个` → 还要买 `2个`；
 * - 菜谱要 `2个`、冰箱有 `半盒` → **算不清**（"半盒"是几个？只有人知道）；
 * - 菜谱写 `适量` / 没写 → **算不清**（连要多少都不知道，凭什么说够）。
 */
export function compareWithStock(
  item: { name: string; amount: string | null },
  stock: readonly StockRow[],
): StockComparison {
  const target = canonicalName(item.name)
  const hits = target ? stock.filter((row) => canonicalName(row.name) === target) : []
  if (hits.length === 0) {
    return { verdict: 'missing', stockName: null, stockAmount: null, remaining: null }
  }

  const stockName = hits[0].name
  const amounts = hits.map((row) => row.amount?.trim() ?? '').filter((text) => text !== '')
  const stockAmount = amounts.length > 0 ? amounts.join('、') : null

  const base = { stockName, stockAmount, remaining: null }
  const need = item.amount ? parseAmount(item.amount) : null
  const have = amounts.map((text) => parseAmount(text))

  // 菜谱没说要多少（或"适量"），或者家里有一处不是数字/单位对不上：算不清就不算
  if (!need) return { ...base, verdict: 'unknown' }
  if (have.length === 0) return { ...base, verdict: 'unknown' }
  if (have.some((entry) => entry === null)) return { ...base, verdict: 'unknown' }
  if (have.some((entry) => entry?.unit !== need.unit)) return { ...base, verdict: 'unknown' }

  const total = have.reduce((sum, entry) => sum + (entry?.value ?? 0), 0)
  if (total >= need.value) return { ...base, verdict: 'enough' }
  return { ...base, verdict: 'notEnough', remaining: `${formatNumber(need.value - total)}${need.unit}` }
}

/**
 * 那一行的人话（后端算好给前端，不在前端重拼一遍——两边各拼一次必然有一边先改）。
 *
 * `missing` 返回 null（家里没有的东西不需要解释）；其余三档都要说清**家里有多少**，
 * 因为用户接下来要判断的正是"这些够不够"：
 * - `enough`：「家里有 3个，够了」
 * - `notEnough`：「家里有 3个，还要买 2个」
 * - `unknown`：「家里有 半盒，够不够看一眼」——**这句话的重点是"我们不知道"**，
 *   不能写成"够了"（那是编的），也不能不显示（那用户会以为漏了）。
 */
export function stockLabel(comparison: StockComparison): string | null {
  const { verdict, stockAmount } = comparison
  if (verdict === 'missing') return null
  if (verdict === 'enough') return `家里有 ${stockAmount ?? '一些'}，够了`
  if (verdict === 'notEnough') return `家里有 ${stockAmount}，还要买 ${comparison.remaining}`
  return `家里有${stockAmount ? ` ${stockAmount}` : ''}，够不够看一眼`
}

/**
 * 把整张清单过一遍冰箱。
 *
 * **顺序不变**（仍是按名字排的）：买菜时清单的顺序要稳定，两件事分开看就够——
 * 界面上"要买的"和"家里有的"分两组渲染，而不是把整张单子重排一遍
 * （重排会让用户下次打开时找不到上次看到的位置）。
 */
export function applyStock(
  items: readonly ShoppingItem[],
  stock: readonly StockRow[],
): ShoppingItemWithStock[] {
  return items.map((item) => {
    const comparison = compareWithStock(item, stock)
    return {
      ...item,
      stock: comparison,
      needsBuy: comparison.verdict === 'missing' || comparison.verdict === 'notEnough',
      stockLabel: stockLabel(comparison),
    }
  })
}
