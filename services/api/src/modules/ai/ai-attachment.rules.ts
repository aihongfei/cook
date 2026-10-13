/**
 * AI 附件（对话里的图片）的**纯规则**：形态、额度、以及"发给模型的消息长什么样"。
 *
 * 与其它模块同一套路：不碰网络与数据库的判定都在这里，单测直接验。
 *
 * 一条贯穿的约束来自**两个不同的上限**，别混：
 * - `AI_MESSAGE_MAX = 1000`（单条消息的字数）——管的是**文本**；
 * - 图片字节不进那个上限（它走 base64、另算），所以图片有自己的字节上限与张数上限。
 * 把两者当成一个数是错的：一张 500KB 的图 base64 之后是 68 万字符，
 * 拿它去比 1000 会得出"任何图都超限"这种离谱结论。
 */

import { BadRequestException } from '@nestjs/common'
import { IMAGE_MAX_BYTES } from '../media/image.rules'

/** 一条消息最多带几张图 */
export const ATTACH_PER_MESSAGE_MAX = 3

/**
 * 一次对话请求里，**所有消息加起来**最多几张图。
 *
 * 为什么要有这一条（单条 3 张还不够）：历史消息会连同图片一起重发（模型要看上下文），
 * 十条消息各带 3 张就是 30 张、十几 MB 上到上游——那不是"用户想要的功能"，是账单与超时。
 * 所以按**整个请求**卡一个总额度。
 */
export const ATTACH_TOTAL_MAX = 4

/** 一张图最多多大（与菜谱配图、打卡照片同一个数：前端都已缩到 1600px，这是兜底） */
export const ATTACH_MAX_BYTES = IMAGE_MAX_BYTES

/** 一个家庭里留存多少张（超出之后最老的会被清理，见 service 的 prune） */
export const ATTACH_KEEP_PER_FAMILY = 200

/**
 * 单条消息的图片引用（前端只传 id，字节在服务端）。
 *
 * **为什么不直接传 dataURL**：会话整场落盘在浏览器 localStorage（约 5MB），
 * 一张照片缩完也有几百 KB——塞两张就会写失败，而且**失败是静默的**：连对话本身
 * 都存不进去，用户下次打开发现整场对话没了。所以前端手里只留 id。
 */
export interface ChatAttachmentRef {
  /** `AiAttachment` 的 id */
  id: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** 这条消息带的图片（**只有 user 消息有**：模型不会返图） */
  attachments?: string[]
}

/** 一列 id：去空、去重、上限。非法形状直接拒（不静默丢掉——用户会以为图传上去了） */
export function parseAttachmentIds(raw: unknown): string[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new BadRequestException('图片要是一个列表')
  const out: string[] = []
  for (const item of raw) {
    const id = typeof item === 'string' ? item.trim() : ''
    if (!id) throw new BadRequestException('图片 id 不能为空')
    if (id.length > 64) throw new BadRequestException('图片 id 看着不对')
    if (!out.includes(id)) out.push(id)
  }
  if (out.length > ATTACH_PER_MESSAGE_MAX) {
    throw new BadRequestException(`一条消息最多带 ${ATTACH_PER_MESSAGE_MAX} 张图`)
  }
  return out
}

/**
 * 解析整轮对话的消息。
 *
 * 三条硬线（与 `ai.rules` 的文本版同源，但那边不认识 `attachments`）：
 * - 只放行 user/assistant（system 由服务端拼，不让调用方顶掉提示词）；
 * - 单条文本上限、总条数上限；
 * - **图片总数上限**（`ATTACH_TOTAL_MAX`）——历史会连着图一起重发，不卡总额会一路涨。
 *
 * 允许"只有图片、没有文字"的消息（用户拍张照直接发是最自然的用法），
 * 所以判空要看**文本与图片是不是都空**，而不是只看文本。
 */
export function parseChatMessagesWithImages(
  raw: unknown,
  limits: { messagesMax: number; messageMax: number },
): ChatMessage[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new BadRequestException('至少要有一句话')
  if (raw.length > limits.messagesMax) throw new BadRequestException(`一次最多带 ${limits.messagesMax} 条消息`)

  let total = 0
  const out = raw.map((item) => {
    const role = (item as { role?: unknown })?.role
    const content = (item as { content?: unknown })?.content
    if (role !== 'user' && role !== 'assistant') throw new BadRequestException('消息角色只能是 user 或 assistant')
    if (content !== undefined && typeof content !== 'string') throw new BadRequestException('消息内容只能是文字')

    const text = (content ?? '').trim()
    // 助手消息不带图：模型不会返图，带了说明是前端拼错了
    const attachments = role === 'user' ? parseAttachmentIds((item as { attachments?: unknown })?.attachments) : []
    if (!text && attachments.length === 0) throw new BadRequestException('消息内容不能为空')
    if (text.length > limits.messageMax) throw new BadRequestException(`单条消息最多 ${limits.messageMax} 个字`)

    total += attachments.length
    return { role: role as 'user' | 'assistant', content: text, ...(attachments.length ? { attachments } : {}) }
  })

  if (total > ATTACH_TOTAL_MAX) {
    throw new BadRequestException(`一次最多带 ${ATTACH_TOTAL_MAX} 张图（历史里的图也算）`)
  }
  return out
}

/**
 * 把"这条消息带了哪些图"翻成给模型看的内容块。
 *
 * 文本与图片的相对顺序是**文字在前**：模型的注意力会落在最后一块上，
 * 而"这是我家冰箱"这类交代说完紧跟着图，比图在前、话在后更好用（实测里后者
 * 更容易被答成"你发了张图"）。
 *
 * `content` 为空时**不能塞空文本块**：有的网关会把空 text 块判成非法，
 * 而"只发一张图不说话"恰恰是最常见的用法。
 */
export function toModelContent(
  text: string,
  images: { data: string; mimeType: string }[],
): string | ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] {
  if (images.length === 0) return text
  const blocks: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = []
  if (text) blocks.push({ type: 'text', text })
  for (const image of images) blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType })
  return blocks
}
