import { useEffect, useRef, useState } from 'react'
import { DotLoading } from 'antd-mobile'
import BottomSheet from '@/components/ui/BottomSheet'
import { apiErrorMessage } from '@/api/client'
import { StreamError, streamAiChat, useAiPrompts, useAiStatus, type ChatTurn, type MenuProposal } from '@/api/ai'
import { useAddOrderItem } from '@/api/orders'
import { toast } from '@/components/ui/toast'
import { pickExamples } from '../ai-prompts'
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
 *
 * **对话里就能点菜**（用户 2026-10-12 第③项）：后端给模型挂了几个工具，它会自己去菜谱库
 * 搜真实的菜，再提一份"要不要加进菜单"的建议（`proposals` 事件）。这里做两件事：
 * ① 工具跑的时候显示它给的短句（"正在翻菜谱…"）——那几秒本来只有光标在闪，像卡住了；
 * ② 把建议渲染成卡片，**用户点了"加入菜单"才真写库**（走与手点同一条 `/orders/items`）。
 * 所以卡片上给的是"加入菜单/先不用"两个按钮，而不是让模型直接改菜单。
 *
 * 示例问题由 AI 按这家人的情况现生成（用户 2026-10-12：「内置的这些不够用」），
 * 写死的那份只作兜底：没配、还没生成好、生成失败时照旧能用（见 ai-prompts）。
 */

interface AiChatSheetProps {
  visible: boolean
  onClose: () => void
}

/** 等第一段文字时的提示轮播：比一个静止的"思考中"更能让人愿意再等几秒 */
const WAITING_TIPS = ['在翻菜谱小书…', '正在想怎么做…', '快好了，先把锅烧上…']

export default function AiChatSheet({ visible, onClose }: AiChatSheetProps) {
  const status = useAiStatus()
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [tip, setTip] = useState(0)
  // 工具执行中的短句（后端 event: status）。有它时优先显示它——它比"在翻菜谱小书…"具体
  const [stage, setStage] = useState('')
  // 模型提的加菜建议。**只是建议**：点了"加入菜单"才真的写进那一餐
  const [proposals, setProposals] = useState<MenuProposal[]>([])
  /** 已经点过确认的那几条（按 recipeId+餐次记），点过就置灰，避免重复加 */
  const [added, setAdded] = useState<string[]>([])
  const addItem = useAddOrderItem()
  // 示例问题：优先用 AI 按这个家现生成的那批（与「AI 帮你想」共用一次请求，见 api/ai）。
  // `enabled` 等 status 回来再开——没配时不该白发一次注定 503 的请求；失败静默退回写死的那份
  const aiPrompts = useAiPrompts(status.data?.configured === true)
  // 用函数形式初始化：每次打开（调用方 key 重挂载）抽一批新的，且**不在渲染里现抽**
  // （在渲染里抽的话每轮渲染都换一批，用户刚要点的那个会自己跑掉）
  const [examples, setExamples] = useState(() => pickExamples())
  // AI 那批到手后重抽一次（打开头几秒必然是兜底那批；不重抽的话 AI 生成的就白花了）。
  // 与 AiSuggestSheet 那处同一写法、同一理由（见那边对 react(set-state-in-effect) 的说明）
  const aiBatch = aiPrompts.data?.examples
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    if (aiBatch && aiBatch.length > 0) setExamples(pickExamples(aiBatch))
  }, [aiBatch])
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
    setStage('')
    // 上一轮的建议随提问一起清掉：它属于上一句回答，留着会让人以为"还在等你决定"
    setProposals([])
    setPending(true)

    const controller = new AbortController()
    abortRef.current = controller
    // 先把 assistant 那格占上（空字符串），流每来一段就往后接——界面是"边写边长"的样子
    setTurns([...history, { role: 'assistant', content: '' }])
    try {
      await streamAiChat(history, {
        signal: controller.signal,
        onStatus: setStage,
        onProposals: setProposals,
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
      setStage('')
      abortRef.current = null
    }
  }

  /** 用户点了"加入菜单"：走与手点同一条接口，成功了把这张卡置灰 */
  const confirmProposal = (item: MenuProposal) => {
    addItem.mutate(
      { recipeId: item.recipeId, mealDate: item.mealDate, meal: item.meal, note: item.note || undefined },
      {
        onSuccess: (card) => {
          toast.success(`已把「${item.name}」加进${card.mealLabel}`)
          setAdded((current) => [...current, `${item.recipeId}|${item.mealDate}|${item.meal}`])
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
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
              <div className="ai__hint-row">
                <span className="ai__hint-label">试试问</span>
                <div className="ai__hints">
                  {examples.map((item) => (
                    <button key={item} type="button" className="ai__hint" onClick={() => void send(item)}>
                      {item}
                    </button>
                  ))}
                  {/* 「换一批」而不铺满整池：铺满会把输入框挤到屏幕外，而这个入口本来就要打字。
                      它**不重新调模型**——就在已经拿到的那批里抽 */}
                  <button type="button" className="ai__hint ai__hint--more" onClick={() => setExamples(pickExamples(aiBatch))}>
                    换一批 ↻
                  </button>
                </div>
              </div>
            </>
          )}

          {turns.length > 0 && (
            <div className="ai__thread" ref={threadRef}>
              {turns.map((turn, index) => {
                // 内容还是空的那格 assistant **不画**：它只是给流式正文预留的位置。
                // 画出来就是个空圈（.ai__turn 有内边距 + 圆角），用户 2026-10-12 指着截图说
                // 「这块多了一个圆圈」——正是它。等待态由下面那格"正在想…"负责，这里什么都不出。
                if (turn.role === 'assistant' && turn.content === '') return null
                return (
                  <div className={`ai__turn ai__turn--${turn.role}`} key={`${turn.role}-${index}`}>
                    {turn.content}
                    {/* 光标只在"正在长的那一格"里闪：别的地方闪就成了干扰 */}
                    {pending && turn.role === 'assistant' && index === turns.length - 1 && (
                      <span className="ai__caret" aria-hidden />
                    )}
                  </div>
                )
              })}
              {pending && turns[turns.length - 1]?.content === '' && (
                <div className="ai__turn ai__turn--assistant ai__turn--waiting">
                  <DotLoading color="currentColor" />
                  {/* 有工具状态就先说工具在干什么：那几秒用户至少知道系统真的在动
                      （工具轮次实测 3~5 秒一轮，两三轮就是十几秒） */}
                  <span className="ai__waiting-text">{stage || WAITING_TIPS[tip]}</span>
                </div>
              )}

              {/* 加菜建议：只在回答说完之后出现，且**要用户点确认才写库** */}
              {!pending && proposals.length > 0 && (
                <div className="ai__proposals">
                  <div className="ai__proposals-lead">要加进菜单吗？</div>
                  {proposals.map((item) => {
                    const key = `${item.recipeId}|${item.mealDate}|${item.meal}`
                    const done = added.includes(key)
                    return (
                      <div className={['ai__proposal', done && 'is-done'].filter(Boolean).join(' ')} key={key}>
                        <div className="ai__proposal-main">
                          <span className="ai__proposal-name">{item.name}</span>
                          <span className="ai__proposal-when">{item.when}</span>
                          {item.note && <span className="ai__proposal-note">{item.note}</span>}
                        </div>
                        {done ? (
                          <span className="ai__proposal-done">已加入</span>
                        ) : (
                          <button
                            type="button"
                            className="ai__proposal-add"
                            disabled={addItem.isPending}
                            onClick={() => confirmProposal(item)}
                          >
                            加入菜单
                          </button>
                        )}
                      </div>
                    )
                  })}
                  {/* "先不用"不给按钮：不点就是不用，多一个按钮等于多一次确认打扰 */}
                  <button type="button" className="ai__proposal-skip" onClick={() => setProposals([])}>
                    先不用
                  </button>
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
