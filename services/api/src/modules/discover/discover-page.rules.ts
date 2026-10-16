import { BadRequestException } from '@nestjs/common'

/**
 * 发现页「时令精选」与「换个场合挑」的纯规则（2026-10-16 定稿，见 D-110）。
 *
 * 「翻牌子」那一族（`FLIP_BATCH` / `parseFlipLimit`）原本也在这里，
 * 用户当天看完预览后定「不要翻牌子了」，随之删掉。
 *
 * 两块共用一条判据：**按标签精确取**（不是搜索）。原因的详细版在 recipe.query 的 tagList，
 * 这里只留一句最要紧的：界面上那个数字（「秋日时令 · 38 道」）用户拿来判断值不值得点进去，
 * 而它只能由"打了这个标签"这个稳定判据给出——搜索命中的是文本里出现过那两个季节字
 * （菜名、食材名都算），今天恰好对得上，明天库里来一道名字带"夏"的菜就不对了。
 */

/**
 * 季节 → 标签。**每个季节是一组标签的并集，不是一个**：库里同一个季节有两套叫法
 * （2026-10-16 实测：「夏季」51 + 「夏季菜谱」32 = 并集 79；「秋季」35 +「秋季菜谱」3 +
 * 「秋季养生」2 = 38）。
 *
 * 只取最正的那个会让夏秋少掉一大半——夏天 51 道看着像"这个季节没什么菜"，
 * 而其实有 79 道。标签名里的后缀（菜谱 / 养生）是导入源自己带的，不是我们能改的。
 */
export const SEASON_TAGS: Record<string, string[]> = {
  春: ['春季', '春季菜谱', '春季养生'],
  夏: ['夏季', '夏季菜谱', '夏季养生', '夏季饮食'],
  秋: ['秋季', '秋季菜谱', '秋季养生'],
  冬: ['冬季', '冬季菜谱', '冬季养生'],
}

/** 一句话说清这一块在推什么（跟着季节变，不是通用的"当季菜"） */
export const SEASON_NOTE: Record<string, string> = {
  春: '天暖了，这些正当时',
  夏: '天热，吃点清爽的',
  秋: '天凉了，这些正当时',
  冬: '天冷，来点热乎的',
}

/** 一句给菜谱小书的话：四季统一叫「X日时令」 */
export const SEASON_TITLE: Record<string, string> = {
  春: '春日时令',
  夏: '夏日时令',
  秋: '秋日时令',
  冬: '冬日时令',
}

/**
 * 发现页上「时令精选」横滑一屏给几道。
 *
 * 6 道不是随手定的：这一行是 116px 宽的卡（390 屏上正好露出 3 张半），
 * 6 张够滑两下，也够看出"这一季有什么"；给 20 张就变成菜谱列表的另一个入口了
 * （那一页有它自己的排序与筛选，也点得进去——这里只是橱窗）。
 */
export const SEASONAL_PREVIEW = 6

/**
 * 月份 → 季节。
 *
 * 用**公历月份**而不是节气（立春/秋分那套）：节气要查表，而这个模块给的是"这一季的菜"
 * ——三月初的一盘春笋不会因为"立春还没到"就变成冬天的菜。分界按 3/6/9/12 月。
 */
export function seasonOf(month: number): string {
  if (month >= 3 && month <= 5) return '春'
  if (month >= 6 && month <= 8) return '夏'
  if (month >= 9 && month <= 11) return '秋'
  return '冬'
}

/**
 * 场合词 → 标签。**这是「帮我决定」抽屉里那一行「换个场合挑」**（用户 2026-10-16 定的）。
 *
 * 四个词都是**午饭/晚饭能成立的场合**，这是硬约束：`MealSlot` 只有 `LUNCH | DINNER`，
 * 而这一行的结果会一路走到「就它了」→ 加进下一餐。所以「早上吃什么」（标签「早餐」83 道）
 * **不能进这一行**——点了它会挑出一道包子或粥，然后被加进晚饭。
 * （要支持早餐得先有早餐这个餐次，那是另一件事，不在这一次里做。）
 *
 * 数量都够（最少的 33 道）：不会有"点了是空的"。
 */
export interface Occasion {
  /** 界面上那三个字（用户的话，不是标签名） */
  label: string
  /** 库里真的标签 */
  tag: string
}

export const OCCASIONS: Occasion[] = [
  { label: '不想费劲', tag: '快手菜' },
  { label: '干饭要香', tag: '下饭菜' },
  { label: '来客人了', tag: '宴请' },
  { label: '做给孩子', tag: '儿童' },
]

/**
 * `occasion` 参数：只接受这一行里出现过的那几个**标签名**（不是"不想费劲"这种展示名）。
 *
 * 为什么接口收标签名而不是那四个字：展示名会改（用户已经在预览里改过一次叫法），
 * 而 URL 上那个值一旦发出去就有人保存/分享；标签名是库里的事实，稳定。
 *
 * 给了不在表里的值一律 400，**不退化成"当没给"**：静默忽略会让人以为"场合生效了"
 * 而结果其实没变，那种错查起来最费劲。
 */
export function parseOccasion(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string') throw new BadRequestException('occasion 只接受一个标签名')
  const tag = raw.trim()
  if (tag === '') return null
  const found = OCCASIONS.find((item) => item.tag === tag)
  if (!found) throw new BadRequestException('这个场合不认识')
  return found.tag
}

/** 场合的三个字（给那句话用）：有了它才能把理由说成"按你说的『不想费劲』挑的" */
export function occasionLabel(tag: string): string {
  return OCCASIONS.find((item) => item.tag === tag)?.label ?? tag
}

/**
 * 一句话说清"这一次是按场合挑的"。
 *
 * 拼在 `decideReason` **前面**（不是替掉它）：冰箱与家人信号那几句仍是真事，
 * 而"按你说的 X 挑的"回答的是另一个问题——用户刚点了一个词，他要看见那个词起作用了。
 * 两段都要，中间用分号。
 */
export function occasionReason(tag: string, base: string): string {
  return `按你说的「${occasionLabel(tag)}」挑的；${base}`
}

/** 月报：**不足这么多顿就不画**（见 monthlyReport 的说明） */
export const REPORT_MIN_MEALS = 3

export interface MonthlyReport extends MonthlyReportInput {
  /** 已经拼好的那句脚注 */
  line: string
}

export interface MonthlyReportInput {
  /** 本月一共安排了几餐（含还没做的） */
  meals: number
  /** 其中真的做好的几顿 */
  done: number
  /** 本月点过的菜，去重后几种 */
  kinds: number
  /** 本月打卡几张 */
  photos: number
  /** 本月做过最多次的那道菜（没有就是 null——新家庭不给编一个"最爱"） */
  topDish: string | null
  /** 那道菜最近一次是哪天（`M/D`，给那句脚注用） */
  topDishOn: string | null
}

/**
 * 本月做过最多的是哪道（`null` = 没有高下可分，或一道都没做过）。
 *
 * **平手时返回 null，不挑一个"第一个"**：两道菜各做过一次时，说"最常做的是红烧排骨"
 * 是假话（另一道也一样多），而用户会指着它问"那昨天的番茄炒蛋呢"。宁可不提这一句。
 *
 * `on` 取那道菜**最后一次**做的日期（`M/D`）：脚注里那句"（10/16）"要说的是
 * "那阵子你在做它"，而最近一次比第一次更有这个时间感。
 */
export function topDishOf(
  rows: readonly { name: string; count: number; lastOn: string }[],
): { name: string; on: string } | null {
  if (rows.length === 0) return null
  const best = [...rows].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'))[0]
  if (best.count < 2) return null
  // 平手（还有一道跟它一样多）时不给冠军
  if (rows.filter((row) => row.count === best.count).length > 1) return null
  return { name: best.name, on: best.lastOn }
}

/**
 * 家庭月报（发现页那一块）。口径：**"全家这个月过得怎么样"**——与「我的」页的个人热力图、
 * 「家人最爱」的菜榜单都不是一回事（那两个一个只算我、一个只排菜）。
 *
 * 三条刻意的：
 *
 * ① **不足 3 顿整块不画**（返回 null）。1 顿就报"一起吃了 1 顿"没有意义，还显得这一家冷清
 *    ——用户 2026-10-16 定「没有最爱就是没有」，这里同一条线：**没有就不画，不塞假的**。
 * ② **不给谁打分**：不写"谁做得最多"。家庭里这种数字容易变成比较，而这一块要说的是
 *    "我们一起过的这个月"。所以这里只有四个全家一起的数。
 * ③ **脚注只说真事，而且不给假的第一名**：真分出高下才提"最常做的是 X"（见 topDishOf）；
 *    做过几顿但每道只做过一次就说"每道都不一样"——那其实比一个硬凑的冠军更好听；
 *    一顿都没做就直说"还没开火"。
 */
export function monthlyReport(input: MonthlyReportInput): MonthlyReport | null {
  if (input.meals < REPORT_MIN_MEALS) return null

  const parts: string[] = []
  if (input.topDish) {
    parts.push(input.topDishOn ? `最常做的是 ${input.topDish}（${input.topDishOn}）。` : `最常做的是 ${input.topDish}。`)
  } else if (input.done === 0) {
    parts.push('这个月还没开火，安排上的菜做完就有记录了。')
  } else {
    parts.push(`做了 ${input.done} 顿，每道都不一样。`)
  }
  if (input.photos === 0) parts.push('拍张成品照，这里就有照片了。')

  return { ...input, line: parts.join('') }
}
