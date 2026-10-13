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

import { BadRequestException } from '@nestjs/common'
import { ALIAS_GROUPS, canonicalName, isSeasoning } from '../fridge/pantry.rules'
import type { FridgeZone } from '../fridge/fridge.rules'

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
 * 货架分组（M7 / F7-03「分组」）：把清单按"在超市里怎么走"排
 * ------------------------------------------------------------------ */

/**
 * 货架。**这不是品类树，也不是"能不能做菜"的判据**——它只回答
 * "这样东西在超市里大概在哪个区"，错了的代价是**它出现在相邻的分组里**，而不是买错或漏买。
 *
 * 这条区别很要紧，所以下面 `aisleOf` 的兜底是**明说"其他"**，而不是硬塞进最像的那一组：
 * 与 `pantry.rules` 拒绝品类推断（"五花肉算不算猪肉"）不是同一条规矩——
 * 那个判错了用户会**少买一样**、站到灶台前才发现；这个判错了用户只是多扫一眼。
 * 所以这里可以容错，但**仍然不许假装认识**（不认识的就说不知道）。
 */
export type ShoppingAisle =
  | '蔬菜水果'
  | '肉蛋水产'
  | '蛋奶豆制品'
  | '米面粮油'
  | '调味干货'
  /** 归不了类的（长尾写法）。**明说"其他"，不硬塞**——见上面的说明 */
  | '其他'

/** 显示顺序：生鲜在前、米面在后、调料垫底（逛超市的动线也是这个顺序） */
export const AISLE_ORDER: readonly ShoppingAisle[] = [
  '蔬菜水果', '肉蛋水产', '蛋奶豆制品', '米面粮油', '调味干货', '其他',
]

export const AISLE_LABEL: Record<ShoppingAisle, string> = {
  蔬菜水果: '蔬菜水果',
  肉蛋水产: '肉蛋水产',
  蛋奶豆制品: '蛋奶豆制品',
  米面粮油: '米面粮油',
  调味干货: '调味干货',
  其他: '其他',
}

/**
 * 货架归类表（**由真实数据生成**，不是凭空写的一份分类学）。
 *
 * 来源与口径：拿库里 612 道菜的 **4805 条配料、827 个不同写法**按出现次数排出，
 * 人工（按"买菜时在哪个货架"）归到上面五类，外加复用 `pantry.rules` 的 `SEASONINGS`（调料）。
 * **实测覆盖 89.4% 的配料条目**（按出现次数加权；按不同写法算是 46%，因为长尾极长）。
 * 剩下 10.6% 进「其他」——都是低频写法（姜粉、酒酿、熟芝麻这种）。
 *
 * 两条维护规矩：
 * - **要加就加在对应那一组的末尾**，不要重排（顺序按真实频率，扫一眼就知道哪些最常见）；
 * - **这里只放"确定在哪个货架"的**。不确定就别放，它会落到「其他」——那是安全的默认，
 *   而放错组会让用户在一个不相干的区里找东西。
 */
/**
 * 货架归类表（**由真实数据生成**，不是凭空写的一份分类学）。
 *
 * 来源与口径：拿库里 612 道菜的 **4805 条配料、827 个不同写法**按出现次数排出，
 * 人工（按"买菜时在哪个货架"）归到下面四类，调料那一类直接复用
 * `pantry.rules` 的 `SEASONINGS`（"什么算调料"的唯一权威定义，不在这里再抄一遍）。
 *
 * **实测覆盖 89.4% 的配料条目**（按出现次数加权；按不同写法算只有 46%，因为长尾极长）。
 * 剩下 10.6% 落到「其他」——都是低频写法（姜粉、酒酿、熟芝麻这类）。
 *
 * 三条维护规矩：
 * - **每组内按真实频率排**（扫一眼就知道哪些最常见），新名字加在**对应组的末尾**；
 * - **只放"确定在哪个货架"的**。不确定就别放，它会落到「其他」——那是安全的默认；
 *   放错组会让用户在一个不相干的区里找东西；
 * - 别名沿用 `pantry.rules` 的 `ALIAS_GROUPS`（下面建索引时自动展开，不必在这里重复写）。
 */
export const AISLE_NAMES: Record<Exclude<ShoppingAisle, '其他' | '调味干货'>, readonly string[]> = {
  蔬菜水果: [
    '胡萝卜', '红枣', '黑木耳', '香菜', '黄瓜', '韭菜', '香菇',
    '芹菜', '干辣椒', '枸杞', '金针菇', '土豆', '银耳', '冬瓜',
    // 单字的葱/姜/蒜要**显式在列**：它们是最高频的写法（姜 147 次、葱 116 次、蒜 39 次），
    // 只写「葱姜」「蒜末」这些复合形态会漏掉它们，于是最常买的三样反而归到调料去了。
    '葱', '姜', '蒜', '香菜',
    '小葱', '香葱', '洋葱', '青椒', '红椒', '大葱', '茴香',
    '南瓜', '番茄', '苦瓜', '苹果', '红薯', '辣椒', '西芹',
    '冬笋', '葱姜', '玉米', '白菜', '西兰花', '红辣椒', '西红柿',
    '莴笋', '木瓜', '竹笋', '菠菜', '紫甘蓝', '白萝卜', '青菜',
    '海带', '山药', '绿豆芽', '丝瓜', '杏鲍菇', '蘑菇', '牛蒡',
    '莲藕', '蒜薹', '蒜苔', '娃娃菜', '圆白菜', '卷心菜', '生菜',
    '油麦菜', '茼蒿', '空心菜', '苋菜', '豆芽', '黄豆芽', '荷兰豆',
    '四季豆', '豇豆', '豌豆', '青豆', '毛豆', '秋葵', '茄子',
    '佛手瓜', '茭白', '香椿', '荠菜', '青蒜', '蒜苗', '韭菜花',
    '柠檬', '橙子', '橘子', '香蕉', '梨', '桃子', '葡萄',
    '草莓', '芒果', '菠萝', '西瓜', '哈密瓜', '火龙果', '猕猴桃',
    '蓝莓', '樱桃', '石榴', '柿子', '荔枝', '龙眼', '柚子',
    '椰子', '甘蔗', '荸荠', '菱角', '地瓜', '紫薯', '芋头',
    '马铃薯', '板栗', '银杏', '藕', '西葫芦', '尖椒', '彩椒',
    '青辣椒', '红尖椒', '包菜', '花菜', '菜花', '豆角', '扁豆',
    '海鲜菇', '魔芋', '大枣', '枣', '山楂', '葡萄干', '枸杞子',
    '桂圆', '桂圆肉', '莲子', '干莲子', '干银耳', '水发木耳', '泡发木耳',
    '干香菇', '干红椒', '干红辣椒', '野山椒', '辣皮子', '大料', '姜蒜',
    '葱姜蒜', '红萝卜', '裙带菜', '紫菜', '海苔', '黄花菜', '荷叶',
    '粽叶', '香茅', '柠檬草', '罗勒', '薄荷', '迷迭香', '百里香',
    '欧芹', '香草', '芦笋', '鲜香菇', '冬菇', '干木耳', '干黄花菜',
    '栗子', '灯笼椒', '生姜汁', '柠檬汁', '干百合', '百合', '鲜百合', '红彩椒', '红甜椒',
    '泡辣椒', '泡菜', '玫瑰', '糖桂花', '干淀粉', '火锅底料', '油辣椒', '辣椒酱',
  ],
  肉蛋水产: [
    '猪肉', '五花肉', '排骨', '猪肉末', '大虾', '虾仁', '瘦肉',
    '猪蹄', '虾皮', '海虾', '牛肉', '羊肉', '鸡肉', '鸡腿',
    '鸡翅', '鸡胸肉', '鸭肉', '鸭腿', '鹅肉', '猪肝', '猪肚',
    '猪心', '猪腰', '牛腩', '牛腱', '羊排', '羊腿', '培根',
    '火腿', '香肠', '腊肠', '腊肉', '午餐肉', '肉糜', '肉馅',
    '肉末', '肉片', '肉丝', '鱼', '鲫鱼', '草鱼', '鲤鱼',
    '鲈鱼', '带鱼', '黄花鱼', '鲅鱼', '鳕鱼', '三文鱼', '金枪鱼',
    '鱿鱼', '墨鱼', '章鱼', '扇贝', '蛤蜊', '花蛤', '生蚝',
    '牡蛎', '蟹', '螃蟹', '龙虾', '小龙虾', '鱼丸', '虾滑',
    '鱼滑', '咸鱼', '鱼干', '虾米', '干贝', '海米', '瑶柱',
    '淡菜', '鱼头', '鱼尾', '鱼排', '鸡胗', '鸡心', '鸡肝',
    '鸭胗', '牛肚', '毛肚', '肉', '里脊', '里脊肉', '猪肉馅',
    '鲜虾', '火腿肠', '鱼露', '蛎子', '青口', '牛百叶', '鸡爪',
    '明虾', '虾', '猪血', '金枪鱼罐头',
  ],
  蛋奶豆制品: [
    '鸡蛋', '牛奶', '酸奶', '豆腐', '嫩豆腐', '老豆腐', '北豆腐',
    '南豆腐', '内酯豆腐', '魔芋豆腐', '鹌鹑蛋', '皮蛋', '咸蛋', '鸭蛋',
    '鸽蛋', '蛋清', '鸡蛋清', '土鸡蛋', '豆浆', '豆腐脑', '豆渣',
    '豆奶', '奶粉', '奶油', '淡奶油', '芝士', '奶酪', '炼乳',
    '羊奶', '腐乳',
  ],
  米面粮油: [
    '面粉', '大米', '糯米', '小米', '薏米', '燕麦', '红豆',
    '黄豆', '粉丝', '燕麦片', '糙米', '饺子皮', '米粉', '面条',
    '挂面', '馄饨皮', '云吞皮', '春卷皮', '面包', '馒头', '花卷',
    '包子', '饺子', '年糕', '汤圆', '粽子', '烧饼', '意面',
    '意大利面', '通心粉', '荞麦面', '玉米面', '绿豆面', '高粱米', '黑米',
    '紫米', '香米', '籼米', '珍珠米', '玉米碴', '燕麦米', '藜麦',
    '鹰嘴豆', '绿豆', '黑豆', '芸豆', '蚕豆', '赤小豆', '白扁豆',
    '豌豆粉', '藕粉', '凉粉', '粉皮', '粉条', '宽粉', '河粉',
    '肠粉', '米线', '方便面', '拉面', '刀削面', '面筋', '烤麸',
    '腐竹', '豆腐皮', '千张', '豆干', '香干', '油豆腐', '豆泡',
    '糯米粉', '粳米', '薏仁', '澄粉', '荞麦', '玉米碎', '花生',
    '花生米', '花生仁', '腰果', '核桃', '杏仁', '熟芝麻',
    // 从「其他」里捞回来的（归属确定，且真实出现过）：小麦粉=面粉的别名写法、食油=食用油
    '小麦粉', '食油', '鲜抽', '胡椒', '花椒面', '胡椒面', '红米', '豆皮', '圣女果', '蜜枣',
  ],
}

/** 名字 → 货架（建表时把别名一起展开，运行时只查这一张） */
const AISLE_INDEX = new Map<string, ShoppingAisle>()
{
  const put = (name: string, aisle: ShoppingAisle) => {
    const key = canonicalName(name)
    // 先到先得：同一样东西不该出现在两个货架上（别名展开时尤其要防这个）
    if (key && !AISLE_INDEX.has(key)) AISLE_INDEX.set(key, aisle)
  }
  for (const [aisle, names] of Object.entries(AISLE_NAMES)) {
    for (const name of names) put(name, aisle as ShoppingAisle)
  }
  // 别名：`西红柿` 归了蔬菜，那 `番茄` 跟着走（不在这里重列一遍，免得两处不一致）
  for (const group of ALIAS_GROUPS) {
    const aisle = AISLE_INDEX.get(canonicalName(group[0]))
    if (!aisle) continue
    for (const name of group) put(name, aisle)
  }
}

/**
 * 这样东西在哪个货架。
 *
 * 三级判断，**顺序不能换**：
 * 1. **货架表**（按写法归一后查）：`葱`/`姜`/`蒜`/`香菜` 在这里被判为「蔬菜水果」——
 *    它们虽然是自己厨房里的常备品（`SEASONINGS` 里有），但**买菜时确实在菜摊上**。
 *    两张表回答的是两个问题，所以这里不先看调料表；
 * 2. **调料表**（`pantry.rules` 的 `SEASONINGS`）：盐糖酱醋、香辛料、淀粉、水；
 * 3. 都不认识 → **「其他」**（不硬塞，见 `ShoppingAisle` 的说明）。
 */
export function aisleOf(raw: string): ShoppingAisle {
  const key = canonicalName(raw)
  if (!key) return '其他'
  return AISLE_INDEX.get(key) ?? (isSeasoning(raw) ? '调味干货' : '其他')
}

/**
 * 这不是一样"要去买的东西"（水的各种写法）。
 *
 * 菜谱里 38 处写"水"、17 处"清水"、9 处"温水"……共 **72 条（1.5%）**。
 * 它们出现在采购清单上很荒唐——**没人去超市买温水**。
 * 所以**是在生成清单时就滤掉**（而不是分组时说"其他"）：滤掉 = 这一条不在清单上，那是对的；
 * 放进"其他"用户还得自己划掉它。
 *
 * 判据只收**水本身**（含各种温度），**不收**高汤/鸡汤/骨头汤——
 * 那几样是真的要买的（或者要自己煮），与"水龙头里就有"不是一回事。
 */
export function isBuyable(raw: string): boolean {
  const name = normalizeIngredientName(raw)
  if (!name) return false
  return !WATER_NAMES.has(name)
}


/**
 * 从货架推默认存放区（F7-05「一键补货」要它）。
 *
 * 为什么必须自动推：补货是**批量**动作（一次勾五六样一起入库），
 * 要是每样都让用户选一次存放区，这个功能就从"一键"变回"填六张表单"，
 * 用户宁愿一样一样手填——那这一条就白做了。
 *
 * 推到的是**默认值，不是答案**：入库后每一样都能改（与手动录入同一个编辑入口）。
 * 所以这里可以按货架粗推，错了的代价是用户改一下；不推的代价是没人用这个功能。
 *
 * 推法就一条常识：**冷冻的放冷冻，其余按"是不是干货"分**——
 * 生鲜（蔬菜水果）与蛋奶豆制品进冷藏，米面粮油与调味干货进常温。
 * 这不是在猜品类，是把"买回来的东西该去哪儿"这一个人人都知道的规则写下来。
 */
export function aisleZone(aisle: ShoppingAisle): FridgeZone {
  switch (aisle) {
    case '肉蛋水产':
      return '冷冻'
    case '蔬菜水果':
    case '蛋奶豆制品':
      return '冷藏'
    case '米面粮油':
    case '调味干货':
    case '其他':
      return '常温'
  }
}

/**
 * 勾选的保质期（天）：超过这个天数的勾**当作没勾**。
 *
 * 为什么有期限：清单是**一次次现算**的（F7-01），而这周勾掉的"葱"
 * 如果下周还亮着勾，用户会以为自己买过了——**宁可让他重新勾一次，
 * 也不要拿上周的勾当这周的**。7 天对应"一次采购的周期"量级。
 */
export const SHOPPING_CHECK_TTL_DAYS = 7

/** 勾选是否还在有效期内（过期 = 当作没勾，读取时顺手删掉） */
export function checkFresh(checkedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - checkedAt.getTime() < SHOPPING_CHECK_TTL_DAYS * 86_400_000
}

/** 自加条目的名字/数量校验（与冰箱那侧同一口径：名字必填、数量可空） */
export const EXTRA_NAME_MAX = 40
export const EXTRA_AMOUNT_MAX = 24

export function parseExtraName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) throw new BadRequestException('写个名字吧')
  if (name.length > EXTRA_NAME_MAX) throw new BadRequestException(`名字最多 ${EXTRA_NAME_MAX} 个字`)
  return name
}

export function parseExtraAmount(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw new BadRequestException('数量得是一句话')
  const amount = raw.trim()
  if (!amount) return null
  if (amount.length > EXTRA_AMOUNT_MAX) throw new BadRequestException(`数量最多 ${EXTRA_AMOUNT_MAX} 个字`)
  return amount
}

/** 水的各种写法 */
const WATER_NAMES = new Set([
  '水', '清水', '温水', '开水', '热水', '凉水', '凉开水', '纯净水', '冰水', '冷开水', '滚水', '沸水', '白开水',
])

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
  /**
   * 这一条是**用户自己加的**（F7-03「增减条目」），不是菜单推出来的。
   *
   * 界面据此给一个"删掉"的入口：菜单推出来的条目不能删（删了下次请求又回来，
   * 而且它本来就该在那儿——要它消失得去改菜单）；自加的是用户自己写的，得能收回。
   */
  extra?: boolean
  /**
   * 自加条目的数据库 id（**只有 `extra: true` 的才有**）。
   *
   * 删它需要它——界面拿这个 id 去 `DELETE /shopping-list/extras/:id`。
   * 菜单推出来的条目**没有 id**（它们每次现算，没有稳定身份），
   * 所以这个字段**缺省就是"不能删"**，不需要额外再判一次 `extra`。
   */
  extraId?: string
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
