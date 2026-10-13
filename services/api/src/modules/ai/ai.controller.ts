import { BadRequestException, Body, Controller, Get, Header, HttpCode, HttpException, Param, Post, Req, Res, UseGuards } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { Request, Response } from 'express'
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard'
import { AiService, type ChatEvent } from './ai.service'
import { AiActionService } from './ai-action.service'
import { AiAttachmentService } from './ai-attachment.service'

interface SuggestBody { hint?: string; mealKey?: string }
interface ChatBody { messages?: unknown }
interface AttachmentBody { image?: unknown; contentType?: unknown }
interface ScanBody { attachmentId?: unknown }

@ApiTags('ai')
@Controller('ai')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly actions: AiActionService,
    private readonly attachments: AiAttachmentService,
  ) {}

  // 免登录可读：前端据此决定显示"AI 帮你想"还是"先去配置"（不含密钥）
  @Get('status')
  @ApiOperation({ summary: 'AI 是否已配置（M16 子集；不含密钥）' })
  status() {
    return this.ai.status()
  }

  /**
   * AI 还没撤的那些写库动作（F16-10）。
   *
   * ⚠️ **前端目前不调它**：回执卡随对话一起落盘在本地（用户 2026-10-13 要求"会话历史也要保留"），
   * 所以重开抽屉/刷新页面时卡片直接来自本地那份，不必问服务端。
   *
   * 留着它有两个实在的用处：① 验收脚本靠它断言"写入记录真的进了库、撤销后被标记"
   * （见 scripts/verify-ai-actions-http.cjs）；② 它是这张表的**服务端视角**——
   * 本地那份是"这台设备上聊过什么"，而这里是"这个人在服务端还有哪些没撤的写入"，
   * 将来要做多端同步或"AI 改过什么"的审计视图，读的就是这个（不是本地缓存）。
   */
  @Get('actions')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'AI 可撤销的写库动作（最近若干笔）' })
  async listActions(@CurrentUserId() userId: string) {
    return { items: await this.actions.recent(userId) }
  }

  /**
   * 撤销一笔 AI 写库。
   *
   * **用 POST 不用 DELETE**：撤销不是"删掉那条记录"，而是"执行一个反向动作"
   * （撤销一次新建 = 删；撤销一次删除 = 重建）。DELETE 语义表达不了重建。
   *
   * 三种拒绝都由服务端判定并给出人话（已在别处改过 / 已经不在了 / 已经撤过），
   * 见 `ai-action.rules` 的 `planUndo`——不给"猜一个最像的"的机会。
   */
  @Post('actions/:id/undo')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '撤销一笔 AI 写库动作' })
  async undo(@CurrentUserId() userId: string, @Param('id') id: string) {
    if (!id?.trim()) throw new BadRequestException('缺一个要撤销的 id')
    return this.actions.undo(userId, id.trim())
  }

  /**
   * 对话里的图片附件（F16-05；用户 2026-10-13「ai助手那里也需要添加附件上传功能」）。
   *
   * 前端先传图拿 id，再把 id 放进消息里（见 `chatStream`）。**图片字节不走消息体**：
   * 会话是整场落盘在浏览器 localStorage 的（约 5MB），一张缩过的照片也有几百 KB，
   * 塞两张就会写失败——而且失败是静默的，连对话本身都存不进去。
   *
   * 限流比照打卡上传（也是重操作：解码 + 写私有桶）。
   */
  @Post('attachments')
  @HttpCode(201)
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '上传一张对话图片，返回它的 id' })
  async uploadAttachment(@CurrentUserId() userId: string, @Body() body: AttachmentBody) {
    return this.attachments.create(userId, body)
  }

  /**
   * 取回一张对话图片的字节。
   *
   * 与打卡照片同一条路（**不放直链**）：这些图在家里冰箱/厨房的照片一级，
   * 链接一旦泄漏就等于永久可读。所以过两道门——签名（这里省了，因为有登录令牌）
   * 与家庭归属，再校验一次身份后才从私有桶读字节。
   *
   * `Cache-Control: private` 而不是 `no-store`：同一张图在会话里会被反复显示
   * （滚动、切会话），每次都重取会白烧流量；但**不能给中间代理缓存**。
   */
  @Get('attachments/:id/photo')
  @UseGuards(JwtAuthGuard)
  @Header('Cache-Control', 'private, max-age=3600')
  @ApiOperation({ summary: '取一张对话图片的字节（限同家庭）' })
  async attachmentPhoto(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Res() response: Response,
  ) {
    const photo = await this.attachments.read(userId, id)
    response.setHeader('Content-Type', photo.contentType)
    response.setHeader('Content-Length', String(photo.body.byteLength))
    response.end(photo.body)
  }

  /**
   * 冰箱拍照识别（F16-04）：一张图 → 食材清单草稿。
   *
   * **只回草稿，不写库**：用户逐项确认校正之后，前端走用户自己那条 `POST /fridge` 入库
   * （与手填同一个口）。直接入库的后果不是"多了一条错的"那么轻——冰箱是"今日先吃"
   * 与推荐的输入，错一条会让用户照着过期的做菜。
   */
  @Post('scan-fridge')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '拍照识别冰箱食材（只回草稿，入库要用户确认）' })
  async scanFridge(@CurrentUserId() userId: string, @Body() body: ScanBody, @Req() request: Request) {
    const attachmentId = typeof body?.attachmentId === 'string' ? body.attachmentId.trim() : ''
    if (!attachmentId) throw new BadRequestException('缺一个图片 id（先调 /ai/attachments 上传）')
    return this.ai.scanFridge(userId, attachmentId, abortSignal(request))
  }

  /**
   * AI 调用限流压到 10 次/分：每一次都是一笔真实开销（用户自己的额度），
   * 家庭场景里一分钟十次已经远超正常使用（全局限流 60 次/分在这里太宽松了）。
   */
  @Post('suggest')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '按材料/口味推荐这一餐吃什么（只从本库菜里挑）' })
  async suggest(@CurrentUserId() userId: string, @Body() body: SuggestBody, @Req() request: Request) {
    const { hint, mealKey } = body ?? {}
    if (hint !== undefined && typeof hint !== 'string') throw new BadRequestException('hint 只能是文字')
    if (mealKey !== undefined && typeof mealKey !== 'string') throw new BadRequestException('mealKey 只能是文字')
    // 客户端断开时把取消传下去，别让上游白跑一轮（signal 见 ai.client）
    return this.ai.suggest(userId, { hint, mealKey }, abortSignal(request))
  }

  @Post('chat')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '问 AI：带家庭上下文的厨房问答' })
  async chat(@CurrentUserId() userId: string, @Body() body: ChatBody, @Req() request: Request) {
    return this.ai.chat(userId, (body ?? {}).messages, abortSignal(request))
  }

  /**
   * 快问与示例问题（用户 2026-10-12：「这块也要使用ai吧，内置的这些不够用」）。
   *
   * 同样限流 10 次/分：这也是一次真实的上游调用。前端**只在抽屉打开时拉一次**并缓存
   * （`staleTime` 半小时），所以正常使用不会反复触发——它生成的是"这个家的画像"，
   * 不是每句话都要变的东西。
   */
  @Post('prompts')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '按家庭情况生成快问/示例问题（写死的那份只作兜底）' })
  async prompts(@CurrentUserId() userId: string, @Req() request: Request) {
    return this.ai.prompts(userId, abortSignal(request))
  }

  /**
   * 问 AI（流式）：SSE 逐段回，前端边收边上屏（D-026）。
   *
   * 顺序上有一个**必须**的讲究：先把生成器推进到第一段、拿到它，才写响应头。
   * 反过来的话，输入错（400）与没配置（503）就只能在已经发出 200 之后再报，
   * 前端拿到的是"一个正常的流里忽然蹦出一段报错"——状态码已经没得改了。
   *
   * 每段用 `event: <类型>` + `data: {...}` 的**具名事件**发给前端（D-026 第三次补充）：
   * - `text`：正文增量，上屏；
   * `status`：工具执行中的一句人话（"正在翻菜谱…"）。工具轮次要 3~5 秒，没有这句就像卡住了；
   * `proposals`：攒好的"加菜建议"，界面据此长出确认按钮（**用户点了才真写库**）；
   * `error`：头已经发出去了，失败只能当流里的一条事件报。
   *
   * 具名事件是为了让前端**按类型分派**而不是去猜 JSON 里有哪些字段；正文仍然包在 JSON 里
   * （模型的话有换行，裸文本按行解析必然错位）。
   */
  @Post('chat/stream')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '问 AI（流式 SSE，支持对话内点菜工具）' })
  async chatStream(
    @CurrentUserId() userId: string,
    @Body() body: ChatBody,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const stream = this.ai.chatStream(userId, (body ?? {}).messages, abortSignal(request))
    // 先取第一段：这一步会把 400（消息不合法）与 503（没配 AI）在写响应头**之前**抛出来
    const first = await stream.next()

    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    // 关掉反向代理的缓冲，否则"流式"会被攒成一坨再发给浏览器
    response.setHeader('X-Accel-Buffering', 'no')
    response.flushHeaders?.()

    const send = (event: ChatEvent) => {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    }

    try {
      if (!first.done) send(first.value)
      for await (const chunk of stream) {
        if (response.writableEnded) break
        send(chunk)
      }
      response.write('data: [DONE]\n\n')
    } catch (error) {
      // 头已经发出去了，状态码改不了：把失败当成流里的一条错误事件（前端据此提示）
      const message = error instanceof HttpException
        ? (error.getResponse() as { message?: string }).message ?? error.message
        : 'AI 服务开小差了，过会儿再试'
      response.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: message })}\n\n`)
    } finally {
      response.end()
    }
  }
}

/**
 * 客户端断开时把取消传导给上游（别让上游白跑一轮、白花一次额度）。
 *
 * 只听 `aborted`，**不听 `close`**：Express 在正常请求走完时也会发 `close`，
 * 挂上去就会把"已经开始的上游调用"当场取消掉（每个请求都变成 504）。
 */
function abortSignal(request: Request): AbortSignal {
  const controller = new AbortController()
  request.on('aborted', () => controller.abort())
  return controller.signal
}
