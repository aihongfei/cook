import { HttpException, HttpStatus, Injectable, ServiceUnavailableException } from '@nestjs/common'
import { PrismaService } from '../recipes/prisma.service'
import { AiUpstreamError, chatJson, chatStreamEvents, type StreamEvent, type WireMessage } from './ai.client'
import {
  AI_HINT_MAX, EXAMPLE_TEXT_MAX, HINT_TEXT_MAX, PROMPTS_EXAMPLES_MAX, PROMPTS_HINTS_MAX,
  SUGGEST_CANDIDATES, SUGGEST_MATCHES_MAX, SUGGEST_PICKS_MAX, SUGGEST_PICKS_MIN, AiReplyError,
  extractKeywords, formatCandidates, parseChatMessages, parseHint, parsePicks, parsePrompts, readAiConfig,
  PICKS_SCHEMA, PROMPTS_SCHEMA,
  sampleList,
  type AiConfig, type AiPrompts, type CandidateDish, type ChatMessage, type SuggestedPick,
} from './ai.rules'
import {
  AI_TOOLS, FRIDGE_ADD_MAX, PROPOSALS_MAX, SEARCH_RESULTS_MAX, TOOL_ADD_FRIDGE_ITEMS, TOOL_PROPOSE_MENU_ITEMS,
  TOOL_READ_FRIDGE, TOOL_READ_PLAN, TOOL_REMOVE_FRIDGE_ITEM, TOOL_ROUNDS_MAX, TOOL_SEARCH_DISHES, TOOL_UPDATE_FRIDGE_ITEM,
  fridgeText, readAddItems, readProposals, readRemoveItem, readUpdateItem, searchResult, todayKey, toolResult,
  type MenuProposal, type ToolCall,
} from './ai.tools'
import { AiActionService, type AiReceipt } from './ai-action.service'
import { FridgeService } from '../fridge/fridge.service'

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly actions: AiActionService,
    private readonly fridge: FridgeService,
  ) {}

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
      `按 picks 数组回：每条的 id 必须是候选清单里的 id，reason 是一句话说明为什么适合这一餐（20 字内）。`,
      // 条数（用户 2026-10-13：「两个菜有点少了，可以多一些」）：原来没写清楚要几道，
      // 模型常只给 2 道。写进提示词而不是加进解析器——给少了是"少一点"，不是"答错了"，
      // 为它整个丢弃、让用户重问一遍更糟（上限仍由 SUGGEST_PICKS_MAX 兜住）
      `挑 ${SUGGEST_PICKS_MIN}～${SUGGEST_PICKS_MAX} 道：用户要看着选，只给两道不够挑；也不要凑数，清单里确实不合适的就别选。`,
      '挑选原则：口味均衡、荤素搭配、考虑家里人数与当下时令；同等条件下优先快手菜。',
      // 候选清单每次都是随机抽的，但模型偏爱清单开头那几条——不说明的话同一句话问两遍
      // 会把清单前两道再报一遍，看起来就像写死的（用户 2026-10-13 的原话：「是固定的吗」）
      '清单每次都是随机抽的，**不要只挑排在前面的**；同一个问题再问一次时，尽量换几道不一样的。',
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
        jsonSchema: PICKS_SCHEMA,
        temperature: 0.6,
        signal,
      },
      (text) => parsePicks(text, candidates),
    )

    return { picks, hint, candidates: candidates.length }
  }

  /**
   * 快问与示例问题（用户 2026-10-12：「这块也要使用ai吧，内置的这些不够用」）。
   *
   * 前端那份写死的池子全国一个样，看两遍就成了墙纸。这里按**这家人的实际情况**现写一批
   * （最近常点什么、几口人、什么季节），前端拿它当池子抽，「换一批」不用再调模型。
   *
   * 三个刻意的取舍：
   * - **没有输入参数**：这不是"用户问了什么"，而是"这个家是什么样"——参数化只会让界面
   *   多一个要填的东西，而它本来就没有用户输入；
   * - **人数/季节也塞进上下文**：模型写"两个人在家随便吃点"比"推荐一道清淡的菜"像人话，
   *   而这需要它知道家里几口人；
   * - **清洗后不够一屏就判失败**（见 parsePrompts）：半批提示词混着写死的那些出，
   *   用户看到的是两套语气的标签混在一排里。
   */
  async prompts(userId: string, signal?: AbortSignal): Promise<AiPrompts> {
    const config = this.requireConfig()
    const context = await this.promptsContext(userId)

    const systemPrompt = [
      '你是这个家庭的厨房助手。任务：为两个入口各写一批**能直接点的短句**。',
      '① hints（快问）——「AI 帮你想」里的快捷按钮，用户点一下就等于说了这句话。'
        + '写他**想吃什么、家里什么情况**（如"清淡点""孩子也能吃""冰箱有剩青菜"），'
        + `${HINT_TEXT_MAX} 字以内，像家里人随口说的，不是"请推荐一道清淡的菜"这种书面语。`,
      `② examples（示例问题）——「问 AI」里示范"这个入口能问多细"的问题（如"鱼怎么煎不破皮"），`
        + `${EXAMPLE_TEXT_MAX} 字以内，要是真下厨时卡住的那种具体问题。`,
      `各写 ${PROMPTS_HINTS_MAX} 条与 ${PROMPTS_EXAMPLES_MAX} 条：一次只显示一部分，用户点「换一批」要能换出新的。`,
      '不要写"推荐一道菜"这种空话（那是按钮已经说清的事）；两批内部都别重复；'
        + '不要出现具体品牌；不要客套话。',
      '',
      '这家人的情况：',
      context,
      '',
      '按 JSON 回：{"hints": ["..."], "examples": ["..."]}',
    ].filter(Boolean).join('\n')

    // temperature 给高一点：这几组句子要的是**每次不一样**，太保守时换个家也还是那几句
    return this.ask(
      config,
      {
        systemPrompt,
        messages: [{ role: 'user', content: '按上面的要求写一批。' }],
        jsonSchema: PROMPTS_SCHEMA,
        temperature: 0.95,
        signal,
      },
      (text) => parsePrompts(text),
    )
  }

  /**
   * 生成提示词要用的家庭情况：几口人、最近常吃什么、现在什么季节。
   *
   * 与 `familyContext`（问答用）分开：那边要的是"这两天的安排"（避免推荐重复的菜），
   * 这边要的是**这个家的画像**（口味倾向、食量、时令），两者混在一起会让模型抓错重点。
   */
  private async promptsContext(userId: string): Promise<string> {
    const membership = await this.prisma.familyMember.findUnique({
      where: { userId },
      include: { family: { include: { members: true } } },
    })
    if (!membership) return '（还没有加入家庭，按普通三口之家写）'

    const now = new Date()
    // 最近 14 天点过的菜：比"这两天的安排"更能代表这一家的口味（安排可能是给客人备的）
    const since = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - 14))
    const recent = await this.prisma.orderItem.findMany({
      where: { mealOrder: { familyId: membership.familyId }, createdAt: { gte: since } },
      select: { recipeName: true },
      orderBy: { createdAt: 'desc' },
      take: 60,
    })
    // 去重保序：同一道菜点过五次也只提一次，不然上下文里全是同一道菜
    const dishes = [...new Set(recent.map((item) => item.recipeName))].slice(0, 12)

    const month = now.getMonth() + 1
    return [
      `家里 ${membership.family.members.length} 口人。`,
      dishes.length ? `最近两周点过：${dishes.join('、')}。` : '最近两周还没在应用里点过菜。',
      `现在是 ${month} 月（${seasonOf(month)}）。`,
    ].join('\n')
  }

  /** 问 AI：带家庭上下文的自由问答（消息历史由前端带上，服务端不存） */
  async chat(
    userId: string,
    rawMessages: unknown,
    signal?: AbortSignal,
  ): Promise<{ reply: string; proposals: MenuProposal[] }> {
    // 同上：先验输入（400）再验配置（503）
    const messages = parseChatMessages(rawMessages)
    const config = this.requireConfig()
    const context = await this.familyContext(userId)

    let reply = ''
    let proposals: MenuProposal[] = []
    for await (const event of this.runToolLoop(config, userId, messages, context, signal)) {
      if (event.type === 'text') reply += event.text
      else if (event.type === 'proposals') proposals = event.items
    }
    if (!reply.trim() && proposals.length === 0) {
      throw new HttpException('AI 没说出话来，再点一次试试', HttpStatus.BAD_GATEWAY)
    }
    return { reply: reply.trim(), proposals }
  }

  /**
   * 问 AI（流式）：逐段吐出模型的话，让第一个字一出现就能上屏。
   *
   * 为什么不把 recommend 也改成流式：**推荐**那条路要的是结构化结果（json_schema + 解析核对），
   * 而结构化与流式叠加在网关这边不可靠（见 ai.client 的 chatStreamEvents 注释）。**问答**本来就是
   * 一段自由文字，流式天然合适——两个入口各用最稳的那条路。
   *
   * 输入与配置的校验仍在这里做：调用方（控制器）已经写出 200 与 SSE 头之后就无法改状态码了，
   * 所以**校验必须发生在写响应头之前**（控制器先 await 到第一段再写头，见 ai.controller）。
   */
  async *chatStream(
    userId: string,
    rawMessages: unknown,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    // 同上：先验输入（400）再验配置（503）
    const messages = parseChatMessages(rawMessages)
    const config = this.requireConfig()
    const context = await this.familyContext(userId)
    try {
      yield* this.runToolLoop(config, userId, messages, context, signal)
    } catch (error) {
      // 与 ask 同一套分类：上游失败要翻成人话 + 正确状态码，不能冒成 500
      throw mapAskError(error)
    }
  }

  /**
   * **工具循环**：模型要调工具就替它调，把结果喂回去让它接着说，直到它不再调为止。
   *
   * 这是"AI 后端改成智能体"的实质（用户 2026-10-12 第③项）——它不是某个框架的名字，
   * 而是这一圈：**模型说要什么 → 服务端真的去查库 → 结果喂回 → 模型接着说完**。
   * 之所以自己写而不引 pi-ai：本项目后端是 CommonJS，pi-ai 是 ESM-only 且带 70+ 传递依赖
   * （实测 require 不了、Docker `--frozen-lockfile` 也会跟着拧），而这里要的能力只有
   * "发 messages、收 tool_calls、喂回结果"三件事——网关已经证实支持（见 D-026 第三次补充）。
   *
   * 三道闸门，都是为了不让模型的话直接变成用户家的数据：
   * - 轮数上限 `TOOL_ROUNDS_MAX`：模型可能来回打转，烧的是用户额度；
   * - 工具的执行结果**只回给模型**，写库要等用户点确认（propose 只"提名"）；
   * - 未知工具名一律回一句"没有这个工具"，而不是崩掉（模型偶尔会自己发明工具名）。
   */
  private async *runToolLoop(
    config: AiConfig,
    userId: string,
    messages: ChatMessage[],
    context: { meal: string | null; note: string; summary: string },
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    const systemPrompt = [
      '你是这个家庭的厨房助手，回答要亲切、简短（通常 3 句话内），给可执行的建议而不是泛泛而谈。',
      '家里已有的安排（别推荐重复的菜）：',
      context.summary || '（今天还没有安排）',
      context.note ? `家里情况：${context.note}` : '',
      // 实测踩过：模型会往"已做好"的那一餐里加菜，用户点下去只拿到一句
      // 「这餐已经做好了，换个餐次再点吧」——白点一次。所以把这条规则明说，
      // 并要求它改提别的餐次（status 就在上面的安排里，模型看得到）。
      '上面标了「已做好」或「已取消」的那一餐**不要再加菜**（加进去会被接口拒掉），改提别的餐次或先问用户。',
      '',
      `今天是 ${todayKey()}。`,
      '你要推荐或提到某道具体的菜时，**必须先调用 ${TOOL_SEARCH_DISHES} 拿到真实的菜**——你记忆里的菜名库里不一定有，编出来的菜用户点不进去。',
      `用户想吃某道菜、或你判断该加进菜单时，调用 ${TOOL_PROPOSE_MENU_ITEMS} 把菜提出来。它只是**提议**，`
        + '界面上会出现确认按钮，用户点了才会真的加进菜单，所以不要对用户说"已经加好了"。',
      '如果你提到了具体的菜（不管有没有提议），在回答的最后顺带问一句要不要加进菜单，例如'
        + '「要我把这两道加进今天晚餐吗？」——这是用户明确要的：他希望在对话里就能直接点菜。',
      /*
       * 冰箱那一档（D-052 的 A 档）：与加菜**不是同一种**，必须让模型分清，
       * 否则它会把"直接写"的谨慎程度套到冰箱上（每次都反问一遍，用户要的
       * "对话里顺手记一下"就变成了填表单），或者反过来把菜单也直接写掉。
       */
      `冰箱是**可以直接帮你记的**：用户说"记一下冰箱里有什么"或明确要改/删冰箱里的东西时，`
        + `用 ${TOOL_READ_FRIDGE} 看清楚现状，再调 ${TOOL_ADD_FRIDGE_ITEMS} / ${TOOL_UPDATE_FRIDGE_ITEM} / ${TOOL_REMOVE_FRIDGE_ITEM}。`
        + '这几件**会真的写库**，界面上会给用户一张可撤销的回执卡，所以你可以说"记好了"——'
        + '但**只说你真的记成的那些**（工具结果里会列出成没成），没记成的照实说原因。',
      `要让用户明白哪些事你能直接做、哪些要他自己点：冰箱可以（有回执可撤）；菜单不行（只能提建议等他点）；`
        + '家庭管理（改角色、转让、退家庭）你没有工具，用户问起就告诉他去"我的 → 家庭"里做。',
      '如果被问到与下厨、食材、营养无关的事，礼貌地把话题带回来。',
    ].filter(Boolean).join('\n')

    const wire: WireMessage[] = messages.map((message) => ({ role: message.role, content: message.content }))
    const proposals: MenuProposal[] = []
    const proposed = new Set<string>()
    /** AI 这一轮真写进库的那些（回执卡）：前端据此长出「撤」 */
    const receipts: AiReceipt[] = []
    let seenCalls = false
    // 模型"不再要工具了"就是正常收尾。**这里用 break 而不是 return**：
    // return 会让下面的 proposals 永远发不出去（实测验收时就是这么红的——
    // 工具都跑了、库里也核对了，前端却一个建议都收不到）。
    let settled = false

    for (let round = 0; round < TOOL_ROUNDS_MAX; round += 1) {
      const calls: ToolCall[] = []
      let text = ''
      for await (const event of chatStreamEvents(config, {
        systemPrompt, messages: wire, tools: AI_TOOLS, temperature: 0.7, signal,
      })) {
        if (event.type === 'text') {
          text += event.text
          yield { type: 'text', text: event.text }
        } else {
          calls.push(...event.calls)
        }
      }
      if (calls.length === 0) {
        settled = true
        break
      }
      seenCalls = true

      // 助手那句"我要调工具"必须原样带回去，否则下一轮的 tool 结果上游认不出对应谁
      wire.push({ role: 'assistant', content: text || null, tool_calls: calls })

      for (const call of calls) {
        yield { type: 'status', label: statusLabel(call.name) }
        const outcome = await this.executeTool(call, userId, proposals, proposed, receipts)
        wire.push({ role: 'tool', tool_call_id: call.id, content: outcome })
      }
    }

    // 轮数用完了模型可能还在要求调工具：告诉它别再调了，逼一句话收尾
    if (!settled && seenCalls) {
      yield { type: 'status', label: '正在收尾…' }
      for await (const event of chatStreamEvents(config, {
        systemPrompt: `${systemPrompt}\n\n（工具轮次已经用完，请直接根据已有信息回答，不要再调用工具。）`,
        messages: wire,
        temperature: 0.7,
        signal,
      })) {
        if (event.type === 'text') yield { type: 'text', text: event.text }
      }
    }
    if (proposals.length) yield { type: 'proposals', items: proposals }
    // 回执卡在**最后**发：它证明前面那些"记好了"是真话，且带着撤销要用的 id
    if (receipts.length) yield { type: 'receipts', items: receipts }
  }

  /**
   * 执行一次工具调用，返回**给模型看的结果**（紧凑 JSON）。
   *
   * **菜单一个字都不写**：`propose_menu_items` 只是把建议攒起来交给界面，
   * 真写库的动作在用户点"加入菜单"之后走 `/orders/items`（与手点同一条路），
   * 这样"AI 建议"与"用户点菜"在数据上没有任何区别，也就不需要额外的一套权限口径。
   *
   * **冰箱真的写**（D-052 的 A 档）：走 `AiActionService` → `FridgeService`（与手写同一条路），
   * 每笔留一条 `AiAction` 以便撤销。分档的判据见 D-052：只影响自己家、代价小、看得见、撤得回来。
   */
  private async executeTool(
    call: ToolCall,
    userId: string,
    proposals: MenuProposal[],
    proposed: Set<string>,
    receipts: AiReceipt[],
  ): Promise<string> {
    if (call.name === TOOL_SEARCH_DISHES) {
      const query = readStringArg(call.arguments, 'query')
      if (!query) return toolResult({ error: 'query 不能为空，请换个关键词再搜' })
      const rows = await this.prisma.recipe.findMany({
        where: { searchText: { contains: query } },
        take: SEARCH_RESULTS_MAX,
        orderBy: { id: 'asc' },
      })
      return searchResult(rows.map((recipe) => ({
        id: recipe.id,
        name: recipe.name,
        category: recipe.category,
        tags: (recipe.tags as string[] | null) ?? [],
      })), query)
    }

    if (call.name === TOOL_PROPOSE_MENU_ITEMS) {
      const wanted = readProposalIds(call.arguments)
      // 拿库核对：模型给的 id 可能有编的，编的一律不往界面上放
      const known = new Map<string, string>()
      if (wanted.length) {
        const rows = await this.prisma.recipe.findMany({
          where: { id: { in: wanted } },
          select: { id: true, name: true },
        })
        for (const row of rows) known.set(row.id, row.name)
      }
      const { proposals: fresh, rejected } = readProposals(call.arguments, known, todayKey())
      for (const item of fresh) {
        const key = `${item.recipeId}|${item.mealDate}|${item.meal}`
        if (proposed.has(key) || proposals.length >= PROPOSALS_MAX) continue
        proposed.add(key)
        proposals.push(item)
      }
      return toolResult({
        accepted: fresh.map((item) => `${item.name}（${item.when}）`),
        rejected: rejected.length ? rejected : undefined,
        hint: fresh.length
          ? '建议已经放到用户眼前了，等他点确认。回答里问一句要不要加进菜单即可，不要说"已经加好了"。'
          : '这些 id 在菜谱库里不存在，请先用 search_dishes 拿到真实 id 再来提。',
      })
    }

    if (call.name === TOOL_READ_PLAN) {
      const days = readNumberArg(call.arguments, 'days') ?? 3
      return toolResult({ plan: await this.currentPlan(userId, Math.max(1, Math.min(7, Math.round(days)))) })
    }

    /*
     * 冰箱四件（A 档）。读的那件不写库；写的那三件都经 AiActionService——
     * **不在控制器/服务里各写一套**：那套东西要同时管"与手写同一条路"和"留撤销记录"，
     * 复制一份必然有一边先改。
     */
    if (call.name === TOOL_READ_FRIDGE) {
      const board = await this.fridge.board(userId)
      const items = board.zones.flatMap((group) => group.items)
      return toolResult({
        fridge: fridgeText(items.map((item) => ({
          id: item.id,
          name: item.name,
          amount: item.amount,
          zone: item.zone,
          expiryLabel: item.expiryLabel,
        }))),
        hint: items.length ? '要改或要删就用上面的 id' : '冰箱是空的，可以直接用 add_fridge_items 记',
      })
    }

    if (call.name === TOOL_ADD_FRIDGE_ITEMS) {
      const { drafts, rejected } = readAddItems(call.arguments)
      if (drafts.length === 0) {
        return toolResult({ error: '没有解析出要记的食材，请按 items 数组再试一次' })
      }
      const result = await this.actions.addFridgeItems(userId, drafts)
      receipts.push(...result.actions)
      return toolResult({
        result: result.summary,
        rejected: rejected.length ? rejected : undefined,
        hint: '回执卡已经给用户了，他随时可以撤。照着这里的结果如实回答，没记成的要说原因。',
      })
    }

    if (call.name === TOOL_UPDATE_FRIDGE_ITEM) {
      const parsed = readUpdateItem(call.arguments)
      if (!parsed) return toolResult({ error: '没解析出 itemId，请先调 read_fridge 拿准确 id' })
      const result = await this.actions.updateFridgeItem(userId, parsed.itemId, parsed.patch)
      receipts.push(...result.actions)
      return toolResult({ result: result.summary, hint: '回执卡已经给用户了，他随时可以撤。' })
    }

    if (call.name === TOOL_REMOVE_FRIDGE_ITEM) {
      const itemId = readRemoveItem(call.arguments)
      if (!itemId) return toolResult({ error: '没解析出 itemId，请先调 read_fridge 拿准确 id' })
      const result = await this.actions.removeFridgeItem(userId, itemId)
      receipts.push(...result.actions)
      return toolResult({ result: result.summary, hint: '回执卡已经给用户了，他随时可以撤。' })
    }

    // 模型偶尔会自己发明工具名：回一句"没有这个工具"让它换个说法，而不是崩掉整轮
    return toolResult({ error: `没有名为 ${call.name} 的工具` })
  }

  /** 读这个家往后几天的安排（给模型看的紧凑文本） */
  private async currentPlan(userId: string, days: number): Promise<string> {
    const membership = await this.prisma.familyMember.findUnique({ where: { userId } })
    if (!membership) return '（还没有加入家庭）'
    const now = new Date()
    const from = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
    const to = new Date(from.getTime() + days * 86_400_000)
    const meals = await this.prisma.mealOrder.findMany({
      where: { familyId: membership.familyId, mealDate: { gte: from, lt: to } },
      include: { items: true },
      orderBy: [{ mealDate: 'asc' }, { meal: 'asc' }],
    })
    if (meals.length === 0) return '（这几天还没有安排）'
    return meals
      .map((meal) => {
        const date = meal.mealDate.toISOString().slice(0, 10)
        const dishes = meal.items.map((item) => item.recipeName).join('、') || '还没点菜'
        return `${date} ${meal.meal === 'LUNCH' ? '午餐' : '晚餐'}：${dishes}`
      })
      .join('\n')
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
   * 候选池：有提示就按名称/配料/标签搜（走库里的 searchText），没有就全库随机抽一批。
   * 刻意**不做**"按口味/忌口过滤"——那是 M8 口味档案的活（F5-03），现在没有数据源，
   * 假过滤比不过滤更糟（用户会以为系统记住了他的忌口）。
   *
   * **两处随机都是必须的**（用户 2026-10-13：「怎么都是鱼香肉丝和蘑菇，是固定的吗」）：
   * - 兜底分支原来写的是 `take: 24, orderBy: { id: 'asc' }`——每次都是库里 id 最小的那 24 道，
   *   模型每回都在这同一批里挑，于是推荐永远是那几道。改成**全库随机抽**（先取 id 列、再抽样、再按 id 取详情）；
   * - 命中分支也可能一次命中几百道（"想吃肉"这种），只取前 30 道同样会固定，所以先随机抽再交给模型。
   *
   * 关键词本身也修了：原来「剩饭怎么处理」这种没有标点的句子切出来是一个六字整词，
   * 库里搜不到 → 每次都落兜底。现在由 `extractKeywords` 切成二元组，能真匹配上（见那里的说明）。
   */
  private async candidates(hint: string): Promise<CandidateDish[]> {
    const keywords = extractKeywords(hint)

    const rows = keywords.length
      ? await this.prisma.recipe.findMany({
          where: { OR: keywords.map((word) => ({ searchText: { contains: word } })) },
          take: SUGGEST_MATCHES_MAX,
          orderBy: { id: 'asc' },
        })
      : []

    /*
     * 命中够多就用命中；否则补足。**补足也要随机**：原来固定取 id 最小的那几道，
     * 于是"随便看看"永远看到同一批（那正是用户截图里的现象）。
     * 先只取 id（几百道也就几 KB），抽样后再取详情，避免把整库读进内存。
     */
    let pool = rows
    if (pool.length < SUGGEST_CANDIDATES) {
      const ids = await this.prisma.recipe.findMany({ select: { id: true }, orderBy: { id: 'asc' } })
      const known = new Set(pool.map((row) => row.id))
      const extra = sampleList(ids.map((row) => row.id).filter((id) => !known.has(id)), SUGGEST_CANDIDATES - pool.length)
      if (extra.length) {
        const filled = await this.prisma.recipe.findMany({ where: { id: { in: extra } } })
        // 抽样出来的顺序要保住（`in` 查询回来的顺序不保证），否则随机又白做了
        const byId = new Map(filled.map((row) => [row.id, row]))
        pool = [...pool, ...extra.map((id) => byId.get(id)).filter((row) => row !== undefined)]
      }
    }

    // 交给模型前**再打乱一次**：清单有序时模型明显偏爱前几条（实测它总挑清单开头那两道），
    // 顺序固定 = 推荐固定——这正是用户看到的"每次都是鱼香肉丝和素炒蘑菇"。
    const picked = sampleList(pool, SUGGEST_CANDIDATES)

    return picked.map((recipe) => ({
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

/** 流式问答往外吐的事件：前端按 type 分派（正文上屏 / 状态行 / 建议卡片） */
export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'status'; label: string }
  | { type: 'proposals'; items: MenuProposal[] }
  /** AI 真写进库的那些（D-052 A 档）：前端据此长出「撤」——**它是"记好了"那句话的证据** */
  | { type: 'receipts'; items: AiReceipt[] }

/**
 * 工具执行期间给用户看的短句。
 *
 * 为什么要给这个：工具轮次是**看得见的等待**（实测每轮 3~5 秒，两轮就 10 秒），
 * 如果界面只显示"正在输入"，用户会以为卡住了；说一句"正在翻菜谱…"性质就完全不同
 * ——他知道系统在干活，而且干的事和他刚说的话有关。
 */
function statusLabel(toolName: string): string {
  if (toolName === TOOL_SEARCH_DISHES) return '正在翻菜谱…'
  if (toolName === TOOL_PROPOSE_MENU_ITEMS) return '正在核对这几道菜…'
  if (toolName === TOOL_READ_FRIDGE) return '正在看冰箱里有什么…'
  if (toolName === TOOL_ADD_FRIDGE_ITEMS) return '正在记进冰箱…'
  if (toolName === TOOL_UPDATE_FRIDGE_ITEM) return '正在改冰箱里那条…'
  if (toolName === TOOL_REMOVE_FRIDGE_ITEM) return '正在把那样拿出来…'
  if (toolName === TOOL_READ_PLAN) return '正在看家里这几天的安排…'
  return '正在处理…'
}

/** 从工具参数里取一个字符串（参数是模型给的，可能非法 JSON，一律当"没给"） */
function readStringArg(rawArguments: string, key: string): string {
  try {
    const value = (JSON.parse(rawArguments) as Record<string, unknown>)?.[key]
    return typeof value === 'string' ? value.trim().slice(0, 40) : ''
  } catch {
    return ''
  }
}

function readNumberArg(rawArguments: string, key: string): number | null {
  try {
    const value = (JSON.parse(rawArguments) as Record<string, unknown>)?.[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

/** 只取出提议里的 id，拿去库里核对（其余字段交给 readProposals 处理） */
function readProposalIds(rawArguments: string): string[] {
  try {
    const items = (JSON.parse(rawArguments) as { items?: unknown })?.items
    if (!Array.isArray(items)) return []
    return items.flatMap((item) => {
      const id = (item as { recipeId?: unknown })?.recipeId
      return typeof id === 'string' && id.trim() ? [id.trim()] : []
    })
  } catch {
    return []
  }
}

/** 月份 → 季节（给模型看的人话；它据此写"天冷了想喝汤"这类贴时令的句子） */
function seasonOf(month: number): string {
  if (month >= 3 && month <= 5) return '春'
  if (month >= 6 && month <= 8) return '夏'
  if (month >= 9 && month <= 11) return '秋'
  return '冬'
}
