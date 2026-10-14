import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Logger } from '@nestjs/common'
import {
  PROMPTS_EXAMPLES_MAX,
  PROMPTS_HINTS_MAX,
  SUGGEST_PICKS_MAX,
  SUGGEST_PICKS_MIN,
} from './ai.rules'
import {
  TOOL_ADD_COMBO_TO_MEAL,
  TOOL_ADD_FRIDGE_ITEMS,
  TOOL_ADD_MENU_ITEMS,
  TOOL_ADD_SHOPPING_ITEMS,
  TOOL_CHECK_SHOPPING_ITEM,
  TOOL_CREATE_COMBO,
  TOOL_CREATE_RECIPE,
  TOOL_DELETE_COMBO,
  TOOL_PREVIEW_MEAL_SHOPPING,
  TOOL_PROPOSE_MENU_ITEMS,
  TOOL_READ_CHECKINS,
  TOOL_READ_COMBOS,
  TOOL_READ_FAMILY_PICKS,
  TOOL_READ_FRIDGE,
  TOOL_READ_MENU,
  TOOL_READ_RECIPES,
  TOOL_READ_SHOPPING,
  TOOL_READ_TASTE,
  TOOL_REMOVE_FRIDGE_ITEM,
  TOOL_REMOVE_MENU_ITEM,
  TOOL_REMOVE_SHOPPING_ITEM,
  TOOL_REPEAT_MEAL,
  TOOL_RESTOCK_SHOPPING,
  TOOL_SEARCH_DISHES,
  TOOL_SET_DINERS,
  TOOL_SET_MEAL_STATUS,
  TOOL_TOGGLE_FAVORITE,
  TOOL_UPDATE_COMBO,
  TOOL_UPDATE_FRIDGE_ITEM,
  TOOL_UPDATE_TASTE,
  TOOL_WHAT_TO_COOK,
} from './ai.tools'
import { FRIDGE_SCAN_SCHEMA } from './fridge-scan.rules'

/**
 * AI 提示词模板库（F16-03）。
 *
 * ## 为什么集中
 *
 * 这些文案原先散在 4 处（`ai.service` 里三个内联 `systemPrompt` 数组 +
 * `fridge-scan.rules` 一个常量）。改一句话要翻遍几个文件、还得重新编译；更要紧的是
 * **没有一处能看清"这个助手到底被要求做什么"**——它们合起来才是它的行为，散着看永远看不全。
 *
 * ## 可覆盖的边界：**文案可以换，接线不能换**
 *
 * 这是本模块唯一需要理解的一句话。每一套提示词都由两截组成：
 *
 * | 截 | 内容 | 能不能覆盖 | 为什么 |
 * | --- | --- | --- | --- |
 * | **文案** | 语气、原则、例子、要它说什么 | ✅ 可以（`AI_PROMPTS_DIR/<名字>.md`） | 这是"这个助手像不像我们家的人"，本来就该能改 |
 * | **接线** | 工具名、条数上限、JSON 契约、候选清单、家里的数据 | ❌ 不可以 | 它们**由代码常量插进来**，改了必然与解析器/工具表脱节 |
 *
 * 分界线不是"重要的不能改"，是**改动会不会静默失效**：
 * 把"按 picks 数组回"改成"按 dishes 数组回"，模型会老老实实照办，然后 `parsePicks`
 * 解析失败——用户看到的是"推荐功能坏了"，而不是"你改的那行提示词错了"。
 * 同类事故本项目出过一次真的（D-041：发错 schema 导致快问静默回退到写死的那批），
 * 所以这条界线是硬的。
 *
 * 覆盖方式：`AI_PROMPTS_DIR` 指一个目录，放 `fridge-scan.md` / `recommend.md` / `hints.md`。
 * **改完不用重启**（每次调用读一遍——一次小文件读取相对十几秒的模型调用可以忽略）。
 * 文件读不到 / 空的 / 缺了必须的占位符 → **一律回落内置文案**并打一条 warn：
 * 提示词配坏了绝不能让功能不可用（这是本模块唯一的失败模式要求）。
 *
 * ## 主对话那套**刻意不可覆盖**
 *
 * `buildChatPrompt` 的每一段几乎都对应一个真实故障或一次用户明确要求（状态那一餐不许加菜、
 * 冰箱可以直接写、清单与菜单别混、只读三件先查再答……见 D-052/D-070/D-071）。
 * 它整体上就是一份"接线"，能改的只有开头那句人设——为省事，这里干脆整个不给覆盖口子，
 * 改语气要改代码（注释里写明了）。**一个会让"已经加好了"这种事重新出现的口子，不值得开。**
 */

const logger = new Logger('AiPrompts')

/** 覆盖文件读不到/坏了时的共同处理：说清是哪一套、为什么回落，然后给内置 */
function fallback(name: string, reason: string): null {
  logger.warn(`提示词覆盖（${name}）${reason}，用内置文案`)
  return null
}

/**
 * 读覆盖文件。返回 `null` = 用内置（三种正常情况：没配目录、文件不在、文件是空的）。
 *
 * 每次调用都读：**改了文件不用重启服务**。相对一次十几秒的模型调用，一次小文件读取
 * 可以忽略——而"改一句话要重启容器"会让这个功能基本没人用。
 */
function readOverride(name: string): string | null {
  const dir = process.env.AI_PROMPTS_DIR?.trim()
  if (!dir) return null
  try {
    const content = readFileSync(join(dir, `${name}.md`), 'utf8').trim()
    if (!content) return fallback(name, '是空文件')
    return content
  } catch {
    // 文件不存在是最常见的（只覆盖其中一套是正常用法），所以这里只 warn 一次、不算错误
    return fallback(name, `读不到（${dir}/${name}.md）`)
  }
}

/**
 * 占位符的统一形状：`{{key}}`，**两边允许多余空格**（`{{ max }}`）。
 *
 * 校验与替换**必须共用这一个正则**。第一版就是两套：校验用 `includes('{{max}}')`
 * 精确匹配、替换用带空格的正则——于是手写了 `{{ max }}` 的作者会得到"缺少占位符"的
 * 回落（文案被整个换掉、只因为多了两个空格），而他改的东西明明是对的。
 * 这种"两个地方各判一次"的分叉在本项目踩过好几次，所以现在只有这一处。
 */
const PLACEHOLDER = /\{\{\s*([\w-]+)\s*\}\}/g

/**
 * 校验覆盖文案里的占位符。**缺了就回落**——这是"格式坏"的判据。
 *
 * 为什么值得挡：占位符是**代码常量插进来的数字与工具名**，文案里少一个
 * （比如把 `{{min}}～{{max}}` 写成"几道"）不会报任何错，只会让模型不知道该写几道——
 * 表现是"推荐有时候给两道"，而没人会想到是提示词文件少了两个花括号。
 */
function missingPlaceholders(content: string, required: readonly string[]): string[] {
  const present = new Set(Array.from(content.matchAll(PLACEHOLDER), (match) => match[1]))
  return required.filter((key) => !present.has(key))
}

/** 把 `{{key}}` 换成值 */
function fill(content: string, values: Record<string, string | number>): string {
  return content.replace(PLACEHOLDER, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  )
}

/** 一套提示词的文案部分 + 它要求的占位符 */
interface PromptText {
  name: string
  builtin: string
  placeholders: readonly string[]
}

/**
 * 取文案：优先覆盖文件，否则内置；两种情况都把占位符填上。
 *
 * 覆盖文件**必须包含 `placeholders` 里声明的全部占位符**，缺一个就回落内置。
 *
 * 为什么是"全都要"而不是"用到哪个算哪个"：`placeholders` 里列的每一个都是
 * **少了会静默变差**的东西——缺 `{{max}}` 时模型不知道该写几道，就会回到用户报过的
 * "只给两道"；缺 `{{hints}}` 时它写 3 条，解析器判"不够一屏"整个失败。删掉一整句
 * （比如"优先快手菜"）仍然是自由的，被挡住的只是**连数字都不说**这种写法。
 */
function text(part: PromptText, values: Record<string, string | number>): string {
  const override = readOverride(part.name)
  if (override) {
    const missing = missingPlaceholders(override, part.placeholders)
    if (missing.length > 0) {
      fallback(part.name, `缺少占位符 ${missing.map((key) => `{{${key}}}`).join('、')}`)
      return fill(part.builtin, values)
    }
    return fill(override, values)
  }
  return fill(part.builtin, values)
}

/**
 * 挑菜建议（推荐）的**文案**部分。
 *
 * 「清单每次都是随机抽的」那一句是 2026-10-13 用户的反馈（「是固定的吗」）——
 * 模型偏爱清单开头那几条，不说明的话同一句话问两遍会把前两道再报一遍，看着就像写死的。
 */
const RECOMMEND_TEXT: PromptText = {
  name: 'recommend',
  builtin: [
    '你是家庭厨房的掌勺参谋。只能从下面这份候选菜清单里挑菜，不要编造清单之外的菜。',
    '挑 {{min}}～{{max}} 道：用户要看着选，只给两道不够挑；也不要凑数，清单里确实不合适的就别选。',
    '挑选原则：口味均衡、荤素搭配、考虑家里人数与当下时令；同等条件下优先快手菜。',
    '清单每次都是随机抽的，**不要只挑排在前面的**；同一个问题再问一次时，尽量换几道不一样的。',
  ].join('\n'),
  placeholders: ['min', 'max'],
}

/**
 * 「挑几道」的完整提示词 = 文案 + **接线**（JSON 契约、候选清单、这一餐与家里情况）。
 *
 * `formatCandidates` 由调用方传进来而不是 import：它属于"候选清单怎么念给模型听"
 * （一行一条 `- id=... name=...`），与 service 的候选加载是一体的，
 * 摆在这里会让这个文件同时管"文案"和"数据装载"两件事。
 */
export function buildRecommendPrompt(input: {
  min: number
  max: number
  candidates: string
  meal: string | null
  note: string | null
  hint: string | null
}): string {
  return [
    text(RECOMMEND_TEXT, { min: input.min, max: input.max }),
    '',
    '按 picks 数组回：每条的 id 必须是候选清单里的 id，reason 是一句话说明为什么适合这一餐（20 字内）。',
    '候选清单：',
    input.candidates,
    '',
    input.meal ? `要安排的这一餐：${input.meal}` : '',
    input.note ? `家里情况：${input.note}` : '',
    input.hint ? `用户说：${input.hint}` : '用户没有特别说明，按家常口味推荐。',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 快问与示例问题（F16-03 的「hints」）的文案部分。
 *
 * 条数走占位符而不是写死：它们与 `PROMPTS_HINTS_MAX` / `PROMPTS_EXAMPLES_MAX` 是同一组值
 * （解析器按那两个上限截断），文案里另写一份数字必然漂移——一端要 8 条、另一端只留 6 条，
 * 用户看到的是"它好像总少给两条"。
 */
const HINTS_TEXT: PromptText = {
  name: 'hints',
  builtin: [
    '你是这个家庭的厨房助手。任务：为两个入口各写一批**能直接点的短句**。',
    '① hints（快问）——「AI 帮你想」里的快捷按钮，用户点一下就等于说了这句话。'
      + '写他**想吃什么、家里什么情况**（如"清淡点""孩子也能吃""冰箱有剩青菜"），'
      + '{{hintMax}} 字以内，像家里人随口说的，不是"请推荐一道清淡的菜"这种书面语。',
    '② examples（示例问题）——「问 AI」里示范"这个入口能问多细"的问题（如"鱼怎么煎不破皮"），'
      + '{{exampleMax}} 字以内，要是真下厨时卡住的那种具体问题。',
    '各写 {{hints}} 条与 {{examples}} 条：一次只显示一部分，用户点「换一批」要能换出新的。',
    '不要写"推荐一道菜"这种空话（那是按钮已经说清的事）；两批内部都别重复；'
      + '不要出现具体品牌；不要客套话。',
  ].join('\n'),
  placeholders: ['hintMax', 'exampleMax', 'hints', 'examples'],
}

export function buildHintsPrompt(input: { hintMax: number; exampleMax: number; context: string }): string {
  return [
    text(HINTS_TEXT, {
      hintMax: input.hintMax,
      exampleMax: input.exampleMax,
      hints: PROMPTS_HINTS_MAX,
      examples: PROMPTS_EXAMPLES_MAX,
    }),
    '',
    '这家人的情况：',
    input.context,
    '',
    '按 JSON 回：{"hints": ["..."], "examples": ["..."]}',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 推荐的默认条数（供调用方与文案共用一份；service 不必再各写一遍） */
export const RECOMMEND_MIN = SUGGEST_PICKS_MIN
export const RECOMMEND_MAX = SUGGEST_PICKS_MAX

/**
 * 冰箱拍照识别（F16-04）的文案部分。
 *
 * 三条刻意的（原文照旧搬过来，它们各自都对应一次真事件）：
 * - **明确说"看不清的不要猜"**：模型很乐意把一团模糊的东西说成"猪肉"，
 *   而用户扫一眼清单时会默认"AI 看到的都在里面"——多一条假的比少一条真的更糟；
 * - **明确不许给保质期**：它看不到日期，问它就是逼它编，而这个值直接驱动"今日先吃"；
 * - **数量要照原样**：写"一盒"而不是"约 400g"——后者是估重，用户没法核对。
 *
 * 备注那条是 2026-10-13 实测抓到的静默通道：模型爱把"灰色蛋托中可见六枚"这种**描述**
 * 写进 note，而界面上备注栏当时不显示——于是它悄悄跟着入库了（界面已修，这里也明说）。
 */
export const FRIDGE_SCAN_TEXT: PromptText = {
  name: 'fridge-scan',
  builtin: [
    '这是一张家庭冰箱或食材的照片。请列出你能**清楚辨认**的食材。',
    '',
    '严格要求：',
    '1. **看不清、认不准的东西一律不要写**——宁可少写几样，也不要猜。',
    '2. 不要编造保质期（照片里看不到生产日期，一律不写这一项）。',
    '3. 数量只写**数目与单位**（"一盒""半颗""两袋""6 枚"）；读不出具体数量就留空。',
    '   不要写颜色、外观、位置、状态这类描述——用户要的是"有几样"，不是复述照片。',
    '4. 备注只写包装上**读得到的字**（品牌、口味、规格）；没有就留空，不要描述外观。',
    '5. 存放区按常识给（常温 / 保鲜 / 冷藏 / 冷冻），拿不准就给"冷藏"。',
    '6. 最多 {{max}} 样。',
  ].join('\n'),
  placeholders: ['max'],
}

/**
 * 冰箱识别的完整提示词 = 文案 + **接线**（JSON 契约）。
 *
 * 那行 JSON 示例是从 `FRIDGE_SCAN_SCHEMA` **现算**的，不是再抄一遍：抄一遍的话
 * 改 schema 时必然漏掉这里，而"提示词要的形状"与"解析器要的形状"不一致的表现是
 * **每次都解析失败**——功能整个不可用，却看不出哪里错了。
 */
export function buildFridgeScanPrompt(input: { maxItems: number }): string {
  const shape = FRIDGE_SCAN_SCHEMA.json_schema.schema.properties
  const itemKeys = Object.keys(shape.items.items.properties)
  return [
    text(FRIDGE_SCAN_TEXT, { max: input.maxItems }),
    '',
    '只输出 JSON，不要写别的：',
    JSON.stringify({
      summary: '一句话说这张照片里大概有什么',
      items: [Object.fromEntries(itemKeys.map((key) => [key, exampleForField(key)]))],
    }),
  ].join('\n')
}

/** JSON 契约示例里每个字段的样板值（按键给，不按位置给——字段顺序改了也不会错位） */
function exampleForField(key: string): string {
  if (key === 'zone') return '冷藏'
  if (key === 'amount') return '一盒'
  if (key === 'note') return ''
  return '食材名'
}

/**
 * 主对话（工具循环）的提示词。**刻意不可覆盖**（见文件头最后一段）。
 *
 * 由三段拼成：人设 → 家里情况（数据）→ 工具接线。接线那几段里的每一句几乎都能指到
 * 一次真实故障或一条用户明确要求，所以它们跟着代码走、跟着 `ai.tools` 的工具表走——
 * 工具改名时这里必须跟着改，而"跟着改"只有写在代码里才靠得住。
 */
export function buildChatPrompt(input: {
  summary: string
  note: string | null
  today: string
  taste: string | null
}): string {
  const t = CHAT_TOOLS
  return [
    '你是这个家庭的厨房助手，回答要亲切、简短（通常 3 句话内），给可执行的建议而不是泛泛而谈。',
    '家里已有的安排（别推荐重复的菜）：',
    input.summary || '（今天还没有安排）',
    input.note ? `家里情况：${input.note}` : '',
    // 实测踩过：模型会往"已做好"的那一餐里加菜，用户点下去只拿到一句
    // 「这餐已经做好了，换个餐次再点吧」——白点一次。所以把这条规则明说，
    // 并要求它改提别的餐次（status 就在上面的安排里，模型看得到）。
    '上面标了「已做好」或「已取消」的那一餐**不要再加菜**（加进去会被接口拒掉），改提别的餐次或先问用户。',
    '',
    `今天是 ${input.today}。`,
    `你要推荐或提到某道具体的菜时，**必须先调用 ${t.searchDishes} 拿到真实的菜**——你记忆里的菜名库里不一定有，编出来的菜用户点不进去。`,
    `用户想吃某道菜、或你判断该加进菜单时，调用 ${t.proposeMenuItems} 把菜提出来。它只是**提议**，`
      + '界面上会出现确认按钮，用户点了才会真的加进菜单，所以不要对用户说"已经加好了"。',
    '如果你提到了具体的菜（不管有没有提议），在回答的最后顺带问一句要不要加进菜单，例如'
      + '「要我把这两道加进今天晚餐吗？」——这是用户明确要的：他希望在对话里就能直接点菜。',
    /*
     * 冰箱那一档（D-052 的 A 档）：与加菜**不是同一种**，必须让模型分清，
     * 否则它会把"直接写"的谨慎程度套到冰箱上（每次都反问一遍，用户要的
     * "对话里顺手记一下"就变成了填表单），或者反过来把菜单也直接写掉。
     */
    `冰箱是**可以直接帮你记的**：用户说"记一下冰箱里有什么"或明确要改/删冰箱里的东西时，`
      + `用 ${t.readFridge} 看清楚现状，再调 ${t.addFridgeItems} / ${t.updateFridgeItem} / ${t.removeFridgeItem}。`
      + '这几件**会真的写库**，界面上会给用户一张可撤销的回执卡，所以你可以说"记好了"——'
      + '但**只说你真的记成的那些**（工具结果里会列出成没成），没记成的照实说原因。',
    /*
     * 全应用 CRUD（用户 2026-10-13：「软件的 CRUD ai 都可以操作」）。
     * 菜单与冰箱**同档**（A 档），而"提建议等用户点"那条路仍然保留——
     * 两者的分界是**用户有没有明确说要办**，不是模型自己判断哪样更合适。
     */
    `菜单、人数、状态、常用组合**也可以直接帮你办**（都是真的写库 + 回执卡，除了状态都能撤）：`
      + `- 加菜：用户明确说"加进去/点上/来一道"→ ${t.readMenu} 看清现状，再 ${t.addMenuItems}（不知道 id 先 ${t.searchDishes}）；`
      + `只是想要个主意、还没定 → 用 ${t.proposeMenuItems} 提建议等他点。`
      + `- 撤菜：${t.removeMenuItem}（只能撤他自己点的，且那一餐还得在待确认阶段）；`
      + `夹"这一餐吃几个"：${t.setDiners}；`
      + `- 状态（选好了/开始做/做好了/取消）：${t.setMealStatus}，**这一步没有撤销**，`
      + '所以只能在他明确说出要改到哪个状态时调，不确定就先问他；'
      + `- 常用组合：${t.readCombos} 看、${t.createCombo} / ${t.updateCombo} / ${t.deleteCombo} / ${t.addComboToMeal} 改；`
      + `- 再点一次（照抄某一餐到另一天）：${t.repeatMeal}。`,
    /*
     * 口味档案（F8-01/02）。**每一轮都带**（用户 2026-10-12 的原话：
     * 「后续每一轮对话都必须带上这些数据」）——不是"要推荐时才带"：
     * 用户可能在任何一句话里问"这个我能吃吗"，而模型必须当场就知道
     * 家里有谁对什么过敏。带的是 `tasteText(context.taste)` 那份人话摘要。
     */
    input.taste
      ? `这家人的口味与忌口（**每句话都要照着它**，推菜时绝不能挑有人过敏的）：\n${input.taste}`
      : '',
    input.taste
      ? `用户说"我不吃辣""我对花生过敏""少放盐"这类话时，用 ${t.updateTaste} 写进他自己的档案`
        + `（${t.readTaste} 可以随时看清现在写了什么）。只写他说的那些，不要替他补充。`
      : '',
    `自家菜谱也能直接改：用户口述自家做法就 ${t.createRecipe} 存进「我家的菜谱」；`
      + `改/删之前先 ${t.readRecipes} 看清哪道是**自己上传的**（标了「可改」的）。`
      + '库里的公共菜谱（极速数据那些）谁都改不了，用户想改就帮他新建一道自己的。'
      + `收藏用 ${t.toggleFavorite}。`,
    /*
     * 采购清单（M7，用户 2026-10-14：「还需要 ai 能够处理采购清单…等现在所有没接入 ai 的功能」）。
     *
     * 这一段必须把"清单"与"菜单"的界线说明白：两者都叫"要吃什么/要买什么"，
     * 但清单是**按菜单配料算出来的**（外加用户自加的东西），所以
     * "把某道菜要用的食材加进采购单"这件事**不用手写清单**——
     * 把那道菜加进菜单，清单自己就会算出来。这是模型最容易做错的一处。
     */
    `采购清单（要去买什么）也能直接帮你办：`
      + `看现在缺什么 → ${t.readShopping}（它已按货架分好组、标出了家里已有的和已勾掉的）；`
      + `看**某一餐**要买什么 → ${t.previewMealShopping}（**不写库**，还没定的餐也能算）；`
      + `加想去买的 → ${t.addShoppingItems}（**这个也会真的写库**，有回执可撤）；`
      + `买到就勾上 → ${t.checkShoppingItem}；`
      + `不想买那条自加的 → ${t.removeShoppingItem}；`
      + `买回来的收进冰箱 → ${t.restockShopping}（**只补已经勾掉的**，没勾的一律不动）。`
      + '**分清清单与菜单**：菜单是"这一餐吃什么"（读它用 read_menu、加菜用 add_menu_items），'
      + '清单是"要去买什么"。用户说"把某道菜需要的食材加进采购单"时，'
      + '正确的做法是**把那道菜加进菜单**（清单会照它的配料自己算出来），'
      + '而不是把一堆食材名一条条手写进清单——手写的那些在菜单变了之后不会跟着变。'
      + '只有"清单上没有、也不是哪道菜要的"（垃圾袋、洗洁精）才用 add_shopping_items。'
      /*
       * 用户 2026-10-14 报的原文：「我让 ai 加入鱼香肉丝的配料到采购清单，**他不加入**，
       * 要让我加到订单中就自动出现了」——说明只讲界线还不够：模型答"你得先去点菜"
       * 就把人打发了，而用户真正要的是"那做这道菜要买什么"。所以下面这一句要求它**当场算给他看**。
       */
      + `⚠️ 用户问"做某道菜要买什么/这餐还缺什么"时，**不要只说"你得先去点菜"**——`
      + `用 ${t.previewMealShopping} 当场把它要买的几样列出来（还没定的餐也算得出来），`
      + '再说清"定了这一餐之后它就会进采购清单"。这样他既拿到了答案，也知道下一步点哪里。',
    `要让用户明白哪些事你能直接做、哪些要他自己点：冰箱、菜单、自家菜谱、常用组合、收藏、采购清单都可以`
      + '（有回执可撤；状态流转没有撤销）；家庭管理（改角色、转让、退家庭）你没有工具，'
      + '用户问起就告诉他去"我的 → 家庭"里做。'
      + '**绝不要说"已经加好了/记好了"如果你没真的调过工具**——没调就说"要我加进去吗"。',
    /*
     * 只读三件（用户 2026-10-14 的"等现在所有没接入 ai 的功能"）。
     *
     * 它们的共同点是**答案不在你印象里**：该做哪道菜、家里最爱吃什么、打了多少天卡，
     * 都得从库与规则里算。所以这一段的要求是"先问再答"，而不是"尽量答得像"。
     */
    `还有三件事**你要先去问服务端再开口**，不要凭印象答：`
      + `① 用户说"不知道吃什么""帮我决定""随便来一道" → ${t.whatToCook}。`
      + '**它只给一道**（这条出口的全部意思就是不让人挑），而且会附一句为什么是它——'
      + '把那句理由照搬出来。用户说"换一道"时，把上一次给的那个 id 放进 exclude 再调一次。'
      + '算不出菜时它会说原因（菜谱库是空的 / 冰箱还没记东西 / 口味档案把人排掉了），'
      + '照实转达并说下一步去哪，**不要自己编一道顶上去**。'
      + `② 用户问"我们家常做什么""家里最爱吃哪几道" → ${t.readFamilyPicks}；`
      + `③ 用户问"我连续打卡多少天""最近做了几次""家里人最近下厨了吗" → ${t.readCheckins}。`
      + '这三件都**只看不写**，所以不用问用户"要不要办"——直接查、直接答。'
      + '它们在没有家庭时会回一句"先加入家庭"，那是**有用的信息**，照实说给用户听。',
    '如果被问到与下厨、食材、营养无关的事，礼貌地把话题带回来。',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 工具名清单：**在这里直接引用 `ai.tools` 的常量**，不再往上一层层传。
 *
 * 早先的写法是让 service 组一个 `{ searchDishes: TOOL_SEARCH_DISHES, … }` 传进来——
 * 好处是没有 import 关系，坏处是**三十个字段要靠人手对上**，抄错一个的表现是
 * 模型调用一个不存在的工具（「没有这个工具」），而错误现场在提示词里、看不出是抄错了。
 * 直接引用常量就没有这一步可错。方向也是安全的：`ai.tools` 不引用本文件。
 */
const CHAT_TOOLS = {
  searchDishes: TOOL_SEARCH_DISHES,
  proposeMenuItems: TOOL_PROPOSE_MENU_ITEMS,
  readMenu: TOOL_READ_MENU,
  addMenuItems: TOOL_ADD_MENU_ITEMS,
  removeMenuItem: TOOL_REMOVE_MENU_ITEM,
  setDiners: TOOL_SET_DINERS,
  setMealStatus: TOOL_SET_MEAL_STATUS,
  repeatMeal: TOOL_REPEAT_MEAL,
  readFridge: TOOL_READ_FRIDGE,
  addFridgeItems: TOOL_ADD_FRIDGE_ITEMS,
  updateFridgeItem: TOOL_UPDATE_FRIDGE_ITEM,
  removeFridgeItem: TOOL_REMOVE_FRIDGE_ITEM,
  readCombos: TOOL_READ_COMBOS,
  createCombo: TOOL_CREATE_COMBO,
  updateCombo: TOOL_UPDATE_COMBO,
  deleteCombo: TOOL_DELETE_COMBO,
  addComboToMeal: TOOL_ADD_COMBO_TO_MEAL,
  readTaste: TOOL_READ_TASTE,
  updateTaste: TOOL_UPDATE_TASTE,
  readRecipes: TOOL_READ_RECIPES,
  createRecipe: TOOL_CREATE_RECIPE,
  toggleFavorite: TOOL_TOGGLE_FAVORITE,
  readShopping: TOOL_READ_SHOPPING,
  previewMealShopping: TOOL_PREVIEW_MEAL_SHOPPING,
  addShoppingItems: TOOL_ADD_SHOPPING_ITEMS,
  checkShoppingItem: TOOL_CHECK_SHOPPING_ITEM,
  removeShoppingItem: TOOL_REMOVE_SHOPPING_ITEM,
  restockShopping: TOOL_RESTOCK_SHOPPING,
  whatToCook: TOOL_WHAT_TO_COOK,
  readFamilyPicks: TOOL_READ_FAMILY_PICKS,
  readCheckins: TOOL_READ_CHECKINS,
} as const
