import type { ChatTurn } from '@/api/ai'

/**
 * 全局 AI 助手会话的**纯规则**（F16-10 / D-052；用户 2026-10-13：
 * 「会话历史也要保留啊，还有开启新会话这些」）。
 *
 * 挪到单独一个文件、不写在 store 里，是因为下面三条都是**会算错且错了很难发现**的东西，
 * 必须能直接单测（store 里那层有 persist、有事件流，测起来要造一大堆环境）：
 *
 * ① `wireMessages`：发给模型的只有**最近十条**（后端 `AI_MESSAGES_MAX = 10` 硬卡着），
 *    且**空内容一条都不能发**（`parseChatMessages` 会 400「消息内容不能为空」）。
 *    这两条都不是"最好这样"——是接口的红线，越过去就是一次注定失败的请求。
 * ② `pruneTurns`：落盘前把**还没长出字的 assistant 空格**剪掉。
 *    流式回答途中刷新页面，那格是空的；原样存下来的话，下次打开会看到一个空气泡，
 *    再问一句还会连带把这条空消息发出去 → 400（就是 ① 的第二条）。
 * ③ `chatTimeLabel`：历史列表要显示"什么时候聊的"，得说人话（刚刚/昨天/10月12日）。
 */

/**
 * 一次能带给模型的消息条数上限。
 *
 * **必须与后端 `AI_MESSAGES_MAX` 对齐**（services/api/src/modules/ai/ai.rules.ts）。
 * 这里主动截断而不是把整场对话发过去：后端超限是 400（整句话白问），
 * 而"最近十条"对上下文已经够用——助手办的都是当下的事（记一样、改一下）。
 * 真接上多轮长对话该由后端做摘要，不该靠前端硬塞。
 */
export const WIRE_MAX = 10

/** 一场对话最多留多少句（超出丢最早的）。理由见文件头：落盘的是一段一段的对话，不能无限长 */
export const KEEP_TURNS = 60

/** 最多留几场对话（超出丢最旧的）。localStorage 是有额度的，攒满了会让整个 store 写不进去 */
export const KEEP_CONVERSATIONS = 20

/**
 * 发给模型的消息：**去掉空内容**、只取最近 `WIRE_MAX` 条。
 *
 * 顺序是先过滤再截断——反过来（先截断再过滤）的话，末尾那条空的会把一条有用的话挤掉，
 * 只剩九条。
 *
 * ⚠️ 失败那格与取消那格**没有内容**，下面这个 `.filter` 顺手把它们挡在外面——
 * 它们只是界面上的记号（"这一轮没答上来"），不是对话内容，后端也不收空消息。
 */
export function wireMessages(turns: ChatTurn[]): ChatTurn[] {
  return turns
    /*
     * 只留"有文字 或 有图"的那些：**只看文字会把"拍张照片直接发"这条最自然的用法整条丢掉**
     * （内容为空、图有一张），后端也会因为"消息内容不能为空"而 400。
     */
    .filter((turn) => turn.content.trim() !== '' || (turn.attachments?.length ?? 0) > 0)
    .slice(-WIRE_MAX)
    .map((turn) => ({
      role: turn.role,
      content: turn.content.trim(),
      // 图片 id 要跟着发（服务端凭它去私有桶取字节给模型看）。助手消息没有图，不必带空数组
      ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
    }))
}

/**
 * 落盘前的整理：剪掉末尾那个"还没长出字"的 assistant 空格，并只留最近 `KEEP_TURNS` 句。
 *
 * **只剪末尾，不剪中间**：中间的空格不该出现（流中途失败时 endTurn 已经把它撤了），
 * 真出现了说明别处有 bug——这时候静默剪掉反而把问题藏了，留着它更容易发现。
 *
 * ⚠️ **带 `failed` / `aborted` 的空格不算空格**（用户 2026-10-14：「会话没返回，
 * 最后一条显示的是用户的消息」）：那是"这一轮没答上来"的记号，剪掉它就把
 * 用户看到的唯一线索也删了——他会以为 App 出了问题，而其实是模型那边没回应。
 */
export function pruneTurns(turns: ChatTurn[]): ChatTurn[] {
  const kept = turns.slice(-KEEP_TURNS)
  const last = kept[kept.length - 1]
  // 判"空格"要连图一起看：只有图、没文字的**用户消息是完整的**（拍张照直接发），
  // 按文字判空会把它当成没长出来的那格剪掉，用户的照片就凭空消失了
  const isEmpty = (turn: ChatTurn) => turn.content === '' && (turn.attachments?.length ?? 0) === 0
    && !turn.failed && !turn.aborted
  const trimmed = last?.role === 'assistant' && isEmpty(last) ? kept.slice(0, -1) : kept
  return trimmed
}

/**
 * 一句话当标题：头一句用户话的开头。
 *
 * 为什么不用模型生成的标题：那要多烧一次调用（用户自配的额度），而这场对话是干什么的
 * 从头一句就能看出来（"记一下冰箱里有酸奶"）。截到 14 个字，长句不至于把列表撑破。
 */
export function conversationTitle(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  if (clean === '') return '新的对话'
  return clean.length > 14 ? `${clean.slice(0, 14)}…` : clean
}

/** 历史列表里的时间：说人话，别摆一个 ISO 串（用户看的是"多久以前"） */
export function chatTimeLabel(at: number, now: number = Date.now()): string {
  const diff = now - at
  if (diff < 0) return '刚刚'
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`

  const then = new Date(at)
  const today = new Date(now)
  if (sameDay(then, today)) return `${pad(then.getHours())}:${pad(then.getMinutes())}`
  if (sameDay(then, new Date(now - 86_400_000))) return '昨天'
  if (then.getFullYear() === today.getFullYear()) return `${then.getMonth() + 1} 月 ${then.getDate()} 日`
  return `${then.getFullYear()} 年 ${then.getMonth() + 1} 月 ${then.getDate()} 日`
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
