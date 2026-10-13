import { HttpException, HttpStatus, Injectable, ServiceUnavailableException } from '@nestjs/common'
import { PrismaService } from '../recipes/prisma.service'
import { AiUpstreamError, chatJson, chatStreamEvents, type StreamEvent, type WireMessage } from './ai.client'
import {
  AI_HINT_MAX, EXAMPLE_TEXT_MAX, HINT_TEXT_MAX, PROMPTS_EXAMPLES_MAX, PROMPTS_HINTS_MAX,
  SUGGEST_CANDIDATES, SUGGEST_MATCHES_MAX, SUGGEST_PICKS_MAX, SUGGEST_PICKS_MIN, AI_MESSAGES_MAX,
  AI_MESSAGE_MAX, AiReplyError,
  extractKeywords, formatCandidates, parseHint, parsePicks, parsePrompts, readAiConfig,
  PICKS_SCHEMA, PROMPTS_SCHEMA,
  sampleList,
  type AiConfig, type AiPrompts, type CandidateDish, type SuggestedPick,
} from './ai.rules'
import { parseChatMessagesWithImages, toModelContent, type ChatMessage } from './ai-attachment.rules'
import { FRIDGE_SCAN_PROMPT, FRIDGE_SCAN_SCHEMA, parseFridgeScan, type FridgeScanResult } from './fridge-scan.rules'
import { AiAttachmentService } from './ai-attachment.service'
import {
  AI_TOOLS, FRIDGE_ADD_MAX, MENU_ADD_MAX, PROPOSALS_MAX, SEARCH_RESULTS_MAX, TOOL_ADD_COMBO_TO_MEAL,
  TOOL_ADD_FRIDGE_ITEMS, TOOL_ADD_MENU_ITEMS, TOOL_CREATE_COMBO, TOOL_CREATE_RECIPE, TOOL_DELETE_COMBO,
  TOOL_DELETE_RECIPE, TOOL_PROPOSE_MENU_ITEMS, TOOL_READ_COMBOS, TOOL_READ_FRIDGE, TOOL_READ_MENU,
  TOOL_READ_PLAN, TOOL_READ_RECIPES, TOOL_REMOVE_FRIDGE_ITEM, TOOL_REMOVE_MENU_ITEM, TOOL_REPEAT_MEAL,
  TOOL_READ_TASTE, TOOL_ROUNDS_MAX, TOOL_SEARCH_DISHES, TOOL_SET_DINERS, TOOL_SET_MEAL_STATUS,
  TOOL_TOGGLE_FAVORITE, TOOL_UPDATE_COMBO, TOOL_UPDATE_FRIDGE_ITEM, TOOL_UPDATE_RECIPE, TOOL_UPDATE_TASTE,
  TOOL_READ_SHOPPING, TOOL_ADD_SHOPPING_ITEMS, TOOL_CHECK_SHOPPING_ITEM, TOOL_REMOVE_SHOPPING_ITEM, TOOL_RESTOCK_SHOPPING,
  SHOPPING_ADD_MAX, SHOPPING_CHECK_MAX, SHOPPING_RESTOCK_MAX,
  TOOL_WHAT_TO_COOK, TOOL_READ_FAMILY_PICKS, TOOL_READ_CHECKINS,
  FAVORITES_LIST_MAX, CHECKIN_LIST_MAX,
  comboText, fridgeText, menuText, readAddItems, readComboDraft, readDiners, readIdArg, readMealStatus,
  readMealTarget, readMenuAdds, readProposals, readRecipeDraft, readRecipePatch, readRemoveItem,
  readNameList, readShoppingAdds, shoppingText,
  readTastePatch, readUpdateItem, recipeText, searchResult, todayKey, toolResult,
  type MenuProposal, type ToolCall,
} from './ai.tools'
import { AiActionService, humanError, type AiReceipt } from './ai-action.service'
import { CheckInsService } from '../checkins/checkins.service'
import { CombosService } from '../combos/combos.service'
import { DiscoverService } from '../discover/discover.service'
import { FridgeService } from '../fridge/fridge.service'
import { TasteService } from '../taste/taste.service'
import { OrdersService } from '../orders/orders.service'
import { ShoppingService } from '../shopping/shopping.service'
import { MEAL_LABEL, STATUS_LABEL } from '../orders/orders.rules'
import { sourceLabel } from '../recipes/recipe.rules'
import { SPICY_LEVELS, judgeDish, type TasteProfile } from '../taste/taste.rules'

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
    private readonly taste: TasteService,
    // 组合的读走用户自己那套（`list` 里有"家庭内共用 + canEdit"的判定，AI 不该另写一份）
    private readonly combosService: CombosService,
    // 采购清单（M7，用户 2026-10-14 要求接入）：清单是算出来的（按菜单配料 + 自加条目），
    // 所以"缺什么"必须走它自己的 `list`——AI 另算一份必然与界面上的清单对不上
    private readonly shopping: ShoppingService,
    // 只读的三件（帮我决定 / 家人最爱 / 打卡，用户 2026-10-14 的"等所有没接入 ai 的功能"）：
    // 「帮我决定」的答案要同时看冰箱临期、口味过滤与家里的做过/收藏——那三条口径全在
    // `DiscoverService.decide` 里（与"发现页那个按钮"**同一个方法**），AI 另算一份必然分叉
    private readonly discover: DiscoverService,
    private readonly checkins: CheckInsService,
    // 对话里的图片（F16-05）：字节在服务端，消息里只传 id
    private readonly attachments: AiAttachmentService,
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
    /*
     * 口味过滤（F5-03）：**必须在"交给模型之前"排掉**，而不是拿到结果再删。
     * 拿到结果再删的话模型已经推荐了那道菜、理由也写好了，删掉之后用户看到的是
     * "少了几个"（它可能还会说"我给你挑了 5 道"而屏幕上是 3 道）；
     * 而排掉的菜它压根没见过，"别推荐这些"就不需要靠提示词去求它。
     */
    const candidates = await this.candidates(hint, await this.tasteProfiles(userId))
    if (candidates.length === 0) {
      // 库里一道菜都没有时让模型"从候选里挑"只会得到编造结果，直接说清楚
      return { picks: [], hint, candidates: 0 }
    }

    const systemPrompt = [
      '你是家庭厨房的掌勺参谋。只能从下面这份候选菜清单里挑菜，不要编造清单之外的菜。',
      `按 picks 数组回：每条的 id 必须是候选清单里的 id，reason 是一句话说明为什么适合这一餐（20 字内）。`,
      // 条数（用户 2026-HttpException10-13：「两个菜有点少了，可以多一些」）：原来没写清楚要几道，
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
    ]
      .filter(Boolean)
      .join('\n');

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

  /**
   * 冰箱拍照识别（F16-04）：一张照片 → 食材清单草稿。
   *
   * **只回草稿、不写库**（这一步是整个功能的护栏，理由见 `fridge-scan.rules` 文件头）：
   * 照片识别一定会认错，而冰箱是"今日先吃"与推荐的输入。写库那一步由前端逐项确认之后
   * 走用户自己那条 `POST /fridge`（与手填同一个口，校验与同名判定都在那里）。
   *
   * 走的是**非流式 + 结构化输出**那条路（与推荐同一个理由）：要的是一份能解析的 JSON，
   * 而不是一段边生成边上屏的话。
   */
  async scanFridge(userId: string, attachmentId: string, signal?: AbortSignal): Promise<FridgeScanResult> {
    const config = this.requireConfig()
    // 先取图（家庭校验在 loadOne 里）：拿不到就不必白烧一次模型调用
    const image = await this.attachments.loadOne(userId, attachmentId)

    return this.ask(
      config,
      {
        systemPrompt: FRIDGE_SCAN_PROMPT,
        // 图挂在最后这条 user 消息上（`ChatRequest.images` 的约定）
        messages: [{ role: 'user', content: '看看这张照片里有什么。' }],
        images: [image],
        jsonSchema: FRIDGE_SCAN_SCHEMA,
        // 识别要的是"照着照片说"，不需要创造力；温度低一点能少一些顺口编的
        temperature: 0.2,
        signal,
      },
      (text) => parseFridgeScan(text),
    )
  }

  /** 问 AI：带家庭上下文的自由问答（消息历史由前端带上，服务端不存） */
  async chat(
    userId: string,
    rawMessages: unknown,
    signal?: AbortSignal,
  ): Promise<{ reply: string; proposals: MenuProposal[] }> {
    // 同上：先验输入（400）再验配置（503）
    const messages = parseChatMessagesWithImages(rawMessages, { messagesMax: AI_MESSAGES_MAX, messageMax: AI_MESSAGE_MAX })
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
    const messages = parseChatMessagesWithImages(rawMessages, { messagesMax: AI_MESSAGES_MAX, messageMax: AI_MESSAGE_MAX })
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
    context: { meal: string | null; note: string; summary: string; familyId: string | null; taste: string | null },
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
      /*
       * 全应用 CRUD（用户 2026-10-13：「软件的 CRUD ai 都可以操作」）。
       * 菜单与冰箱**同档**（A 档），而"提建议等用户点"那条路仍然保留——
       * 两者的分界是**用户有没有明确说要办**，不是模型自己判断哪样更合适。
       */
      `菜单、人数、状态、常用组合**也可以直接帮你办**（都是真的写库 + 回执卡，除了状态都能撤）：`
        + `- 加菜：用户明确说"加进去/点上/来一道"→ ${TOOL_READ_MENU} 看清现状，再 ${TOOL_ADD_MENU_ITEMS}（不知道 id 先 ${TOOL_SEARCH_DISHES}）；`
        + `只是想要个主意、还没定 → 用 ${TOOL_PROPOSE_MENU_ITEMS} 提建议等他点。`
        + `- 撤菜：${TOOL_REMOVE_MENU_ITEM}（只能撤他自己点的，且那一餐还得在待确认阶段）；`
        + `夹"这一餐吃几个"：${TOOL_SET_DINERS}；`
        + `- 状态（选好了/开始做/做好了/取消）：${TOOL_SET_MEAL_STATUS}，**这一步没有撤销**，`
        + '所以只能在他明确说出要改到哪个状态时调，不确定就先问他；'
        + `- 常用组合：${TOOL_READ_COMBOS} 看、${TOOL_CREATE_COMBO} / ${TOOL_UPDATE_COMBO} / ${TOOL_DELETE_COMBO} / ${TOOL_ADD_COMBO_TO_MEAL} 改；`
        + `- 再点一次（照抄某一餐到另一天）：${TOOL_REPEAT_MEAL}。`,
      /*
       * 口味档案（F8-01/02）。**每一轮都带**（用户 2026-10-12 的原话：
       * 「后续每一轮对话都必须带上这些数据」）——不是"要推荐时才带"：
       * 用户可能在任何一句话里问"这个我能吃吗"，而模型必须当场就知道
       * 家里有谁对什么过敏。带的是 `tasteText(context.taste)` 那份人话摘要。
       */
      context.taste
        ? `这家人的口味与忌口（**每句话都要照着它**，推菜时绝不能挑有人过敏的）：\n${context.taste}`
        : '',
      context.taste
        ? `用户说"我不吃辣""我对花生过敏""少放盐"这类话时，用 ${TOOL_UPDATE_TASTE} 写进他自己的档案`
          + `（${TOOL_READ_TASTE} 可以随时看清现在写了什么）。只写他说的那些，不要替他补充。`
        : '',
      `自家菜谱也能直接改：用户口述自家做法就 ${TOOL_CREATE_RECIPE} 存进「我家的菜谱」；`
        + `改/删之前先 ${TOOL_READ_RECIPES} 看清哪道是**自己上传的**（标了「可改」的）。`
        + '库里的公共菜谱（极速数据那些）谁都改不了，用户想改就帮他新建一道自己的。'
        + `收藏用 ${TOOL_TOGGLE_FAVORITE}。`,
      /*
       * 采购清单（M7，用户 2026-10-14：「还需要 ai 能够处理采购清单…等现在所有没接入 ai 的功能」）。
       *
       * 这一段必须把"清单"与"菜单"的界线说明白：两者都叫"要吃什么/要买什么"，
       * 但清单是**按菜单配料算出来的**（外加用户自加的东西），所以
       * "把某道菜要用的食材加进采购单"这件事**不用手写清单**——
       * 把那道菜加进菜单，清单自己就会算出来。这是模型最容易做错的一处。
       */
      `采购清单（要去买什么）也能直接帮你办：`
        + `看现在缺什么 → ${TOOL_READ_SHOPPING}（它已按货架分好组、标出了家里已有的和已勾掉的）；`
        + `加想去买的 → ${TOOL_ADD_SHOPPING_ITEMS}（**这个也会真的写库**，有回执可撤）；`
        + `买到就勾上 → ${TOOL_CHECK_SHOPPING_ITEM}；`
        + `不想买那条自加的 → ${TOOL_REMOVE_SHOPPING_ITEM}；`
        + `买回来的收进冰箱 → ${TOOL_RESTOCK_SHOPPING}（**只补已经勾掉的**，没勾的一律不动）。`
        + '**分清清单与菜单**：菜单是"这一餐吃什么"（读它用 read_menu、加菜用 add_menu_items），'
        + '清单是"要去买什么"。用户说"把某道菜需要的食材加进采购单"时，'
        + '正确的做法是**把那道菜加进菜单**（清单会照它的配料自己算出来），'
        + '而不是把一堆食材名一条条手写进清单——手写的那些在菜单变了之后不会跟着变。'
        + '只有"清单上没有、也不是哪道菜要的"（垃圾袋、洗洁精）才用 add_shopping_items。',
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
        + `① 用户说"不知道吃什么""帮我决定""随便来一道" → ${TOOL_WHAT_TO_COOK}。`
        + '**它只给一道**（这条出口的全部意思就是不让人挑），而且会附一句为什么是它——'
        + '把那句理由照搬出来。用户说"换一道"时，把上一次给的那个 id 放进 exclude 再调一次。'
        + '算不出菜时它会说原因（菜谱库是空的 / 冰箱还没记东西 / 口味档案把人排掉了），'
        + '照实转达并说下一步去哪，**不要自己编一道顶上去**。'
        + `② 用户问"我们家常做什么""家里最爱吃哪几道" → ${TOOL_READ_FAMILY_PICKS}；`
        + `③ 用户问"我连续打卡多少天""最近做了几次""家里人最近下厨了吗" → ${TOOL_READ_CHECKINS}。`
        + '这三件都**只看不写**，所以不用问用户"要不要办"——直接查、直接答。'
        + '它们在没有家庭时会回一句"先加入家庭"，那是**有用的信息**，照实说给用户听。',
      '如果被问到与下厨、食材、营养无关的事，礼貌地把话题带回来。',
    ].filter(Boolean).join('\n')

    /*
     * 消息 → 上游线格式。**带了图的要先把字节取回来**（前端只给 id，字节在私有桶里）。
     *
     * **"读不到"分两种**（见 `AiAttachmentService.loadForModel` 的 `tolerant`）：
     * - 用户正要发的这一条（最后一轮）读不到就抛——静默少给一张，模型会拿着剩下的
     *   回答一个需要全部图的问题，而用户完全不知道少了哪张；
     * - 对话历史里那几条读不到就跳过，并在文本里标一句"这里原本有图"。
     *   历史里的图会被清理（每家只留最近 200 张），按前一条办的话这场对话就**永远答不出来**了：
     *   每一次追问都带着同一个死 id 重发、每次都 403，用户看到的是"会话没返回"。
     */
    const wire: WireMessage[] = []
    for (const [index, message] of messages.entries()) {
      const isLast = index === messages.length - 1
      let images: { data: string; mimeType: string }[] = []
      let text = message.content
      if (message.attachments?.length) {
        const loaded = await this.attachments.loadForModel(
          context.familyId ?? '__none__',
          message.attachments,
          { tolerant: !isLast },
        )
        images = loaded.images
        if (loaded.missing.length > 0) {
          text = [text, `（这条消息里的 ${loaded.missing.length} 张图片已经被清理了，看不到）`].filter(Boolean).join('\n')
        }
      }
      wire.push({ role: message.role, content: toModelContent(text, images) })
    }
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

    /*
     * 口味与健康档案（F8-01/02）。用户 2026-10-12 明确要求"AI 对话里也能直接说，
     * 由 AI 写进档案，不是只在设置页手填"。
     *
     * 读那件不写库；写的那件经 `AiActionService`（与别的 A 档一样留一条可撤的记录）——
     * **档案改错了也要能撤**：模型可能把"微辣"听成"不吃辣"，而这一项会立刻
     * 影响推荐过滤与点菜提醒，不比冰箱里那条轻。
     */
    if (call.name === TOOL_READ_TASTE) {
      const result = await this.taste.family(userId)
      return toolResult({
        profiles: tasteText(result.active) ?? '（还没人写过口味档案）',
        missing: result.missing.length ? result.missing : undefined,
        hint: result.missing.length
          ? `这几位还没写档案：${result.missing.join('、')}。可以在合适的时候提一句让他们去"我的 → 口味与忌口"写一下。`
          : '全家都写过了。',
      })
    }

    if (call.name === TOOL_UPDATE_TASTE) {
      const patch = readTastePatch(call.arguments)
      if (!patch) return toolResult({ error: '没解析出要改什么，请按字段再试一次' })
      try {
        const result = await this.actions.updateTaste(userId, patch)
        receipts.push(...result.actions)
        return toolResult({
          result: result.summary,
          hint: '回执卡已经给用户了，他随时可以撤。照着这里的结果如实回答。',
        })
      } catch (error) {
        /*
         * 校验失败（比如辣度给了 4）要**把服务端那句人话回给模型**，
         * 而不是让它编一句"我记好了"——那会让用户以为写进去了。
         */
        return toolResult({ error: humanError(error) })
      }
    }

    /*
     * ---------- 自建菜谱与收藏（F1-11 / F1-12 / F1-09）----------
     *
     * 这几条与冰箱四件形状一致：真的写库 → 记一条可撤的记录 → 回执卡。
     * **权限边界不在这里**：菜谱那条"只能改自家上传的"写在 `RecipeWriteService` 里，
     * 这里只负责把服务端拒绝的原话回给模型（让它如实转述，而不是自己编一句）。
     */

    /*
     * ---------- 采购清单（M7 / F7-01~F7-05，用户 2026-10-14 要求接入）----------
     *
     * 接入前模型的原话是「我这边没有『采购单』这个功能，做不了它」——它确实没有。
     * 现在五件：读清单（F7-02 的"缺什么"）、加自加条目（F7-03）、勾选（F7-03 持久化）、
     * 删自加条目（F7-03）、一键补货进冰箱（F7-05，写进冰箱那几条按冰箱的 kind 记回执）。
     *
     * **清单不是菜单**：菜单是"这一餐吃什么"（`read_menu`），清单是"要去买什么"
     * （由菜单按配料算出来 + 用户自加的）。提示词里明说这一条，
     * 否则模型会把"要买的东西"加到菜单里去。
     */
    if (call.name === TOOL_READ_SHOPPING) {
      const days = readNumberArg(call.arguments, 'days')
      /*
       * 读清单也会失败（没加入家庭 → 404「先加入家庭，才能和家里一起列采购清单」）。
       * **失败要变成工具结果，不能抛出去**：抛出去会把整轮问答变成一条 error 事件，
       * 用户看到的是"AI 开小差了"，而真实原因是**他自己还没建家庭**——
       * 那句话说给他听才是有用的（模型拿着这条结果会如实转述）。
       */
      try {
        const board = await this.shopping.list(userId, days ?? undefined)
        return shoppingText({
          days: board.days,
          aisles: board.aisles.map((group) => ({
            aisle: group.aisle,
            items: group.items.map((item) => ({
              name: item.name,
              amount: item.amount,
              needsBuy: item.needsBuy,
              extra: item.extra === true,
            })),
          })),
          checkedNames: board.checkedNames,
          toBuyCount: board.toBuyCount,
          coveredCount: board.coveredCount,
          missing: board.missing,
          meals: board.meals.map((meal) => ({ mealLabel: meal.mealLabel, date: meal.date })),
        })
      } catch (error) {
        return toolResult({ error: humanError(error) })
      }
    }

    if (call.name === TOOL_ADD_SHOPPING_ITEMS) {
      const wanted = readShoppingAdds(call.arguments)
      if (!wanted) return toolResult({ error: '没解析出要加的东西，请按 items[{name, amount}] 的格式再试一次' })
      if (wanted.length === 0) return toolResult({ error: 'items 是空的，告诉我要买什么' })
      try {
        const result = await this.actions.addShoppingItems(userId, wanted)
        receipts.push(...result.actions)
        return toolResult({
          result: result.summary,
          hint: '清单更新了，回执卡已经给用户。已经有的那几条会被拒——照实说"还在清单上、不用再加"，不要说"加好了"。',
        })
      } catch (error) {
        return toolResult({ error: humanError(error) })
      }
    }

    if (call.name === TOOL_CHECK_SHOPPING_ITEM) {
      const names = readNameList(call.arguments, 'names', SHOPPING_CHECK_MAX)
      if (!names || names.length === 0) return toolResult({ error: '没解析出要勾哪几样，请先用 read_shopping_list 拿准确名字' })
      const checked = readBooleanArg(call.arguments, 'checked', true)
      try {
        const result = await this.actions.checkShoppingItems(userId, names, checked)
        receipts.push(...result.actions)
        return toolResult({ result: result.summary, hint: '勾的状态已经落库。照实说哪几样勾上了、哪几样清单上没有。' })
      } catch (error) {
        return toolResult({ error: humanError(error) })
      }
    }

    if (call.name === TOOL_REMOVE_SHOPPING_ITEM) {
      const name = readStringArg(call.arguments, 'name')
      if (!name) return toolResult({ error: '没解析出要删哪一样，请先用 read_shopping_list 拿准确名字' })
      try {
        const result = await this.actions.removeShoppingItem(userId, name)
        receipts.push(...result.actions)
        return toolResult({ result: result.summary, hint: '菜单推出来的条目删不掉——那种情况告诉用户勾掉它就行。' })
      } catch (error) {
        return toolResult({ error: humanError(error) })
      }
    }

    if (call.name === TOOL_RESTOCK_SHOPPING) {
      const names = readNameList(call.arguments, 'names', SHOPPING_RESTOCK_MAX)
      if (!names || names.length === 0) return toolResult({ error: '没解析出要收哪几样，请先用 read_shopping_list 看清单' })
      try {
        const result = await this.actions.restockShopping(userId, names)
        receipts.push(...result.actions)
        return toolResult({
          result: result.summary,
          hint: '这些东西已经**真的进了冰箱**（回执卡上每条都能撤）。'
            + '没勾的那几样**一样都没动**——不要说你收了，先把它们勾上再说。',
        })
      } catch (error) {
        return toolResult({ error: humanError(error) })
      }
    }

    /*
     * ---------- 只读三件（用户 2026-10-14 的"等所有没接入 ai 的功能"）----------
     *
     * 这三条**一个字节都不写库**，所以没有回执、也不需要撤销。它们存在的理由是
     * **答案在服务端手里、不在模型印象里**：
     * - 「帮我决定」要同时看冰箱里快过期的（F6-05）、谁吃不了什么（F8-03）、
     *   家里做过几回与几个人收藏（F5-02）——三个判据都在 `DiscoverService.decide` 里，
     *   与发现页那个按钮**同一个方法**（另算一份必然分叉：界面上给的是 A，AI 说是 B）；
     * - 「家人最爱」与那一页共用 `familyPicks`（"做过 3 次"那个数字必须同源）；
     * - 「打卡」的连续天数与全家累计在 `CheckInsService.stats` 里（热力图同一套算法）。
     *
     * 失败都变成工具结果、**不往外抛**：这三条在没有家庭时都会 404，
     * 而"你还没加入家庭"那句话对用户是有用的一条信息——抛出去就只剩"AI 开小差了"。
     */

    if (call.name === TOOL_WHAT_TO_COOK) {
      const exclude = readNameList(call.arguments, 'exclude', 30) ?? []
      try {
        const result = await this.discover.decide(userId, exclude.join(','))
        if (!result.recipe) {
          // 算不出菜时明说原因（库是空的 / 冰箱还没记 / 口味档案排掉了全部），去路完全不同
          return toolResult({ result: null, reason: result.reason ?? '这会儿算不出一道合适的菜', hint: '照实说原因，并告诉用户下一步该去哪；不要自己编一道菜顶上去。' })
        }
        return toolResult({
          recipe: {
            id: result.recipe.id,
            name: result.recipe.name,
            category: result.recipe.category,
            cuisine: result.recipe.cuisine,
            calories: result.recipe.calories,
            have: result.recipe.have,
            missing: result.recipe.missing,
            cooked: result.recipe.cooked,
            favorites: result.recipe.favorites,
          },
          /** 服务端拼好的那句话（为什么是这道）——**照搬它**，别自己另编一个理由 */
          reason: result.reason,
          canSwap: result.canSwap,
          hint: '就报这一道。理由用上面 `reason` 里那句（那是按冰箱、口味、家里习惯算出来的）。'
            + '用户说"换一道"时，把这次的 id 放进 exclude 再调一次。'
            + '要说加进菜单就先用 propose_menu_items 提议（那道菜 id 就是这里给的，不必再搜）。',
        })
      } catch (error) {
        return toolResult({ error: humanError(error) })
      }
    }

    if (call.name === TOOL_READ_FAMILY_PICKS) {
      const raw = readNumberArg(call.arguments, 'limit')
      const limit = raw === null ? 8 : Math.max(1, Math.min(FAVORITES_LIST_MAX, Math.round(raw)))
      try {
        const result = await this.discover.familyPicks(userId, limit)
        if (result.items.length === 0) {
          return toolResult({
            result: '（这一家人还没有做过或收藏过任何菜）',
            hint: '照实说"还没有"，并建议他去做一次或收藏几道——不要拿菜谱库里的菜顶上来充数。',
          })
        }
        return toolResult({
          picks: result.items.map((item) => ({
            id: item.id,
            name: item.name,
            category: item.category,
            cooked: item.cooked,
            favorites: item.favorites,
            lastCookedOn: item.lastCookedOn,
          })),
          total: result.total,
          hint: '`cooked` 是做过几次、`favorites` 是几个人收藏着。说"你家最爱"时就按这两个数字说，别凭印象。',
        })
      } catch (error) {
        return toolResult({ error: humanError(error) })
      }
    }

    if (call.name === TOOL_READ_CHECKINS) {
      const raw = readNumberArg(call.arguments, 'limit')
      const limit = raw === null ? 8 : Math.max(1, Math.min(CHECKIN_LIST_MAX, Math.round(raw)))
      const wantStats = readBooleanArg(call.arguments, 'stats', true)
      try {
        const wall = await this.checkins.wall(userId, { limit })
        const stats = wantStats ? await this.checkins.stats(userId) : null
        /*
         * 照片地址**不给模型**（`photoUrl` 是签名短链）：它用不上，而一段带签名的
         * URL 进了对话上下文就跟着会话落盘（localStorage 里那份历史），
         * 有效期内谁翻到那串字符串都能取到图。模型只需要"谁在什么时候做了什么"。
         */
        return toolResult({
          count: wall.items.length,
          scope: wall.scope,
          hasMore: wall.hasMore,
          entries: wall.items.map((item) => ({
            nickname: item.nickname,
            isMe: item.isMe,
            checkDate: item.checkDate,
            note: item.note,
            mealLabel: item.mealLabel,
            at: item.createdAt,
          })),
          stats: stats
            ? {
                mineTotal: stats.mineTotal,
                familyTotal: stats.familyTotal,
                /** 连续打卡天数：**用热力图里那个数**（`buildHeatmap` 算好的，与"我的"页同一个来源） */
                myStreak: stats.mine.streak,
                familyStreak: stats.family.streak,
                attachableMeals: stats.attachableMeals.slice(0, 5).map((meal) => meal.label),
              }
            : undefined,
          hint: '照着这些数字说：张数、连续天数、谁最近下厨了。'
            + '用户要传照片得去打卡页（对话里的图片是给 AI 看的，不会进打卡墙）。',
        })
      } catch (error) {
        return toolResult({ error: humanError(error) })
      }
    }

    /*
     * ---------- 自建菜谱与收藏（F1-11 / F1-12 / F1-09）----------
     *
     * 这几条与冰箱四件形状一致：真的写库 → 记一条可撤的记录 → 回执卡。
     * **权限边界不在这里**：菜谱那条"只能改自家上传的"写在 `RecipeWriteService` 里，
     * 这里只负责把服务端拒绝的原话回给模型（让它如实转述，而不是自己编一句）。
     */

    if (call.name === TOOL_READ_RECIPES) {
      const query = readStringArg(call.arguments, 'query')
      if (!query) return toolResult({ error: 'query 不能为空，请换个关键词再搜' })
      const viewer = await this.viewerOf(userId)
      const rows = await this.prisma.recipe.findMany({
        // 与列表接口同一个可见范围：全局库 + 自己家的（别人家的自建菜谱看不见，更不能改）
        where: {
          searchText: { contains: query.toLowerCase() },
          ...(viewer.familyId ? { OR: [{ familyId: null }, { familyId: viewer.familyId }] } : { familyId: null }),
        },
        take: SEARCH_RESULTS_MAX,
        orderBy: [{ familyId: 'desc' }, { id: 'asc' }],
      })
      const text = recipeText(rows.map((row) => ({
        id: row.id, name: row.name, category: row.category, cuisine: row.cuisine,
        mine: row.familyId !== null && row.familyId === viewer.familyId,
        sourceLabel: sourceLabel(row.origin),
      })))
      return toolResult({ query, recipes: text.recipes, hint: text.hint })
    }

    if (call.name === TOOL_CREATE_RECIPE) {
      const draft = readRecipeDraft(call.arguments)
      if (!draft) return toolResult({ error: '没解析出菜名或做法步骤，请按 name/category/cuisine/steps 再来一次（步骤至少一步）' })
      try {
        const result = await this.actions.createRecipe(userId, draft)
        receipts.push(...result.actions)
        return toolResult({ result: result.summary, hint: '回执卡已经给用户了，他随时可以撤。记得跟他说存进了「我家的菜谱」。' })
      } catch (error) {
        // 校验不过（名字太长/没步骤…）：把服务端原话回给模型，让它说清该怎么改
        return toolResult({ error: humanError(error) })
      }
    }

    if (call.name === TOOL_UPDATE_RECIPE) {
      const parsed = readRecipePatch(call.arguments)
      if (!parsed) return toolResult({ error: '没解析出 recipeId，请先调 read_recipes 拿准确 id' })
      try {
        const result = await this.actions.updateRecipe(userId, parsed.recipeId, parsed.patch)
        receipts.push(...result.actions)
        return toolResult({ result: result.summary, hint: '回执卡已经给用户了，他随时可以撤。' })
      } catch (error) {
        return toolResult({ error: humanError(error) })
      }
    }

    if (call.name === TOOL_DELETE_RECIPE) {
      const recipeId = readIdArg(call.arguments, 'recipeId')
      if (!recipeId) return toolResult({ error: '没解析出 recipeId，请先调 read_recipes 拿准确 id' })
      const result = await this.actions.removeRecipe(userId, recipeId)
      receipts.push(...result.actions)
      return toolResult({ result: result.summary, hint: '回执卡已经给用户了，他随时可以撤。' })
    }

    if (call.name === TOOL_TOGGLE_FAVORITE) {
      const recipeId = readIdArg(call.arguments, 'recipeId')
      if (!recipeId) return toolResult({ error: '没解析出 recipeId，请先搜一下拿到真实 id' })
      try {
        const result = await this.actions.toggleFavorite(userId, recipeId)
        receipts.push(...result.actions)
        return toolResult({ result: result.summary, favorited: result.favorited, hint: '回执卡已经给用户了，他随时可以撤。' })
      } catch (error) {
        return toolResult({ error: humanError(error) })
      }
    }

    /*
     * ---------- 菜单、餐次与组合（A 档）----------
     *
     * 与冰箱/菜谱同一形状：真的写库 → 记一条可撤的记录（状态流转那件除外，见下）→ 回执卡。
     * 权限不在这里判：`OrdersService` / `CombosService` 里那几道门（这一餐收不收新菜、
     * 只有自己点的能撤、`canEditCombo`）是唯一出口，这里只把服务端的话原样转给模型。
     */

    if (call.name === TOOL_READ_MENU) {
      const days = readNumberArg(call.arguments, 'days') ?? 3
      const rows = await this.menuRows(userId, Math.max(1, Math.min(7, Math.round(days))))
      return toolResult({ menu: menuText(rows), today: todayKey() })
    }

    if (call.name === TOOL_ADD_MENU_ITEMS) {
      const parsed = readMenuAdds(call.arguments, todayKey())
      if (parsed.items.length === 0) {
        return toolResult({ error: `没有可加的菜${parsed.rejected.length ? `（${parsed.rejected.join('、')}）` : ''}，请按 items 数组再试一次` })
      }
      const result = await this.actions.addMenuItems(userId, parsed)
      receipts.push(...result.actions)
      return toolResult({
        result: result.summary,
        rejected: parsed.rejected,
        hint: '回执卡已经给用户了，他随时可以撤。**只说你真加成的那些**。',
      })
    }

    if (call.name === TOOL_REMOVE_MENU_ITEM) {
      const itemId = readIdArg(call.arguments, 'itemId')
      if (!itemId) return toolResult({ error: '没解析出 itemId，请先调 read_menu 拿准确 id' })
      const result = await this.actions.removeMenuItem(userId, itemId)
      receipts.push(...result.actions)
      return toolResult({ result: result.summary, hint: '回执卡已经给用户了，他随时可以放回去。' })
    }

    if (call.name === TOOL_SET_DINERS) {
      const parsed = readDiners(call.arguments)
      if (!parsed) return toolResult({ error: '没解析出 mealKey 或人数，请先调 read_menu 拿 mealKey' })
      try {
        const result = await this.actions.setDiners(userId, parsed.mealKey, parsed.count)
        receipts.push(...result.actions)
        return toolResult({ result: result.summary, hint: '回执卡已经给用户了，他随时可以改回去。' })
      } catch (error) {
        return toolResult({ error: humanError(error) })
      }
    }

    if (call.name === TOOL_SET_MEAL_STATUS) {
      const parsed = readMealStatus(call.arguments)
      if (!parsed) return toolResult({ error: '没解析出 mealKey 或目标状态（只能是 PENDING/PLANNED/COOKING/DONE/CANCELED）' })
      try {
        const result = await this.actions.setMealStatus(userId, parsed.mealKey, parsed.status)
        receipts.push(...result.actions)
        // 这一笔**撤不了**（状态机单向）：提示模型别说"可以撤"，也别说"我改回去了"
        return toolResult({ result: result.summary, hint: '这一步没有撤销，如实告诉用户改成了什么、以及要改回来得去点单页重新安排。' })
      } catch (error) {
        return toolResult({ error: humanError(error) })
      }
    }

    if (call.name === TOOL_REPEAT_MEAL) {
      const parsed = readMealTarget(call.arguments, todayKey())
      if (!parsed) return toolResult({ error: '没解析出 mealKey 或目标日期/餐次，请先调 read_menu' })
      try {
        const result = await this.actions.repeatMeal(userId, parsed)
        receipts.push(...result.actions)
        return toolResult({ result: result.summary, hint: '回执卡已经给用户了，他随时可以撤掉照抄过来的某一道。' })
      } catch (error) {
        return toolResult({ error: humanError(error) })
      }
    }

    if (call.name === TOOL_READ_COMBOS) {
      const combos = await this.combosService.list(userId)
      return toolResult({ combos: comboText(combos.combos.map((combo) => ({
        id: combo.id,
        name: combo.name,
        note: combo.note,
        dishes: combo.dishes.map((dish) => ({ recipeId: dish.recipeId, name: dish.name })),
      }))) })
    }

    if (call.name === TOOL_CREATE_COMBO) {
      const draft = readComboDraft(call.arguments)
      if (!draft || draft.name === undefined || draft.recipeIds === undefined) {
        return toolResult({ error: '要有组合名与至少一道菜（recipeIds），菜 id 请先搜出来' })
      }
      try {
        const result = await this.actions.createCombo(userId, draft)
        receipts.push(...result.actions)
        return toolResult({ result: result.summary, hint: '回执卡已经给用户了，他随时可以撤。' })
      } catch (error) {
        return toolResult({ error: humanError(error) })
      }
    }

    if (call.name === TOOL_UPDATE_COMBO) {
      const comboId = readIdArg(call.arguments, 'comboId')
      const draft = readComboDraft(call.arguments)
      if (!comboId || !draft) return toolResult({ error: '没解析出 comboId，请先调 read_combos 拿准确 id' })
      try {
        const result = await this.actions.updateCombo(userId, comboId, draft)
        receipts.push(...result.actions)
        return toolResult({ result: result.summary, hint: '回执卡已经给用户了，他随时可以改回去。' })
      } catch (error) {
        return toolResult({ error: humanError(error) })
      }
    }

    if (call.name === TOOL_DELETE_COMBO) {
      const comboId = readIdArg(call.arguments, 'comboId')
      if (!comboId) return toolResult({ error: '没解析出 comboId，请先调 read_combos 拿准确 id' })
      const result = await this.actions.removeCombo(userId, comboId)
      receipts.push(...result.actions)
      return toolResult({ result: result.summary, hint: '回执卡已经给用户了，他随时可以放回去。' })
    }

    if (call.name === TOOL_ADD_COMBO_TO_MEAL) {
      const parsed = readMealTarget(call.arguments, todayKey())
      if (!parsed) return toolResult({ error: '没解析出 comboId 或目标日期/餐次（comboId 传给 mealKey 字段）' })
      try {
        const result = await this.actions.addComboToMeal(userId, parsed.mealKey, parsed)
        receipts.push(...result.actions)
        return toolResult({ result: result.summary, hint: '回执卡已经给用户了，他随时可以撤掉其中某一道。' })
      } catch (error) {
        return toolResult({ error: humanError(error) })
      }
    }

    // 模型偶尔会自己发明工具名：回一句"没有这个工具"让它换个说法，而不是崩掉整轮
    return toolResult({ error: `没有名为 ${call.name} 的工具` })
  }

  /**
   * 给模型看的菜单现状（`read_menu` 与 `read_plan` 共用一份查询）。
   *
   * 比 `currentPlan` 多两样模型做决定要用的东西：**每道菜的 itemId**（撤菜靠它）
   * 与**谁点的 / 是不是我点的**（它据此判断"这道我能不能撤"）。
   */
  private async menuRows(userId: string, days: number): Promise<Parameters<typeof menuText>[0]> {
    const membership = await this.prisma.familyMember.findUnique({ where: { userId } })
    if (!membership) return []
    const now = new Date()
    const from = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
    const to = new Date(from.getTime() + days * 86_400_000)
    const meals = await this.prisma.mealOrder.findMany({
      where: { familyId: membership.familyId, mealDate: { gte: from, lt: to } },
      include: { items: { include: { user: { select: { nickname: true } } }, orderBy: { createdAt: 'asc' } } },
      orderBy: [{ mealDate: 'asc' }, { meal: 'asc' }],
    })
    return meals.map((meal) => ({
      mealKey: `${meal.mealDate.toISOString().slice(0, 10)}-${meal.meal}`,
      date: meal.mealDate.toISOString().slice(0, 10),
      meal: meal.meal,
      statusLabel: STATUS_LABEL[meal.status],
      dinerCount: meal.dinerCount,
      dishes: meal.items.map((item) => ({
        itemId: item.id,
        name: item.recipeName,
        who: item.user.nickname,
        mine: item.userId === userId,
        note: item.note,
      })),
    }))
  }

  /**
   * 当前用户的家庭归属（读工具要用它算可见范围）。
   * 没加入家庭时 `familyId` 为 null——那时只看得见全局库里的菜谱。
   */
  private async viewerOf(userId: string): Promise<{ userId: string; familyId: string | null }> {
    const membership = await this.prisma.familyMember.findUnique({
      where: { userId },
      select: { familyId: true },
    })
    return { userId, familyId: membership?.familyId ?? null }
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
  private async candidates(
    hint: string,
    /** 这一家填过的口味档案（空 = 没人填过，那就不过滤：见 taste.rules 文件头 ③） */
    profiles: { userId: string; nickname: string; profile: TasteProfile }[] = [],
  ): Promise<CandidateDish[]> {
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

    /*
     * 口味过滤（F5-03）。放在**抽样之前**：先排掉不合适的，再从剩下的里面挑，
     * 否则"抽了 30 道、排掉 12 道"会让每次推荐的道数忽多忽少。
     * 池子空了也无所谓——那说明这家能吃的菜库里确实没有（比如全员对鸡蛋过敏），
     * 上层会照实说"没挑出来"，而不是硬塞一道不能吃的。
     */
    const allowed = profiles.length
      ? pool.filter((recipe) => judgeDish({
          name: recipe.name,
          spiciness: recipe.spiciness,
          ingredients: readIngredientNames(recipe.ingredients),
        }, profiles).verdict === 'ok')
      : pool

    // 交给模型前**再打乱一次**：清单有序时模型明显偏爱前几条（实测它总挑清单开头那两道），
    // 顺序固定 = 推荐固定——这正是用户看到的"每次都是鱼香肉丝和素炒蘑菇"。
    const picked = sampleList(allowed, SUGGEST_CANDIDATES)

    return picked.map((recipe) => ({
      id: recipe.id,
      name: recipe.name,
      category: recipe.category,
      tags: (recipe.tags as string[] | null)?.slice(0, 4) ?? [],
      spiciness: recipe.spiciness,
    }))
  }

  /** 家庭上下文：今天/明天的安排 + 人数（让推荐与问答都贴着这个家真实的情况） */
  /**
   * 这家填过的口味档案（F5-03 / F3-08 的判据来源）。
   *
   * **只回填过的那些**（`active`）：空白档案不参与判据——"没说过"不是"没限制"，
   * 也不是"什么都不能吃"。全员空白时返回空数组，调用方据此跳过过滤（不必自己判空）。
   */
  private async tasteProfiles(userId: string): Promise<{ userId: string; nickname: string; profile: TasteProfile }[]> {
    const result = await this.taste.family(userId)
    return result.active
  }

  private async familyContext(userId: string): Promise<{
    meal: string | null
    note: string
    summary: string
    /** 这一家的 id；没有家庭时 null。**加载对话图片要用它**（附件按家庭放行） */
    familyId: string | null
    /**
     * 这一家人的口味与忌口（人话摘要，直接进提示词）；没人写过就是 null。
     * **每一轮对话都带上**（用户 2026-10-12 明确要求），见提示词里的说明。
     */
    taste: string | null
  }> {
    const membership = await this.prisma.familyMember.findUnique({
      where: { userId },
      include: { family: { include: { members: true } } },
    })
    if (!membership) {
      const solo = await this.taste.family(userId)
      return { meal: null, note: '', summary: '', familyId: null, taste: tasteText(solo.active) }
    }

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

    const profiles = await this.taste.family(userId)
    return { meal: null, note, summary, familyId: membership.familyId, taste: tasteText(profiles.active) }
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
  if (toolName === TOOL_READ_TASTE) return '正在看谁吃不了什么…'
  if (toolName === TOOL_UPDATE_TASTE) return '正在记下你的口味…'
  // 菜单与组合（每一句都要像家里人在做事的口气，不能出现工具名与字段名）
  if (toolName === TOOL_READ_MENU) return '正在看菜单…'
  if (toolName === TOOL_ADD_MENU_ITEMS) return '正在往菜单里加菜…'
  if (toolName === TOOL_REMOVE_MENU_ITEM) return '正在把这道菜从菜单里撤掉…'
  if (toolName === TOOL_SET_DINERS) return '正在改就餐人数…'
  if (toolName === TOOL_SET_MEAL_STATUS) return '正在改这一餐的状态…'
  if (toolName === TOOL_REPEAT_MEAL) return '正在照抄那一餐…'
  if (toolName === TOOL_READ_COMBOS) return '正在看常用组合…'
  if (toolName === TOOL_CREATE_COMBO) return '正在存这个组合…'
  if (toolName === TOOL_UPDATE_COMBO) return '正在改这个组合…'
  if (toolName === TOOL_DELETE_COMBO) return '正在删这个组合…'
  if (toolName === TOOL_ADD_COMBO_TO_MEAL) return '正在把这一组加进菜单…'
  // 菜谱与收藏（F1-11/F1-12/F1-09）
  if (toolName === TOOL_READ_RECIPES) return '正在翻家里的菜谱…'
  if (toolName === TOOL_CREATE_RECIPE) return '正在把这道菜记进你家的菜谱…'
  if (toolName === TOOL_UPDATE_RECIPE) return '正在改这道菜谱…'
  if (toolName === TOOL_DELETE_RECIPE) return '正在删这道菜谱…'
  if (toolName === TOOL_TOGGLE_FAVORITE) return '正在改收藏…'
  // 采购清单（M7）：口气与别的工具一致——像家里人在做家务，不出现字段名
  if (toolName === TOOL_READ_SHOPPING) return '正在看要买什么…'
  if (toolName === TOOL_ADD_SHOPPING_ITEMS) return '正在把这几样加进采购清单…'
  if (toolName === TOOL_CHECK_SHOPPING_ITEM) return '正在清单上勾一下…'
  if (toolName === TOOL_REMOVE_SHOPPING_ITEM) return '正在从清单上划掉那一样…'
  if (toolName === TOOL_RESTOCK_SHOPPING) return '正在把买到的东西收进冰箱…'
  // 只读三件（用户 2026-10-14）：口气要像家里人在拿主意，不能出现工具名
  if (toolName === TOOL_WHAT_TO_COOK) return '正在帮你拿个主意…'
  if (toolName === TOOL_READ_FAMILY_PICKS) return '正在看家里最爱吃哪几道…'
  if (toolName === TOOL_READ_CHECKINS) return '正在翻打卡墙…'
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

/**
 * 读一个布尔参数。
 *
 * 宽容一点（`'true'` / `1` 也算真）：有的网关把 JSON 里的布尔发成字符串，
 * 而"勾上"与"取消勾"判错的后果正好相反——用户说"买到了"结果清单被取消了勾。
 * 解析不出来时用调用方给的默认值，不抛。
 */
function readBooleanArg(rawArguments: string, key: string, fallback: boolean): boolean {
  try {
    const value = (JSON.parse(rawArguments) as Record<string, unknown>)?.[key]
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') return value.trim().toLowerCase() !== 'false'
    if (typeof value === 'number') return value !== 0
    return fallback
  } catch {
    return fallback
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

/**
 * Prisma 的 `ingredients` 是 Json 列（形状不受类型系统保护），读成配料名给判据用。
 * 脏数据一律丢掉而不是抛：一道菜谱的配料写坏了不该让整次推荐 500。
 */
function readIngredientNames(raw: unknown): { name: string }[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => (item && typeof item === 'object' && 'name' in item ? String((item as { name: unknown }).name) : ''))
    .filter((name) => name.trim() !== '')
    .map((name) => ({ name }))
}

/**
 * 全家口味档案 → 人话（进提示词）。
 *
 * 为什么给人话而不是 JSON：模型读人话更不容易"照着字段名编"（给了 `{"allergies":["花生"]}`
 * 它容易顺势补一个"dislikes":[] 然后开始猜）。人话里**明说哪些是硬拦**，
 * 它才知道"花生过敏"与"不爱吃香菜"在推菜时不是一回事。
 *
 * 空档案返回 null（不产生"这家人没有忌口"这种话——那会让人以为查过了）。
 */
function tasteText(profiles: { nickname: string; profile: TasteProfile }[]): string | null {
  if (profiles.length === 0) return null
  const lines: string[] = []
  for (const entry of profiles) {
    const parts: string[] = []
    if (entry.profile.allergies.length) parts.push(`对${entry.profile.allergies.join('、')}过敏（**绝对不能推荐含这些的菜**）`)
    if (entry.profile.dislikes.length) parts.push(`不吃${entry.profile.dislikes.join('、')}`)
    if (entry.profile.spicyLevel !== null) {
      parts.push(entry.profile.spicyLevel === 0 ? '不吃辣' : `最多吃到${SPICY_LEVELS[entry.profile.spicyLevel]}`)
    }
    if (entry.profile.diet) parts.push(entry.profile.diet)
    if (entry.profile.flavors.length) parts.push(`口味偏${entry.profile.flavors.join('、')}`)
    if (entry.profile.note) parts.push(`备注：${entry.profile.note}`)
    if (parts.length) lines.push(`- ${entry.nickname}：${parts.join('；')}`)
  }
  return lines.length ? lines.join('\n') : null
}

/** 月份 → 季节（给模型看的人话；它据此写"天冷了想喝汤"这类贴时令的句子） */
function seasonOf(month: number): string {
  if (month >= 3 && month <= 5) return '春'
  if (month >= 6 && month <= 8) return '夏'
  if (month >= 9 && month <= 11) return '秋'
  return '冬'
}
