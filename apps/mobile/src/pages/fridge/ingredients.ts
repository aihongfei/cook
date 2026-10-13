import type { FridgeZone } from '@/api/fridge'

/**
 * 内置常用食材库（M6 / F6-03「手动录入 + 常用食材库快选」）。
 *
 * 为什么要有一份内置的：用户录冰箱时手里拿着菜、站在冰箱前，**打字是全流程最慢的一步**。
 * 常见食材点一下就进，比让人一个个打"西兰花""西红柿"快得多（也让同一个东西不会因为
 * 打错字变成两条——虽然后端按名字去重，但"西蓝花/西兰花"这种是同一个人两次都可能写出不同版本）。
 *
 * 每条都配一张手绘图（`/img/ingredients/<id>.png`，见该目录的说明与生成方式）：
 * 冰箱是**视觉**的界面（将来 F17-02 的 3D 预览更是），一列纯文字目录在这里尤其难扫。
 *
 * `zone` 是**默认存放区**（选完还能改）：常温和冷藏最常搞混（土豆、洋葱、蒜其实该放常温），
 * 给一个符合常识的默认值，比让用户每次都要选一遍强。
 *
 * `amount` 是常见数量提示（选完仍可改）：不填也得能用，但冰箱里有"几个/几盒"的概念时，
 * 给一个能直接用的量比让人现编更省事。
 */
export interface IngredientPreset {
  id: string
  /** 与图文件名一致（`/img/ingredients/<id>.png`） */
  name: string
  /** 常见别名，用于搜索（"西蓝花"要能搜到"西兰花"） */
  aliases?: string[]
  zone: FridgeZone
  /** 常见数量，如「一盒」「两个」 */
  amount?: string
}

/**
 * 48 样常见食材，按"进冰箱时最容易拿到什么"分组排列。
 *
 * 为什么不按品类（蔬菜/肉类/蛋奶）分：用户录东西时的顺序是**他手上拿的顺序**，
 * 不是教科书分类；而且四档存放区本来就是更实用的分组（见 zone）。
 * 这里的分组只用于界面上的小标题，不参与存储。
 */
export const INGREDIENT_PRESETS: { group: string; items: IngredientPreset[] }[] = [
  {
    group: '蛋奶豆',
    items: [
      { id: 'egg', name: '鸡蛋', aliases: ['蛋'], zone: '冷藏', amount: '一盒' },
      { id: 'milk', name: '牛奶', aliases: ['奶'], zone: '冷藏', amount: '一盒' },
      { id: 'yogurt', name: '酸奶', zone: '冷藏', amount: '一杯' },
      { id: 'tofu', name: '豆腐', zone: '冷藏', amount: '一块' },
    ],
  },
  {
    group: '蔬菜',
    items: [
      { id: 'tomato', name: '西红柿', aliases: ['番茄'], zone: '冷藏', amount: '两个' },
      { id: 'cucumber', name: '黄瓜', zone: '冷藏', amount: '一根' },
      { id: 'bokchoy', name: '小白菜', aliases: ['青菜', '油菜'], zone: '冷藏', amount: '一把' },
      { id: 'napa', name: '大白菜', zone: '冷藏', amount: '半颗' },
      { id: 'spinach', name: '菠菜', zone: '冷藏', amount: '一把' },
      { id: 'broccoli', name: '西兰花', aliases: ['西蓝花'], zone: '冷藏', amount: '一颗' },
      { id: 'carrot', name: '胡萝卜', zone: '冷藏', amount: '两根' },
      { id: 'potato', name: '土豆', aliases: ['马铃薯'], zone: '常温', amount: '两个' },
      { id: 'onion', name: '洋葱', zone: '常温', amount: '一个' },
      { id: 'pepper', name: '青椒', zone: '冷藏', amount: '两个' },
      { id: 'shiitake', name: '香菇', zone: '冷藏', amount: '几朵' },
      { id: 'corn', name: '玉米', zone: '冷藏', amount: '一根' },
    ],
  },
  {
    group: '肉蛋水产',
    items: [
      { id: 'pork', name: '五花肉', aliases: ['猪肉'], zone: '冷冻', amount: '一块' },
      { id: 'ribs', name: '排骨', zone: '冷冻', amount: '一份' },
      { id: 'chicken', name: '鸡胸肉', aliases: ['鸡肉'], zone: '冷冻', amount: '一块' },
      { id: 'beef', name: '牛肉', zone: '冷冻', amount: '一块' },
      { id: 'fish', name: '鱼', aliases: ['鲜鱼', '整鱼'], zone: '冷冻', amount: '一条' },
      { id: 'shrimp', name: '虾', aliases: ['大虾', '鲜虾'], zone: '冷冻', amount: '一份' },
      { id: 'squid', name: '鱿鱼', zone: '冷冻', amount: '一份' },
      { id: 'clam', name: '蛤蜊', aliases: ['花蛤'], zone: '冷藏', amount: '一份' },
    ],
  },
  {
    group: '主食',
    items: [
      { id: 'rice', name: '大米', aliases: ['米'], zone: '常温', amount: '一袋' },
      { id: 'noodles', name: '挂面', aliases: ['面条'], zone: '常温', amount: '一包' },
      { id: 'flour', name: '面粉', zone: '常温', amount: '一袋' },
      { id: 'bread', name: '面包', zone: '常温', amount: '一袋' },
    ],
  },
  {
    group: '调味',
    items: [
      { id: 'soy', name: '生抽', aliases: ['酱油'], zone: '常温', amount: '一瓶' },
      { id: 'vinegar', name: '醋', zone: '常温', amount: '一瓶' },
      { id: 'oil', name: '食用油', aliases: ['油'], zone: '常温', amount: '一桶' },
      { id: 'salt', name: '盐', zone: '常温', amount: '一罐' },
      { id: 'sugar', name: '糖', aliases: ['白糖', '砂糖'], zone: '常温', amount: '一罐' },
      { id: 'sesameoil', name: '香油', zone: '常温', amount: '一瓶' },
      { id: 'oyster', name: '蚝油', zone: '常温', amount: '一瓶' },
      { id: 'douban', name: '豆瓣酱', zone: '常温', amount: '一罐' },
      { id: 'ginger', name: '姜', aliases: ['生姜'], zone: '常温', amount: '一块' },
      { id: 'garlic', name: '蒜', aliases: ['大蒜'], zone: '常温', amount: '几瓣' },
      { id: 'scallion', name: '葱', aliases: ['小葱', '大葱'], zone: '冷藏', amount: '一把' },
      { id: 'chili', name: '干辣椒', aliases: ['辣椒'], zone: '常温', amount: '一把' },
    ],
  },
  {
    group: '水果',
    items: [
      { id: 'apple', name: '苹果', zone: '冷藏', amount: '两个' },
      { id: 'banana', name: '香蕉', zone: '常温', amount: '一把' },
      { id: 'orange', name: '橙子', zone: '冷藏', amount: '两个' },
      { id: 'lemon', name: '柠檬', zone: '冷藏', amount: '一个' },
      { id: 'strawberry', name: '草莓', zone: '冷藏', amount: '一盒' },
      { id: 'grape', name: '葡萄', zone: '冷藏', amount: '一串' },
      { id: 'pear', name: '梨', zone: '冷藏', amount: '两个' },
      { id: 'watermelon', name: '西瓜', zone: '冷藏', amount: '半个' },
    ],
  },
]

/** 所有预设（打平，含分组信息） */
export const ALL_PRESETS: IngredientPreset[] = INGREDIENT_PRESETS.flatMap((group) => group.items)

/** 图片路径：与预设 id 一一对应（生成与裁剪方式见 `public/img/ingredients/README.md`） */
export function ingredientImage(id: string): string {
  return `/img/ingredients/${id}.png`
}

/**
 * 按名字找预设对应的图（用户自己打的字也要能出图）。
 *
 * 匹配顺序：**完全同名 → 别名命中**。不做模糊/子串匹配：把「蒜」匹配到「蒜苗」、
 * 或把「葱」匹配到「洋葱」都会给出**错的图**，而错图比没有图更糟（用户会以为自己记错了）。
 * 找不到就返回 null，界面退回一个中性的占位（不假装知道那是什么）。
 */
export function findPresetByName(name: string): IngredientPreset | null {
  const text = name.trim()
  if (!text) return null
  const exact = ALL_PRESETS.find((item) => item.name === text)
  if (exact) return exact
  return ALL_PRESETS.find((item) => item.aliases?.includes(text)) ?? null
}

/** 搜索预设（录制抽屉里用）：名字或任意别名包含关键词 */
export function searchPresets(keyword: string): IngredientPreset[] {
  const text = keyword.trim()
  if (!text) return ALL_PRESETS
  return ALL_PRESETS.filter(
    (item) => item.name.includes(text) || item.aliases?.some((alias) => alias.includes(text)),
  )
}
