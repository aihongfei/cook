import { BadRequestException } from '@nestjs/common'

/**
 * 「帮我决定」（M5 / F5-05）的纯规则：**一群人都不想挑的时候，替他们挑一道**。
 *
 * 与其他 `*.rules.ts` 同一套路：不碰数据库的判定全在这里，单测直接验。
 *
 * ## 它和旁边那两条出路的分工
 *
 * 发现页那张卡上有三条出路，用户看到的是三个不同的**承诺**：
 * - 「摇一道」（F5-01）：**库里随机抽一道**。公平、立刻，但它不知道你家有什么、谁不吃什么
 *   ——摇到一道八样料缺六样的菜，用户还得自己判断"这做不了"；
 * - 「AI 帮你想」：**给几条让你挑**，要等十几秒，仍然要你自己选；
 * - 「帮我决定」（这里）：**只给一条，而且是你家此刻最该做的那条**。
 *
 * 所以这一条的定位是**零选择成本的兜底**：连"从几条里选一条"都省掉。这决定了三件事：
 * ① 只返回一道（返回三条就又变成"让用户挑"了）；② 它必须**懂这个家**（冰箱、口味、
 * 平时爱吃什么），否则与「摇一道」没有区别；③ 它必须**每次不一样**——同一个按钮连按
 * 两次给同一道菜，用户只会认为它坏了。
 *
 * ## 挑的顺序是"分档"，不是加权求和
 *
 * 档位从"此刻真能做"往"随便来一道"退，**先看能选的档里最好的那一档**，档内再排：
 *
 * | 档 | 什么情况 | 那句话 |
 * | --- | --- | --- |
 * | `ready` | 冰箱里现有东西就够（一样都不用买） | 冰箱里的 A、B 正好能做这道 |
 * | `near` | 差一样（顺路买一下就能做） | 差 X 一样，家里别的都有 |
 * | `favorite` | 家里做过 / 有人收着 | 你们家做过 3 次 |
 * | `any` | 都没有信号时兜底 | 库里挑的，今天换换口味 |
 *
 * **为什么不做加权求和**：一个分数算出来的选择没法解释——用户问"为什么给我推这个"，
 * 我们只能回答"综合得分最高"，那句话对用户没有价值。分档的答案是**具体事实**
 * （"冰箱里那盒豆腐明天到期"），而且能验。这也是 D-058 / D-059 里那一套"可解释优先"的延续。
 */

/** 最近这么多天内做过的菜，**尽量不再推荐**（有别的可选时） */
export const RECENT_DAYS = 7

/**
 * 抽签的窗口：定序后只看**前几名**，在这几名里随机。
 *
 * 两头都要防：窗口取 1（永远给第一名）会让按钮看起来坏了——每次都是同一道；
 * 窗口取满（在整个候选池里随机）就退回成「摇一道」，而且可能从"冰箱正好能做"
 * 一下掉到"差三样"。取前 5 名：既是好答案，又有变化。
 */
export const PICK_WINDOW = 5

/** 一句话里最多点几样食材名（点多了那句话就没人读了） */
const REASON_MAX_NAMES = 3

export type DecideTier = 'ready' | 'near' | 'favorite' | 'any'

export interface DecideCandidate {
  recipeId: string
  /** 菜名：同名去重要用它（库里 33 行重名，见 pantry.rules 的 rankMatches） */
  name: string
  /** 用上了冰箱里的哪几样（**按用户自己的说法**回显） */
  have: string[]
  /** 还差哪几样（不含调料） */
  missing: string[]
  /** 用上的食材里，有几样是"该先吃"的（已过期 / 三天内）——排在最前的一项理由 */
  soon: string[]
  /** 家里做过几次（按"餐"去重） */
  cooked: number
  /** 家里几个人收着 */
  favorites: number
  /** 最近一次做过是哪天（`YYYY-MM-DD`，没做过为 null） */
  lastCookedOn: string | null
}

/** 一道菜的"档"。判断只看冰箱与家人信号，不看分数。 */
export function tierOf(candidate: DecideCandidate): DecideTier {
  // 「一样都不用买」是这一整块唯一敢下的强结论（与 pantry.rules 文件头 ③ 同一条）
  if (candidate.have.length > 0 && candidate.missing.length === 0) return 'ready'
  // 差一样才是"顺路买一下"；差两样以上就不该由"帮我决定"替用户拍板了（他会白跑一趟）
  if (candidate.have.length > 0 && candidate.missing.length === 1) return 'near'
  if (candidate.cooked > 0 || candidate.favorites > 0) return 'favorite'
  return 'any'
}

const TIER_ORDER: Record<DecideTier, number> = { ready: 0, near: 1, favorite: 2, any: 3 }

/**
 * 排好序的候选（服务层补菜名/图之后就是接口要的那一条）。
 *
 * 排序**全部是可解释的量**，没有分数：
 * ① `soon` 多的在前（冰箱里的东西在往坏的方向走，先消耗掉它们）；
 * ② 用上的多在前（同样能做，用掉三样的比用掉一样的更值得做）；
 * ③ 家人信号强的在前（做过次数 → 收藏人数）；
 * ④ 名字 → recipeId：同分的顺序必须是确定的（没有这一层，两次请求可能给出不同顺序，
 *    界面看着像在跳，测试也没法稳定断言——与 rankPicks / rankMatches 同一条理由）。
 */
export function rankDecide(rows: readonly DecideCandidate[]): DecideCandidate[] {
  const decorated = rows.map((row) => ({ row, tier: tierOf(row) }))
  decorated.sort(
    (a, b) =>
      TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
      b.row.soon.length - a.row.soon.length ||
      b.row.have.length - a.row.have.length ||
      b.row.cooked - a.row.cooked ||
      b.row.favorites - a.row.favorites ||
      a.row.name.localeCompare(b.row.name, 'zh') ||
      a.row.recipeId.localeCompare(b.row.recipeId),
  )
  /*
   * 同名去重（库里 33 行重名）：不去重的话，两次点可能给出**同名但不同版本**的两道菜，
   * 用户看到的是"它没换"——与 rankMatches 那边同一个毛病、同一个修法（留最好的那份）。
   */
  const seen = new Set<string>()
  return decorated
    .map((entry) => entry.row)
    .filter((row) => {
      if (seen.has(row.name)) return false
      seen.add(row.name)
      return true
    })
}

/**
 * 把"最近刚做过"的**往后放**（不是删掉）。
 *
 * 判据用 `lastCookedOn`（最近一次）而不是"总共做过几次"：一道做了十次但上个月做的菜
 * 不是问题，昨天刚吃过的那道才是。
 *
 * **稳定分区而不是过滤**：永远给新鲜的那几道、把刚做过的整个删掉，结果是"这个按钮
 * 反复只推那两三道"——而刚做过的那道很可能正是 `ready` 档（冰箱里东西刚好够）。
 * 所以新鲜的在前面、刚做过的跟在后面，两边的内部顺序都不动；
 * 没有新鲜可选时（刚起步的家庭只做过那几顿）顺序与不筛时完全一样。
 */
export function preferFresh(
  ranked: readonly DecideCandidate[],
  recentKeys: readonly string[],
): DecideCandidate[] {
  const recent = new Set(recentKeys)
  const isRecent = (row: DecideCandidate) => row.lastCookedOn !== null && recent.has(row.lastCookedOn)
  return [...ranked.filter((row) => !isRecent(row)), ...ranked.filter(isRecent)]
}

/**
 * 排掉用户这一轮已经看过的（「换一道」不能给同一道）。
 *
 * 同样**排空了就退回全部**：宁可他再看一遍刚才那道，也不要回一句"没有了"
 * ——库里几百道菜，出现"没有别的"只有一种可能，就是我们的排除逻辑错了。
 */
export function excludeSeen(
  ranked: readonly DecideCandidate[],
  seen: readonly string[],
): DecideCandidate[] {
  if (seen.length === 0) return [...ranked]
  const skip = new Set(seen)
  const left = ranked.filter((row) => !skip.has(row.recipeId))
  return left.length > 0 ? left : [...ranked]
}

/**
 * 抽一条：在定序后的**前几名**里按 `roll`（0 ≤ roll < 1）取一个。
 *
 * `roll` 是参数而不是内部调 `Math.random()`：随机这件事在单测里没法靠概率验，
 * 只能是"给它一个数、断言它取到哪一个"（与发现页「摇一道」测试 mock `Math.random` 同一手法）。
 */
export function pickOne(ranked: readonly DecideCandidate[], roll: number): DecideCandidate | null {
  if (ranked.length === 0) return null
  const window = ranked.slice(0, PICK_WINDOW)
  const index = Math.min(window.length - 1, Math.floor(Math.max(0, Math.min(0.999_999, roll)) * window.length))
  return window[index]
}

/**
 * 那一刻该说的那句话（**由后端拼**，前端只照搬）。
 *
 * 与采购清单那句"家里有 半盒，够不够看一眼"同一条规矩（D-059 四）：这类句子两边各拼
 * 一遍必然漂移，而"为什么推荐这道"与"家里有/还要买"一样，用户会拿它判断要不要信。
 *
 * 每一句都必须是**真事**：档位决定主句，家人信号作补语（确实做过才提做过）。
 * 一条信号都没有时明说"库里挑的"——不编一个理由，比编一个更值得信任。
 *
 * ⚠️ **`ready` 与 `near` 的主句必须不一样**。第一版两句共用"冰箱里的 X 正好能做这道"，
 * 验收脚本立刻抓到现场：海木耳蛋花汤缺"干海木耳"，却说"冰箱里的 鸡蛋正好能做这道，
 * 只差 干海木耳"——**前半句与后半句自相矛盾**，而用户只看前半句就会以为现在就能下锅。
 * 差一样的正确说法是"能用上什么 + 还差哪一样"，绝不说"能做"。
 */
export function decideReason(candidate: DecideCandidate): string {
  const tier = tierOf(candidate)
  const parts: string[] = []

  if (candidate.have.length > 0 && (tier === 'ready' || tier === 'near')) {
    const names = candidate.have.slice(0, REASON_MAX_NAMES)
    const more = candidate.have.length > names.length ? ' 等' : ''
    // 「正好能做」只在**真的一样都不缺**时说得出口（见上面 ⚠️）
    parts.push(
      tier === 'ready'
        ? `冰箱里的 ${names.join('、')}${more}正好能做这道`
        : `冰箱里的 ${names.join('、')}${more}能用上`,
    )
  }
  if (tier === 'near') parts.push(`只差 ${candidate.missing[0]}，顺路买一下`)

  if (candidate.soon.length > 0) {
    parts.push(`${candidate.soon.join('、')} 也该先吃了`)
  }

  if (candidate.cooked > 0) parts.push(`你们家做过 ${candidate.cooked} 次`)
  else if (candidate.favorites > 0) parts.push(`${candidate.favorites} 人收着`)

  // 一条真事都没有时明说这是库里挑的，不假装有理由
  if (parts.length === 0) return '库里挑的，今天换换口味'
  return parts.join('；')
}

/** 「换一道」能带几条排除项：给得再多也影响不了结果（候选有几百道），限一下免得被塞爆 */
export const EXCLUDE_MAX = 20

export function parseExclude(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === '') return []
  const text = Array.isArray(raw) ? raw.join(',') : String(raw)
  const ids = text
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '')
  if (ids.length > EXCLUDE_MAX) throw new BadRequestException('排除得太多了')
  return [...new Set(ids)]
}
