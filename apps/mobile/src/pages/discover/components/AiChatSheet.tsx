import { useEffect, useRef, useState } from 'react'
import { DotLoading } from 'antd-mobile'
import BottomSheet from '@/components/ui/BottomSheet'
import { apiErrorMessage } from '@/api/client'
import { StreamError, streamAiChat, useAiStatus, type ChatTurn } from '@/api/ai'
import { toast } from '@/components/ui/toast'
import '../../shared.scss'

/**
 * 「问 AI」（M16 子集 / D-026）：带家庭上下文的厨房问答，**流式**回话。
 *
 * 为什么值得做流式：模型要先推理 5～40 秒才吐正文（实测），一次性等回包的话用户
 * 盯着转圈的时间几乎等于全程。流式让第一个字一出现就上屏，剩下的字边收边接——
 * **能看见它在写**和**看不见它在干什么**，等待感是两回事。
 *
 * 历史由前端带着（服务端不存对话）：一次会话内连续问，模型能看到上文；
 * 关掉抽屉就清空——家庭场景里问完就走，不必留一份聊天记录让人翻。
 */

interface AiChatSheetProps {
  visible: boolean
  onClose: () => void
}

/** 常见问法：让用户一眼看到这个入口能问什么（比一句"请输入问题"有用得多） */
const EXAMPLES = ['豆腐买多了怎么存', '两个人吃多少米', '怎么做不辣的川菜']

/** 等第一段文字时的提示轮播：比一个静止的"思考中"更能让人愿意再等几秒 */
const WAITING_TIPS = ['在翻菜谱小书…', '正在想怎么做…', '快好了，先把锅烧上…']

export default function AiChatSheet({ visible, onClose }: AiChatSheetProps) {
  const status = useAiStatus()
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [tip, setTip] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)

  // 关掉抽屉就中断上游调用：用户已经走了，让它继续跑一轮只是白花额度
  useEffect(() => {
    if (!visible) abortRef.current?.abort()
    return () => abortRef.current?.abort()
  }, [visible])

  // 等第一段文字时轮播提示。复位写在**发起提问的事件里**（见 send）而不是这里：
  // 在 effect 里 setState 会多一轮渲染，也会被 react-hooks 的 set-state-in-effect 拦下
  useEffect(() => {
    if (!pending) return
    const timer = setInterval(() => setTip((value) => (value + 1) % WAITING_TIPS.length), 4000)
    return () => clearInterval(timer)
  }, [pending])

  // 有新内容就滚到底：流式输出时用户要看着最后一行，不然字都长在看不见的地方
  // （jsdom 里没有 scrollTo，所以带方法检查——测试环境缺个 API 不该让组件炸）
  useEffect(() => {
    const thread = threadRef.current
    if (typeof thread?.scrollTo === 'function') thread.scrollTo({ top: thread.scrollHeight })
  }, [turns, pending])

  const send = async (text: string) => {
    const content = text.trim()
    if (!content || pending) return
    const history: ChatTurn[] = [...turns, { role: 'user', content }]
    setDraft('')
    setTip(0)
    setPending(true)

    const controller = new AbortController()
    abortRef.current = controller
    // 先把 assistant 那格占上（空字符串），流每来一段就往后接——界面是"边写边长"的样子
    setTurns([...history, { role: 'assistant', content: '' }])
    try {
      await streamAiChat(history, {
        signal: controller.signal,
        onChunk: (chunk) => {
          setTurns((current) => {
            const last = current[current.length - 1]
            if (last?.role !== 'assistant') return current
            return [...current.slice(0, -1), { role: 'assistant', content: last.content + chunk }]
          })
        },
      })
    } catch (error) {
      // 撤掉"还没长出字"的那格 assistant：**中途取消与失败都要撤**，
      // 否则关抽屉再打开会剩一个空气泡（abort 也要撤，这条曾漏掉）
      setTurns((current) => (current[current.length - 1]?.content === '' ? current.slice(0, -1) : current))
      // 用户自己关掉的不算失败（abort 会以异常形式冒出来，别弹一条"出错了"吓人）
      if (controller.signal.aborted) return
      // 失败时**保留**用户问的那句：重问一遍还得重新打字，最气人的就是这个
      toast.error(error instanceof StreamError ? error.message : apiErrorMessage(error))
    } finally {
      setPending(false)
      abortRef.current = null
    }
  }

  return (
    <BottomSheet visible={visible} title="问 AI" onClose={onClose}>
      {status.data && !status.data.configured ? (
        <p className="ai__tip">
          还没接上 AI。在根目录 .env（本机直跑则 services/api/.env）里填 AI_API_BASE / AI_API_KEY / AI_MODEL，
          重启后端就能问。其余功能不受影响。
        </p>
      ) : (
        <>
          {turns.length === 0 && (
            <>
              <p className="ai__lead">下厨上拿不准的都能问：食材怎么处理、多少量、替代做法。</p>
              <div className="ai__hints">
                {EXAMPLES.map((item) => (
                  <button key={item} type="button" className="ai__hint" onClick={() => void send(item)}>
                    {item}
                  </button>
                ))}
              </div>
            </>
          )}

          {turns.length > 0 && (
            <div className="ai__thread" ref={threadRef}>
              {turns.map((turn, index) => (
                <div className={`ai__turn ai__turn--${turn.role}`} key={`${turn.role}-${index}`}>
                  {turn.content}
                  {/* 光标只在"正在长的那一格"里闪：别的地方闪就成了干扰 */}
                  {pending && turn.role === 'assistant' && index === turns.length - 1 && turn.content !== '' && (
                    <span className="ai__caret" aria-hidden />
                  )}
                </div>
              ))}
              {pending && turns[turns.length - 1]?.content === '' && (
                <div className="ai__turn ai__turn--assistant ai__turn--waiting">
                  <DotLoading color="currentColor" />
                  <span className="ai__waiting-text">{WAITING_TIPS[tip]}</span>
                </div>
              )}
            </div>
          )}

          <div className="ai__ask">
            <input
              className="ai__note"
              value={draft}
              maxLength={1000}
              placeholder="问点什么，如：肉怎么去腥"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void send(draft)
              }}
            />
            <button
              type="button"
              className="ai__go"
              disabled={pending || !draft.trim()}
              onClick={() => void send(draft)}
            >
              {pending ? <DotLoading color="currentColor" /> : '问'}
            </button>
          </div>
        </>
      )}
    </BottomSheet>
  )
}
