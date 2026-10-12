import { sample } from './random-sample'

/**
 * 两个 AI 入口的示例提示（M16 / D-026）。
 *
 * **写死的这两份现在是兜底**（用户 2026-10-12：「这块也要使用ai吧，内置的这些不够用」）：
 * 正常路径是后端按这家人的情况现生成一批（`/ai/prompts`，见 api/ai 的 useAiPrompts），
 * 从模型给的那批里抽；模型没配、还没生成好、生成失败时才用下面的池子——
 * 宁可给一组通用示例，也不能让入口空着或显示出错。
 *
 * 池子故意比一次显示的条数大得多，每次打开抽一批（见 `pickHints` / `pickExamples`），
 * 于是"同一个入口每次点开看到的例子不一样"——固定三条的话，用户第二次就把它当装饰了。
 *
 * 池子里的说法都照着**家庭厨房的真实场景**写：材料怎么处理、量怎么拿、家里有谁吃、
 * 剩的东西怎么办。不写"推荐一道菜"这种空话——那是按钮已经说清的事。
 */

/** 「AI 帮你想」的快问（兜底）：点一下就等于替我打了这句话 */
export const HINT_POOL = [
  '清淡点',
  '快手菜',
  '想吃肉',
  '有客人来',
  '冰箱里有剩青菜',
  '想吃点酸的',
  '来点辣的',
  '想喝汤',
  '要有蔬菜',
  '想吃饱一点',
  '明天带饭',
  '想吃面食',
  '孩子也能吃',
  '剩饭怎么处理',
] as const

/** 一次显示 5 个快问（两行内放得下，再多就把输入框挤下去了） */
export const HINT_COUNT = 5

/** 「问 AI」的示例问题（兜底）：让人一眼看到这个入口能问多细 */
export const EXAMPLE_POOL = [
  '豆腐买多了怎么存',
  '两个人吃多少米',
  '怎么做不辣的川菜',
  '肉怎么去腥',
  '冻肉怎么快速解冻',
  '鸡蛋能放多久',
  '鱼怎么煎不破皮',
  '剩饭怎么热不干',
  '干香菇要泡多久',
  '排骨炖多久才烂',
  '菜太咸了怎么救',
  '土豆丝怎么不粘锅',
  '怎么做溏心蛋',
  '冰箱有味道怎么办',
] as const

/** 一次显示 3 个示例问题（多了会盖住输入框，反而不好问） */
export const EXAMPLE_COUNT = 3

/**
 * 抽一批快问（每次打开、每次「换一批」都调它）。
 *
 * `from` 传模型现生成的那批时，从它里面抽；没给（或给得不够一屏）就退回兜底池——
 * 后端已经保证"不够一屏会判失败"，所以这里的 `from` 要么是一整批、要么是 undefined，
 * 但仍做一次长度检查：**界面不该因为后端改了保证就出现半排空白**。
 */
export function pickHints(from?: readonly string[], random?: () => number): string[] {
  const pool = from && from.length >= HINT_COUNT ? from : HINT_POOL
  return sample(pool, HINT_COUNT, random)
}

/** 抽一批示例问题（同上） */
export function pickExamples(from?: readonly string[], random?: () => number): string[] {
  const pool = from && from.length >= EXAMPLE_COUNT ? from : EXAMPLE_POOL
  return sample(pool, EXAMPLE_COUNT, random)
}
