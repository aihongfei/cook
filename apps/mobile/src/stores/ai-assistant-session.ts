import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { AiReceipt, ChatTurn, MenuProposal } from '@/api/ai'
import { KEEP_CONVERSATIONS, conversationTitle, pruneTurns } from './ai-assistant.rules'

/**
 * 全局 AI 助手这一场对话的状态（F16-10 / D-052，用户 2026-10-13 拍板"悬浮球"入口）。
 *
 * **为什么必须是模块级 store**（与 D-045 给「AI 帮你想」做的同一件事）：这个助手的特点是
 * "人不用离开当前页"——在冰箱页说一句"记一下酸奶"，说完收起抽屉，人还站在冰箱页。
 * 抽屉一收组件就卸载了，如果对话在组件 state 里，切个页再点开悬浮球，刚才那句"记好了"
 * 连同回执卡、**那个「撤」**全没了——而撤销正是这一档唯一的安全网。
 *
 * **为什么要持久化（用户 2026-10-13 追加：「会话历史也要保留啊，还有开启新会话这些」）**：
 * 上面那条只解决了"切页不丢"，刷新页面/重开 App 仍然是白纸。用户的期待是**翻得回去**：
 * 昨天让它记的酸奶、上周问过的做法，都还在那儿。所以整场对话落到 localStorage，
 * 且支持**多场对话**（`conversations` 数组）：「新对话」开一场新的，旧的留在历史里。
 *
 * 三件必须守住的边界：
 *
 * ① **落盘前要剪掉"还没长出字的空格"**（`pruneTurns`）——流式途中刷新会留下一个空气泡，
 *    它下次会被当成消息发出去，后端 400（"消息内容不能为空"）。这是接口红线，见 rules。
 * ② **发给模型的只有最近十条**（`wireMessages`）：后端 `AI_MESSAGES_MAX = 10` 硬卡着。
 * ③ **退出登录必须清干净**：这些对话里有**别人家的冰箱内容**（"记了酸奶、牛奶快到期了"）。
 *    同一台手机上换个账号登录，看到上一个人的聊天记录，是实打实的隐私事故。
 *    所以 `logout()` 会调 `clearAll()`（见 api/auth.ts），不是等它自然过期。
 */
export interface AiConversation {
  id: string
  /** 头一句用户话截出来的标题（历史列表里显示它，不必再烧一次调用去生成） */
  title: string
  createdAt: number
  updatedAt: number
  turns: ChatTurn[]
  /** 这一场里的回执行：`turnIndex` 是它挂在第几轮回答下面 */
  receipts: { turnIndex: number; items: AiReceipt[] }[]
}

interface AiAssistantState {
  /** 抽屉开着没有。**跨页**——切页时保持原状 */
  open: boolean
  /** 全部对话，最近更新的在前（历史列表直接用这个顺序） */
  conversations: AiConversation[]
  /** 当前正在看/正在聊的那一场；null = 还没有任何对话 */
  activeId: string | null
  /** 用户正在打的那句 */
  draft: string
  /** 这一轮还在跑 */
  pending: boolean
  /** 工具执行中的那句人话 */
  stage: string
  /** AI 提的加菜建议（B 档：点了"加入菜单"才真写库）。**不落盘**——见下面 partialize */
  proposals: MenuProposal[]
  /** 已经点过确认的建议（按 recipeId+餐次记） */
  added: string[]
  /** 历史列表开着没有（临时界面状态，不落盘） */
  historyOpen: boolean

  openSheet: () => void
  closeSheet: () => void
  /** 开一场新的（「新对话」）。旧的**留在历史里**，不清掉 */
  startNew: () => void
  /** 切到历史里的某一场 */
  selectConversation: (id: string) => void
  /** 删掉某一场（历史列表里划掉一条） */
  removeConversation: (id: string) => void
  /** 全清（退出登录时调，见文件头 ③） */
  clearAll: () => void
  toggleHistory: () => void
  setDraft: (draft: string) => void
  beginTurn: (userText: string, attachments?: string[]) => void
  appendChunk: (chunk: string) => void
  endTurn: (options?: { dropEmptyAssistant?: boolean }) => void
  setStage: (stage: string) => void
  setProposals: (items: MenuProposal[]) => void
  markAdded: (key: string) => void
  addReceipts: (items: AiReceipt[]) => void
  /** 某一笔撤销成功之后，把它从卡上划掉（不是删卡：撤了也要留痕） */
  markUndone: (id: string) => void
}

let seq = 0
function newId(): string {
  seq += 1
  return `c${Date.now().toString(36)}${seq}`
}

/** 空的新对话（用户点「新对话」时建） */
function blankConversation(): AiConversation {
  const now = Date.now()
  return { id: newId(), title: '新的对话', createdAt: now, updatedAt: now, turns: [], receipts: [] }
}

/**
 * 当前这一场。**没有就现建一场**——用户点开悬浮球直接说话是最常见的路径，
 * 让他先点一次"新对话"是多余的仪式（`startNew` 只在"聊完一场想开新的"时才需要点）。
 * 返回值放在 set 回调外侧算好，是因为 set 必须是纯函数（不能在里面 newId 两次）。
 */
function ensureActive(state: { conversations: AiConversation[]; activeId: string | null }): AiConversation {
  const current = state.conversations.find((item) => item.id === state.activeId)
  return current ?? blankConversation()
}

/** 把一场改动过的对话写回列表，并把它挪到最前（最近更新的在前，历史列表直接用这个顺序） */
function upsert(state: AiAssistantState, next: AiConversation): Partial<AiAssistantState> {
  const others = state.conversations.filter((item) => item.id !== next.id)
  return {
    conversations: [next, ...others].slice(0, KEEP_CONVERSATIONS),
    activeId: next.id,
  }
}

export const useAiAssistantSession = create<AiAssistantState>()(
  persist(
    (set, get) => ({
      open: false,
      conversations: [],
      activeId: null,
      draft: '',
      pending: false,
      stage: '',
      proposals: [],
      added: [],
      historyOpen: false,

      openSheet: () => set({ open: true }),
      // 收起抽屉**不清对话**：下一句可能还接着上文（与发现页那两个抽屉的"关掉就是干净的一次"不同，
      // 那是"一次问答"，这里是"一场可以持续办很多事的对话"）
      closeSheet: () => set({ open: false, historyOpen: false }),

      startNew: () => {
        const fresh = blankConversation()
        set((state) => ({
          // 旧的那场（如果聊过）留在列表里；空的那场直接丢掉，免得历史里堆一串"新的对话"
          conversations: [fresh, ...state.conversations.filter((item) => item.turns.length > 0)]
            .slice(0, KEEP_CONVERSATIONS),
          activeId: fresh.id,
          draft: '',
          proposals: [],
          added: [],
          historyOpen: false,
        }))
      },

      selectConversation: (id) => {
        if (!get().conversations.some((item) => item.id === id)) return
        // 建议与"已加入"标记是**当轮**的东西，换一场就收走（它们属于刚才那句话）
        set({ activeId: id, proposals: [], added: [], historyOpen: false })
      },

      removeConversation: (id) => set((state) => {
        const conversations = state.conversations.filter((item) => item.id !== id)
        const activeId = state.activeId === id ? (conversations[0]?.id ?? null) : state.activeId
        return { conversations, activeId, proposals: [], added: [] }
      }),

      clearAll: () => set({
        conversations: [], activeId: null, draft: '', pending: false, stage: '',
        proposals: [], added: [], historyOpen: false,
      }),

      toggleHistory: () => set((state) => ({ historyOpen: !state.historyOpen })),
      setDraft: (draft) => set({ draft }),

      beginTurn: (userText, attachments) => set((state) => {
        const active = ensureActive(state)
        const now = Date.now()
        const next: AiConversation = {
          ...active,
          // 第一句话定标题（已经聊过的别改：标题是"从哪儿翻回去"的线索）
          title: active.turns.length === 0 ? conversationTitle(userText) : active.title,
          updatedAt: now,
          turns: [
            /*
             * ⚠️ `...active.turns` 一定不能丢（这里曾经漏过一次）：少了它，每问一句都会把
             * 前面所有对话冲掉——症状是"聊到第三句它就不记得第一句了"，
             * 而抽屉里也只剩最后一句。已由「发给模型的只有最近十条」那条用例钉住。
             */
            ...active.turns,
            // 图片 id 跟着这一句一起落盘 → 翻历史时图还在（用户明确要的那条）
            { role: 'user', content: userText, ...(attachments?.length ? { attachments } : {}) },
            { role: 'assistant', content: '' },
          ],
        }
        return {
          ...upsert(state, next),
          draft: '',
          pending: true,
          stage: '',
          // 上一轮的建议随提问一起清掉：它属于上一句回答（与 AiChatSheet 同一个理由）
          proposals: [],
        }
      }),

      appendChunk: (chunk) => set((state) => {
        const active = ensureActive(state)
        const last = active.turns[active.turns.length - 1]
        if (last?.role !== 'assistant') return state
        const next: AiConversation = {
          ...active,
          turns: [...active.turns.slice(0, -1), { role: 'assistant', content: last.content + chunk }],
        }
        return upsert(state, next)
      }),

      endTurn: (options) => set((state) => {
        const active = ensureActive(state)
        const last = active.turns[active.turns.length - 1]
        // 撤掉"还没长出字"的那格 assistant：失败与中途取消都要撤，否则会剩一个空气泡
        const turns = options?.dropEmptyAssistant && last?.role === 'assistant' && last.content === ''
          ? active.turns.slice(0, -1)
          : active.turns
        return { ...upsert(state, { ...active, turns, updatedAt: Date.now() }), pending: false, stage: '' }
      }),

      setStage: (stage) => set({ stage: stage.slice(0, 40) }),
      setProposals: (proposals) => set({ proposals }),

      markAdded: (key) => set((state) => (
        state.added.includes(key) ? state : { added: [...state.added, key] }
      )),

      addReceipts: (items) => set((state) => {
        const active = ensureActive(state)
        /*
         * 挂到**最后那轮回答**下面（`turns.length - 1`）：回执事件紧跟在那句"记好了"之后到
         * （服务端在流末尾发），此刻最后一格必然是它那句回答。
         * 同一轮再来一批（模型分两次调用工具）就并进同一张卡——用户看到的是"这一句话写下的那些"。
         */
        const turnIndex = Math.max(0, active.turns.length - 1)
        const existing = active.receipts.findIndex((group) => group.turnIndex === turnIndex)
        const receipts = [...active.receipts]
        if (existing === -1) receipts.push({ turnIndex, items })
        else receipts[existing] = { turnIndex, items: [...receipts[existing].items, ...items] }
        return upsert(state, { ...active, receipts })
      }),

      markUndone: (id) => set((state) => {
        const active = ensureActive(state)
        return upsert(state, {
          ...active,
          receipts: active.receipts.map((group) => ({
            ...group,
            items: group.items.map((item) => (item.id === id ? { ...item, undone: true } : item)),
          })),
        })
      }),
    }),
    {
      /*
       * 落盘到 localStorage（与登录态同一个做法，见 stores/auth）：
       * 刷新页面、重开 App 之后对话还在（用户 2026-10-13 追加的要求）。
       *
       * `partialize` 挑出**该活过刷新**的那些，且顺手剪掉末尾的空格（见 pruneTurns 的说明）：
       * - `pending` / `stage` 不落盘：它们是"此刻正在跑"，刷新后没有任何东西在跑，
       *   存下来的话抽屉会永远显示"正在记进冰箱…"（而且再也不会结束）；
       * - `proposals` 不落盘：它是**当轮**的待办，且带日期（"今天晚餐"）——
       *   隔天打开还挂着一个"加入菜单"按钮，点下去加的是昨天那餐；
       * - `added` 同理（它是"这一批建议点过没"的标记，跟建议同生共死）。
       */
      partialize: (state) => ({
        conversations: state.conversations.map((item) => ({ ...item, turns: pruneTurns(item.turns) })),
        activeId: state.activeId,
        draft: state.draft,
      }),
      name: 'yushan-ai-assistant',
      version: 1,
      storage: createJSONStorage(() => localStorage),
    },
  ),
)

/** 当前这一场（组件里用它取 turns / receipts；没有就是 null） */
export function selectActiveConversation(state: AiAssistantState): AiConversation | null {
  return state.conversations.find((item) => item.id === state.activeId) ?? null
}
