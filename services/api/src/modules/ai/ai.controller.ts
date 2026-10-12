import { BadRequestException, Body, Controller, Get, HttpCode, HttpException, Post, Req, Res, UseGuards } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { Request, Response } from 'express'
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard'
import { AiService } from './ai.service'

interface SuggestBody { hint?: string; mealKey?: string }
interface ChatBody { messages?: unknown }

@ApiTags('ai')
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  // 免登录可读：前端据此决定显示"AI 帮你想"还是"先去配置"（不含密钥）
  @Get('status')
  @ApiOperation({ summary: 'AI 是否已配置（M16 子集；不含密钥）' })
  status() {
    return this.ai.status()
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
   * 问 AI（流式）：SSE 逐段回，前端边收边上屏（D-026）。
   *
   * 顺序上有一个**必须**的讲究：先把生成器推进到第一段、拿到它，才写响应头。
   * 反过来的话，输入错（400）与没配置（503）就只能在已经发出 200 之后再报，
   * 前端拿到的是"一个正常的流里忽然蹦出一段报错"——状态码已经没得改了。
   *
   * 每段用 `data: {"text":"..."}` 包一层 JSON 而不是直接发裸文本：
   * 模型的话里有换行，裸文本按行解析必然错位。
   */
  @Post('chat/stream')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '问 AI（流式 SSE）' })
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

    const send = (payload: { text?: string; error?: string }) => {
      response.write(`data: ${JSON.stringify(payload)}\n\n`)
    }

    try {
      if (!first.done) send({ text: first.value })
      for await (const chunk of stream) {
        if (response.writableEnded) break
        send({ text: chunk })
      }
      response.write('data: [DONE]\n\n')
    } catch (error) {
      // 头已经发出去了，状态码改不了：把失败当成流里的一条错误事件（前端据此提示）
      const message = error instanceof HttpException
        ? (error.getResponse() as { message?: string }).message ?? error.message
        : 'AI 服务开小差了，过会儿再试'
      send({ error: message })
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
