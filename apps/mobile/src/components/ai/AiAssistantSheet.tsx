import { useCallback, useEffect, useRef, useState } from 'react'
import { DotLoading } from 'antd-mobile'
import { useQueryClient } from '@tanstack/react-query'
import BottomSheet from '@/components/ui/BottomSheet'
import { apiErrorMessage } from '@/api/client'
import {
  StreamError, streamAiChat, useAiStatus, useUndoAiAction, type AiReceipt,
} from '@/api/ai'
import { useAddOrderItem } from '@/api/orders'
import { toast } from '@/components/ui/toast'
import { selectActiveConversation, useAiAssistantSession } from '@/stores/ai-assistant-session'
import { chatTimeLabel, wireMessages } from '@/stores/ai-assistant.rules'
import AiReceiptCard from '@/components/ai/AiReceiptCard'
import './ai-assistant.scss'

/**
 * 全局 AI 助手（F16-10 / D-052，用户 2026-10-13 拍板"悬浮球 + A 档 + 加表"，
 * 并追加「会话历史也要保留啊，还有开启新会话这些」）。
 *
 * 与「问 AI」（发现页那个）是**同一套后端能力**，差别在**它能办事**：说一句"记一下酸奶"，
 * 冰箱里真的多一条，对话里挂一张带「撤」的回执卡。所以这里比 AiChatSheet 多几样东西：
 * 回执卡、"跨页且跨刷新"的多场会话（见 stores/ai-assistant-session）、以及历史列表。
 *
 * 四件事值得先知道：
 *
 * ① **状态全在 store 里，组件只负责画**。用户在冰箱页说一句话，收起抽屉去看那条有没有出现，
 *    再点悬浮球回来——那一轮对话、那张回执、那个「撤」都还在（刷新页面也还在）。
 *    「撤」是这一档唯一的安全网，不能只在"别切页、别刷新"的前提下存在。
 *
 * ② **发给模型的只有最近十条**（`wireMessages`）：后端 `AI_MESSAGES_MAX = 10` 硬卡着，
 *    超一条就是 400 整句白问。历史是给**人**看的，不是一股脑塞给模型的。
 *
 * ③ **回执卡只在收到 `receipts` 事件时才画**。模型嘴上说"记好了"而服务端没给回执，
 *    那就是它在吹牛——不画卡就等于当场戳穿（D-052：卡片是那句话的证据）。
 *
 * ④ **撤销的判断一个字都不在前端**。前端只把那一笔的 id 发过去，成不成由服务端说
 *    （用户自己改过 / 那条已经不在了 / 已经撤过了，三种都要给出人话）。
 */
export default function AiAssistantSheet() {
  const open = useAiAssistantSession((state) => state.open)
  const conversation = useAiAssistantSession(selectActiveConversation)
  const conversations = useAiAssistantSession((state) => state.conversations)
  const draft = useAiAssistantSession((state) => state.draft)
  const pending = useAiAssistantSession((state) => state.pending)
  const stage = useAiAssistantSession((state) => state.stage)
  const proposals = useAiAssistantSession((state) => state.proposals)
  const added = useAiAssistantSession((state) => state.added)
  const historyOpen = useAiAssistantSession((state) => state.historyOpen)
  const closeSheet = useAiAssistantSession((state) => state.closeSheet)
  const startNew = useAiAssistantSession((state) => state.startNew)
  const selectConversation = useAiAssistantSession((state) => state.selectConversation)
  const removeConversation = useAiAssistantSession((state) => state.removeConversation)
  const toggleHistory = useAiAssistantSession((state) => state.toggleHistory)
  const setDraft = useAiAssistantSession((state) => state.setDraft)
  const beginTurn = useAiAssistantSession((state) => state.beginTurn)
  const appendChunk = useAiAssistantSession((state) => state.appendChunk)
  const endTurn = useAiAssistantSession((state) => state.endTurn)
  const setStage = useAiAssistantSession((state) => state.setStage)
  const setProposals = useAiAssistantSession((state) => state.setProposals)
  const markAdded = useAiAssistantSession((state) => state.markAdded)
  const addReceipts = useAiAssistantSession((state) => state.addReceipts)
  const markUndone = useAiAssistantSession((state) => state.markUndone)

  const status = useAiStatus()
  const undo = useUndoAiAction()
  const addItem = useAddOrderItem()
  const queryClient = useQueryClient()
  /** 正在撤的那一笔（给那一行转圈，避免连点） */
  const [undoing, setUndoing] = useState<string | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const turns = conversation?.turns ?? []
  const receipts = conversation?.receipts ?? []

  /*
   * 关掉抽屉就中断上游调用：用户已经走了，让它继续跑一轮只是白花他自己的额度
   * （AI 是用户自配的，每次都是他的钱）。历史里那半句已经落库（endTurn 会收尾），
   * 下一句重新发起即可。
   */
  useEffect(() => {
    if (!open) abortRef.current?.abort()
    return () => abortRef.current?.abort()
  }, [open])

  // 有新内容就滚到底：流式输出时用户要看着最后一行
  // （jsdom 里没有 scrollTo，所以带方法检查——测试环境缺个 API 不该让组件炸）
  useEffect(() => {
    const thread = threadRef.current
    if (typeof thread?.scrollTo === 'function') thread.scrollTo({ top: thread.scrollHeight })
  }, [turns, pending])

  /** 收到回执：挂到对话里，并让冰箱那页把缓存作废 */
  const handleReceipts = useCallback((items: AiReceipt[]) => {
    addReceipts(items)
    /*
     * **AI 写完之后要把冰箱页那份缓存作废**（用户 2026-10-13 的核心要求：
     * "我说一句它真的把冰箱改了、并且我看得见"）。
     *
     * 不这么做的话：写入是真的（库里有了、回执卡也在），但冰箱页那份 react-query 缓存
     * （`staleTime: 30s`）还以为自己是最新的，用户收起抽屉看到的仍是写之前那份列表——
     * 真去刷新一下会发现东西在，但那一瞬间他会以为"AI 说记好了，冰箱里却没有"。
     * 这是**浏览器实证抓到的**：库里已经有苹果和豆腐，页面上还是那四样。
     *
     * 只作废不动手改：手里没有新的板子（回执里只有一句摘要），硬拼一份缓存只会
     * 拼出与后端不一致的东西。作废之后冰箱页会自己重新取一次。
     */
    void queryClient.invalidateQueries({ queryKey: ['fridge'] })
  }, [addReceipts, queryClient])

  const send = useCallback(async (text: string) => {
    const content = text.trim()
    if (!content || useAiAssistantSession.getState().pending) return
    /*
     * 历史要**在 beginTurn 之前**取（它会把这一句推上去），并且**先过 wireMessages**：
     * 只发最近十条、且一条空的都不带（后端两条红线，见文件头 ②）。
     *
     * ⚠️ 这一句**必须一起进去过筛**，不能写成"截十条历史 + 追加这一句"——
     * 那样总数是十一条，后端 `AI_MESSAGES_MAX = 10` 直接 400（第一版就是那么写的，
     * 单测当场算出 11 条把它抓红了）。新问的这句本来就该占掉最老的那条的位置。
     */
    const history = wireMessages([...turns, { role: 'user' as const, content }])
    beginTurn(content)

    const controller = new AbortController()
    abortRef.current = controller
    try {
      await streamAiChat(history, {
        signal: controller.signal,
        onStatus: setStage,
        // 回执挂到"当前这轮"下面——它证明的就是这句话
        onReceipts: handleReceipts,
        onProposals: setProposals,
        onChunk: appendChunk,
      })
      endTurn()
    } catch (error) {
      endTurn({ dropEmptyAssistant: true })
      // 用户自己关掉的不算失败（abort 会以异常形式冒出来，别弹一条"出错了"吓人）
      if (controller.signal.aborted) return
      // 失败时**保留**用户问的那句（endTurn 只撤空的那格 assistant）：重问一遍还得重新打字
      toast.error(error instanceof StreamError ? error.message : apiErrorMessage(error))
    } finally {
      abortRef.current = null
    }
  }, [appendChunk, handleReceipts, beginTurn, endTurn, setProposals, setStage, turns])

  /** 撤一笔：成不成由服务端说，前端只负责把结果如实转达 */
  const undoReceipt = (item: AiReceipt) => {
    if (undoing) return
    setUndoing(item.id)
    undo.mutate(item.id, {
      onSuccess: (result) => {
        /*
         * **只有真撤成了才划掉那一行**（`undone: true`）。
         *
         * `undone: false` 是服务端在说"其实没什么可撤的"（那条已经不在了 / 你自己又加回来了）——
         * 结果虽然是用户想要的，但**一笔都没撤**。这时候把那一行划掉、写"已撤掉"，
         * 就是在宣称一件没发生的事。所以这条分支只转达那句话，卡片原样不动。
         */
        if (result.undone) {
          markUndone(item.id)
          toast.success(result.message)
        } else {
          toast.error(result.message)
        }
      },
      onError: (error) => toast.error(apiErrorMessage(error)),
      onSettled: () => setUndoing(null),
    })
  }

  /** 用户点了"加入菜单"：走与手点同一条接口，成功了把这张卡置灰 */
  const confirmProposal = (item: (typeof proposals)[number]) => {
    addItem.mutate(
      { recipeId: item.recipeId, mealDate: item.mealDate, meal: item.meal, note: item.note || undefined },
      {
        onSuccess: (card) => {
          toast.success(`已把「${item.name}」加进${card.mealLabel}`)
          markAdded(`${item.recipeId}|${item.mealDate}|${item.meal}`)
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  const configured = status.data?.configured !== false
  const receiptsFor = (index: number) => receipts.find((group) => group.turnIndex === index)?.items ?? []
  /** 历史里有内容的那些（空的新对话不进列表，否则一按「新对话」就多一条空的） */
  const past = conversations.filter((item) => item.turns.length > 0)

  return (
    <BottomSheet visible={open} title="AI 助手" onClose={closeSheet}>
      {!configured ? (
        <p className="ai__tip">
          还没接上 AI。在根目录 .env（本机直跑则 services/api/.env）里填 AI_API_BASE / AI_API_KEY / AI_MODEL，
          重启后端就能用。其余功能不受影响。
        </p>
      ) : historyOpen ? (
        <div className="ai-history">
          <div className="ai-history__head">
            <span className="ai-history__title">以前的对话</span>
            <button type="button" className="ai-history__back" onClick={toggleHistory}>返回</button>
          </div>
          {past.length === 0 ? (
            <p className="ai__tip">还没有聊过。说一句就开始了。</p>
          ) : (
            <ul className="ai-history__list">
              {past.map((item) => (
                <li className={['ai-history__item', item.id === conversation?.id && 'is-active'].filter(Boolean).join(' ')} key={item.id}>
                  <button type="button" className="ai-history__pick" onClick={() => selectConversation(item.id)}>
                    <span className="ai-history__name">{item.title}</span>
                    <span className="ai-history__when">{chatTimeLabel(item.updatedAt)}</span>
                  </button>
                  {/* 删掉这一场：历史攒久了要能收拾（只删本地这段记录，不影响已经写进冰箱的东西） */}
                  <button
                    type="button"
                    className="ai-history__del"
                    aria-label={`删掉「${item.title}」`}
                    onClick={() => removeConversation(item.id)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          {turns.length === 0 && (
            <>
              <p className="ai__lead">
                冰箱、菜单、口味，说一句就行。比如「记一下冰箱里有酸奶」「今晚想吃清淡的」。
              </p>
              {/* 示例是**动作**不是问题：这个入口的卖点是"你说它做"，所以要示范能办什么事 */}
              <div className="ai__hint-row">
                <span className="ai__hint-label">试试说</span>
                <div className="ai__hints">
                  {EXAMPLE_SAYS.map((item) => (
                    <button key={item} type="button" className="ai__hint" onClick={() => void send(item)}>
                      {item}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {turns.length > 0 && (
            <div className="ai__thread" ref={threadRef}>
              {turns.map((turn, index) => {
                // 空的那格 assistant 不画（它只是给流式正文预留的位置），等待态由下面那格负责
                if (turn.role === 'assistant' && turn.content === '') return null
                return (
                  <div className={`ai__turn ai__turn--${turn.role}`} key={`${turn.role}-${index}`}>
                    {turn.content}
                    {pending && turn.role === 'assistant' && index === turns.length - 1 && (
                      <span className="ai__caret" aria-hidden />
                    )}
                    {/* 这一轮写进库的那些：挂在这句回答下面，是那句话的证据 */}
                    {turn.role === 'assistant' && receiptsFor(index).length > 0 && (
                      <AiReceiptCard items={receiptsFor(index)} undoing={undoing} onUndo={undoReceipt} />
                    )}
                  </div>
                )
              })}
              {pending && turns[turns.length - 1]?.content === '' && (
                <div className="ai__turn ai__turn--assistant ai__turn--waiting">
                  <DotLoading color="currentColor" />
                  <span className="ai__waiting-text">{stage || '正在想…'}</span>
                </div>
              )}

              {/* 加菜建议（B 档）：**只是建议**，点了"加入菜单"才真的写库 */}
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
                  {/* "先不用"不给按钮：不点就是不用（与「问 AI」那张卡同一形状） */}
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
              placeholder="说一句，如：记一下冰箱里有酸奶"
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
              {pending ? <DotLoading color="currentColor" /> : '说'}
            </button>
          </div>

          <div className="ai-assistant__foot">
            {/* 「新对话」：旧的那场留在历史里，随时翻得回去（用户 2026-10-13 的要求） */}
            <button type="button" className="ai-assistant__new" onClick={startNew}>新对话</button>
            {/* 历史入口只在真的聊过之后出现：空历史摆一个"以前的对话"是莫名其妙的 */}
            {past.length > 0 && (
              <button type="button" className="ai-assistant__history" onClick={toggleHistory}>
                以前的对话 · {past.length}
              </button>
            )}
          </div>
        </>
      )}
    </BottomSheet>
  )
}

/**
 * 入口处的示例话术（写死这一份就够，不必让模型现生成）：
 * 这个入口的意义是"能办事"，所以三条**各演示一类事**——记东西、改东西、问一句。
 * 写成"今晚吃什么"那种问句会让人以为它和发现页那个「问 AI」是同一个东西。
 */
const EXAMPLE_SAYS = [
  '记一下冰箱里有酸奶',
  '冰箱里的牛奶改成一盒',
  '今晚想吃点清淡的',
]
