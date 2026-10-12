/**
 * 采购清单的纯规则（M7 / F7-01）。口径见 D-039。
 *
 * 这块的全部难度在一件事上：**菜谱里的用量是自由文本**（"2朵"、"1袋"、"3-4颗"、"适量"、空串）。
 * 它来自各家菜谱的写法，我们不曾、也不该把它"归一"成数字——那需要一个人工维护的度量衡表，
 * 而且"适量"本来就不是一个数。
 *
 * 所以这里的做法是：**能加的时候才加，不能加就照原样列出来**。
 * 宁可写成"2朵、1袋"，也不写成"3（朵+袋）"这种假数字。
 */

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
