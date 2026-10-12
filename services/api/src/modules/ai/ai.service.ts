import { HttpException, HttpStatus, Injectable, ServiceUnavailableException } from '@nestjs/common'
import { PrismaService } from '../recipes/prisma.service'
import { AiUpstreamError, chatJson, chatStream } from './ai.client'
import {
  AI_HINT_MAX, SUGGEST_CANDIDATES, AiReplyError, formatCandidates, parseChatMessages, parseHint, parsePicks, readAiConfig,
  type AiConfig, type CandidateDish, type ChatMessage, type SuggestedPick,
} from './ai.rules'

/**
 * AI 推荐与问答（用户 2026-10-12 的新需求；口径见 D-026）。
 *
 * 定位是**掌勺人的参谋**，不是第二个菜谱库：
 * - 「推荐」从**本库真实的菜**里挑（把候选清单交给模型，它只能引用清单里的 id），
 *   所以推荐出来的每一条都能直接点进点单，不会出现"AI 说了一道库里没有的菜"；
 * - 「问 AI」是自由问答，但**带上家庭当天的上下文**（今天/明天安排了什么、家里几个人吃），
 *   否则回答会飘在天上（"你可以做个番茄炒蛋"——而今天中午已经吃过了）。
 *
 * 配置缺失时的行为是**明确拒绝**（503 + 怎么配），不是静默降级到假数据。
 */
@Injectable()
export class AiService {
  constructor(private readonly prisma: PrismaService) {}

  /** 前端据此决定"显示 AI 入口"还是"提示去配置"（只回是否配置与模型名，不回密钥） */
  status(config: AiConfig | null = readAiConfig()) {
    return { configured: Boolean(config), model: config?.model ?? null }
  }

  private requireConfig(): AiConfig {
    const config = readAiConfig()
    if (!config) {
      // 指向**两个**位置：容器里跑服务时不读 services/api/.env（compose 只注入根 .env），
      // 只写前者的话用户会照着改了还是没生效，然后怀疑功能坏了。
      throw new ServiceUnavailableException(
        'AI 还没配置：Docker 跑填根目录 .env、本机直跑填 services/api/.env，'
        + '写上 AI_API_BASE / AI_API_KEY / AI_MODEL 后重启服务',
      )
    }
    return config
  }

  /**
   * 推荐：给一份**候选清单**（按提示里的关键词或默认热度取），让模型从中挑。
   * 提示用于缩小候选，不让它去全库挑——几千道菜既塞不进上下文，也会让结果更随机。
   */
  async suggest(
    userId: string,
    input: { hint?: unknown; mealKey?: unknown },
    signal?: AbortSignal,
  ): Promise<{ picks: SuggestedPick[]; hint: string; candidates: number }> {
    // 先验输入再验配置：请求本身写错了就应该得到 400，与"AI 配没配"无关
    // （否则没配时用户拿到 503，配好之后再试还是同样的 400，白等一轮配置）
    const hint = parseHint(input.hint)
    const config = this.requireConfig()
    const context = await this.familyContext(userId)
    const candidates = await this.candidates(hint)
    if (candidates.length === 0) {
      // 库里一道菜都没有时让模型"从候选里挑"只会得到编造结果，直接说清楚
      return { picks: [], hint, candidates: 0 }
    }

    const systemPrompt = [
      '你是家庭厨房的掌勺参谋。只能从下面这份候选菜清单里挑菜，不要编造清单之外的菜。',
      '按 picks 数组回：每条的 id 必须是候选清单里的 id，reason 是一句话说明为什么适合这一餐（20 字内）。',
      '挑选原则：口味均衡、荤素搭配、考虑家里人数与当下时令；同等条件下优先快手菜。',
      '',
      '候选清单：',
      formatCandidates(candidates),
      '',
      context.meal ? `要安排的这一餐：${context.meal}` : '',
      context.note ? `家里情况：${context.note}` : '',
      hint ? `用户说：${hint}` : '用户没有特别说明，按家常口味推荐。',
    ].filter(Boolean).join('\n')

    // 解析必须**在 ask 里面**做（用 parse 回调传入），不能放在调用之后——
    // 放外面的话"模型答非所问"这条错误就绕过了下面的分类，照样冒成 500。
    const picks = await this.ask(
      config,
      {
        systemPrompt,
        // 用 user 消息承载任务而不是塞进 system：模型对"最后一个 user 消息"的服从度最高
        messages: [{ role: 'user', content: hint || '今天吃什么好？' }],
        json: true,
        temperature: 0.6,
        signal,
      },
      (text) => parsePicks(text, candidates),
    )

    return { picks, hint, candidates: candidates.length }
  }

  /** 问 AI：带家庭上下文的自由问答（消息历史由前端带上，服务端不存） */
  async chat(
    userId: string,
    rawMessages: unknown,
    signal?: AbortSignal,
  ): Promise<{ reply: string }> {
    // 同上：先验输入（400）再验配置（503）
    const messages = parseChatMessages(rawMessages)
    const config = this.requireConfig()
    const context = await this.familyContext(userId)

    const systemPrompt = [
      '你是这个家庭的厨房助手，回答要亲切、简短（通常 3 句话内），给可执行的建议而不是泛泛而谈。',
      '家里已有的安排（别推荐重复的菜）：',
      context.summary || '（今天还没有安排）',
      context.note ? `家里情况：${context.note}` : '',
      '如果被问到与下厨、食材、营养无关的事，礼貌地把话题带回来。',
    ].filter(Boolean).join('\n')

    const reply = await this.ask(config, { systemPrompt, messages, temperature: 0.7, signal }, (text) => text.trim())
    return { reply }
  }

  /**
   * 问 AI（流式）：逐段吐出模型的话，让第一个字一出现就能上屏。
   *
   * 为什么不把 chat 直接改成流式：**推荐**那条路要的是结构化结果（json_schema + 解析核对），
   * 而结构化与流式叠加在网关这边不可靠（见 ai.client 的 chatStream 注释）。**问答**本来就是
   * 一段自由文字，流式天然合适——两个入口各用最稳的那条路。
   *
   * 输入与配置的校验仍在这里做：调用方（控制器）已经写出 200 与 SSE 头之后就无法改状态码了，
   * 所以**校验必须发生在写响应头之前**（控制器先 await 到第一段再写头，见 ai.controller）。
   */
  async *chatStream(
    userId: string,
    rawMessages: unknown,
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    // 同上：先验输入（400）再验配置（503）
    const messages = parseChatMessages(rawMessages)
    const config = this.requireConfig()
    const context = await this.familyContext(userId)

    const systemPrompt = [
      '你是这个家庭的厨房助手，回答要亲切、简短（通常 3 句话内），给可执行的建议而不是泛泛而谈。',
      '家里已有的安排（别推荐重复的菜）：',
      context.summary || '（今天还没有安排）',
      context.note ? `家里情况：${context.note}` : '',
      '如果被问到与下厨、食材、营养无关的事，礼貌地把话题带回来。',
    ].filter(Boolean).join('\n')

    try {
      yield* chatStream(config, { systemPrompt, messages, temperature: 0.7, signal })
    } catch (error) {
      // 与 ask 同一套分类：上游失败要翻成人话 + 正确状态码，不能冒成 500
      throw mapAskError(error)
    }
  }

  /**
   * 调用上游、解析回包，并把**所有**失败翻成"人话 + 正确的状态码"。
   *
   * 为什么必须有这一层：`chatJson` 与 `parsePicks` 抛的都是普通 `Error`（它们不该依赖 Nest），
   * 直接往外冒就是 **500 Internal server error**——用户看到的是"服务器崩了"，
   * 而真相往往是"上游限流/超时/密钥过期"，重试或换配置就能好。所以在这里分类：
   * 超时 → 504、模型答非所问 → 502、上游拒绝 → 502。
   *
   * `parse` 也是**参数**而不是调用方在 await 之后再处理：解析失败（模型回了散文）
   * 和上游失败是同一类问题，都必须走这里的映射——放外面就会漏成 500（实测踩过）。
   */
  private async ask<T>(
    config: AiConfig,
    request: Parameters<typeof chatJson>[1],
    parse: (text: string) => T,
  ): Promise<T> {
    try {
      return parse(await chatJson(config, request))
    } catch (error) {
      throw mapAskError(error)
    }
  }

  /**
   * 候选池：有提示就按名称/配料/标签搜（走库里的 searchText），没有就按最近点过的热门菜补足。
   * 刻意**不做**"按口味/忌口过滤"——那是 M8 口味档案的活（F5-03），现在没有数据源，
   * 假过滤比不过滤更糟（用户会以为系统记住了他的忌口）。
   */
  private async candidates(hint: string): Promise<CandidateDish[]> {
    const keywords = hint.split(/[\s,，、。]+/).map((word) => word.trim()).filter((word) => word.length >= 2).slice(0, 4)

    const rows = keywords.length
      ? await this.prisma.recipe.findMany({
          where: { OR: keywords.map((word) => ({ searchText: { contains: word } })) },
          take: SUGGEST_CANDIDATES,
          orderBy: { id: 'asc' },
        })
      : []

    const picked = rows.length >= 6
      ? rows
      : await this.prisma.recipe.findMany({ take: SUGGEST_CANDIDATES, orderBy: { id: 'asc' } })

    return picked.slice(0, SUGGEST_CANDIDATES).map((recipe) => ({
      id: recipe.id,
      name: recipe.name,
      category: recipe.category,
      tags: (recipe.tags as string[] | null)?.slice(0, 4) ?? [],
      spiciness: recipe.spiciness,
    }))
  }

  /** 家庭上下文：今天/明天的安排 + 人数（让推荐与问答都贴着这个家真实的情况） */
  private async familyContext(userId: string): Promise<{
    meal: string | null
    note: string
    summary: string
  }> {
    const membership = await this.prisma.familyMember.findUnique({
      where: { userId },
      include: { family: { include: { members: true } } },
    })
    if (!membership) return { meal: null, note: '', summary: '' }

    const now = new Date()
    const from = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
    const to = new Date(from.getTime() + 2 * 86_400_000)
    const meals = await this.prisma.mealOrder.findMany({
      where: { familyId: membership.familyId, mealDate: { gte: from, lt: to } },
      include: { items: true },
      orderBy: [{ mealDate: 'asc' }, { meal: 'asc' }],
    })

    const summary = meals
      .map((meal) => {
        const date = meal.mealDate.toISOString().slice(0, 10)
        const dishes = meal.items.map((item) => item.recipeName).join('、') || '还没点菜'
        return `- ${date} ${meal.meal === 'LUNCH' ? '午餐' : '晚餐'}：${dishes}（${meal.status}）`
      })
      .join('\n')

    const diner = meals.find((meal) => meal.dinerCount)?.dinerCount
    const note = [
      `家里 ${membership.family.members.length} 口人`,
      diner ? `最近一餐按 ${diner} 人做` : '',
    ].filter(Boolean).join('，')

    return { meal: null, note, summary }
  }
}

/**
 * 上游/解析失败 → 带正确状态码的 HttpException。
 *
 * 抽出来共用：一次性的 `ask` 和流式的 `chatStream` 要给出同一套话术与状态码，
 * 各写一份迟早会漂移（用户看到"同一种失败"在两个入口说两样话）。
 */
function mapAskError(error: unknown): unknown {
  if (error instanceof AiUpstreamError) {
    const status = error.status === 504 ? HttpStatus.GATEWAY_TIMEOUT : HttpStatus.BAD_GATEWAY
    return new HttpException(error.message, status)
  }
  if (error instanceof AiReplyError) {
    return new HttpException(`${error.message}，再点一次试试`, HttpStatus.BAD_GATEWAY)
  }
  return error
}

export { AI_HINT_MAX }
