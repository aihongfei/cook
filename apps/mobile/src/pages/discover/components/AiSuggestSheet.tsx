import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { DotLoading } from 'antd-mobile'
import BottomSheet, { type BottomSheetHandle } from '@/components/ui/BottomSheet'
import { apiErrorMessage } from '@/api/client'
import { toast } from '@/components/ui/toast'
import { useAiSuggest, useAiStatus, type SuggestedPick } from '@/api/ai'
import { useAddOrderItem, useOrderOptions } from '@/api/orders'
import { useFamily } from '@/api/family'
import { nextMealDefaults } from '@/pages/order/next-meal'
import { pickHints } from '../ai-prompts'
import '../../shared.scss'

/**
 * 「AI 帮你想」（M16 子集 / D-026）。
 *
 * 定位是**掌勺人的参谋**：说一句想吃什么，从**本库真实的菜**里挑几道，直接就能点。
 * 推荐里的菜名与 id 都由后端按库里数据回填（模型编造的 id 会被丢掉），
 * 所以这里可以放心把 pick 当"库里存在的菜"用。
 *
 * 三个刻意的设计：
 * - **未配置时明说去哪配**，不给假的推荐撑场面（假数据会让用户以为 AI 在工作）；
 * - **推荐结果给"点这道"**，而不是只让用户看一眼——看完再自己翻菜单找那道菜，
 *   等于白推荐（这是他为什么来用 AI，而不是去菜谱库翻）；
 * - **快问每次抽一批**（见 ai-prompts）：同一组示例看第三遍就成了墙纸，换着出才有引导作用。
 */

/** 等结果时的阶段提示（模型要 11～40 秒，明说在干什么比一个转圈更有耐心） */
const SUGGEST_TIPS = ['正在翻菜谱小书…', '在挑荤素搭配…', '快好了，看看合不合口…']

interface AiSuggestSheetProps {
  visible: boolean
  onClose: () => void
}

export default function AiSuggestSheet({ visible, onClose }: AiSuggestSheetProps) {
  const status = useAiStatus()
  const family = useFamily()
  const options = useOrderOptions()
  const suggest = useAiSuggest()
  const addItem = useAddOrderItem()
  const [hint, setHint] = useState('')
  const [picks, setPicks] = useState<SuggestedPick[] | null>(null)
  const [tip, setTip] = useState(0)
  // 快问在打开时抽定（调用方用 key 重挂载，每次打开都是一批新的）。
  // 用 `useState(函数)` 而不是 `useState(pickHints())`：后者每次渲染都白抽一轮随机数
  // （值用不上，但白抽了）。**注意**两者在界面上的行为一样——反证验过，写成后者测试照样绿；
  // 真正会让按钮自己跳的是"不进 state、渲染时现抽"，那种写法反证会红（见 ai-sheets.test）。
  const [quickHints, setQuickHints] = useState(pickHints)
  // 收起走抽屉自己的退场动画（见 BottomSheet 里那段 ⚠️）：直接调 onClose 会让抽屉"啪"地消失
  const sheet = useRef<BottomSheetHandle>(null)
  const closeSheet = () => (sheet.current ? sheet.current.close() : onClose())

  // 等结果时轮播阶段提示。复位写在**发起请求的事件里**（见 ask）而不是这里：
  // 在 effect 里 setState 会多一轮渲染，也会被 react-hooks 的 set-state-in-effect 拦下
  useEffect(() => {
    if (!suggest.isPending) return
    const timer = setInterval(() => setTip((value) => (value + 1) % SUGGEST_TIPS.length), 5000)
    return () => clearInterval(timer)
  }, [suggest.isPending])

  // 推荐的菜进「下一餐」——与「想吃这道」同一份规则（见 order/next-meal）：
  // 同一个"点这道"在哪个入口都该落到同一餐，用户不会去记"AI 这边默认是明天午饭"
  const target = nextMealDefaults(options.data?.dayOptions ?? [])

  const ask = (text: string) => {
    const value = text.trim()
    setHint(value)
    setTip(0)
    suggest.mutate(
      { hint: value || undefined },
      {
        onSuccess: (result) => setPicks(result.picks),
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  const pointAt = (pick: SuggestedPick) => {
    if (!target.day || !target.meal) return
    addItem.mutate(
      { recipeId: pick.recipeId, mealDate: target.day, meal: target.meal },
      {
        onSuccess: (card) => {
          toast.success(`已把「${pick.name}」加进${card.mealLabel}`)
          closeSheet()
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  return (
    <BottomSheet ref={sheet} visible={visible} title="AI 帮你想" onClose={onClose}>
      {status.data && !status.data.configured ? (
        // 未配置就把话说清楚：怎么配、配完会怎样。不给假推荐。
        <p className="ai__tip">
          还没接上 AI，所以这里先不给推荐——省得你以为是真在想。
          在根目录 .env（本机直跑则 services/api/.env）里填 AI_API_BASE / AI_API_KEY / AI_MODEL，
          重启后端就能用。其余功能不受影响。
        </p>
      ) : (
        <>
          <p className="ai__lead">说说想吃什么，我从菜谱小书里挑几道能直接安排的。</p>

          <div className="ai__hint-row">
            <span className="ai__hint-label">常问</span>
            <div className="ai__hints">
              {quickHints.map((item) => (
                <button
                  key={item}
                  type="button"
                  className="ai__hint"
                  disabled={suggest.isPending}
                  onClick={() => ask(item)}
                >
                  {item}
                </button>
              ))}
              {/* 「换一批」而不是把池子铺满：铺满会盖住输入框（这个入口不只是点标签，还要能自己说） */}
              <button
                type="button"
                className="ai__hint ai__hint--more"
                disabled={suggest.isPending}
                onClick={() => setQuickHints(pickHints())}
              >
                换一批 ↻
              </button>
            </div>
          </div>

          <div className="ai__ask">
            <input
              className="ai__note"
              value={hint}
              maxLength={200}
              placeholder="也可以自己说，如：想吃酸的、有小孩"
              onChange={(event) => setHint(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !suggest.isPending) ask(hint)
              }}
            />
            <button
              type="button"
              className="ai__go"
              disabled={suggest.isPending}
              onClick={() => ask(hint)}
            >
              {suggest.isPending ? <DotLoading color="currentColor" /> : '想几道'}
            </button>
          </div>

          {/* 推荐要等整包结果（结构化输出不能边收边用），所以给的是"骨架 + 阶段提示"：
              骨架让位置先占住、不至于等的时候界面一动不动；阶段提示让等待有进度感 */}
          {suggest.isPending && (
            <>
              <p className="ai__waiting">{SUGGEST_TIPS[tip]}</p>
              <div className="ai__skeleton">
                {[0, 1, 2].map((row) => (
                  <div className="ai__skeleton-row" key={row}>
                    <span className="ai__skeleton-line ai__skeleton-line--name" />
                    <span className="ai__skeleton-line ai__skeleton-line--reason" />
                  </div>
                ))}
              </div>
            </>
          )}

          {picks?.length === 0 && !suggest.isPending && (
            <p className="ai__hint">
              这次没挑出来（可能库里没有合口味的）。换个说法再试，或去
              <Link className="weekplan__link" to="/recipes" onClick={onClose}>
                菜谱小书
              </Link>
              自己翻翻。
            </p>
          )}

          {picks && picks.length > 0 && (
            <div className="ai__picks">
              {picks.map((pick, index) => (
                <div className="ai__pick" key={pick.recipeId}>
                  {/* 序号不是装饰：它是"AI 从候选里挑出来的顺序"，
                      用户一眼能看出这是 AI 选的几条而不是菜单列表 */}
                  <span className="ai__pick-index" aria-hidden>
                    {index + 1}
                  </span>
                  <div className="ai__pick-main">
                    <span className="ai__pick-name">{pick.name}</span>
                    {pick.reason && <span className="ai__pick-reason">{pick.reason}</span>}
                  </div>
                  <button
                    type="button"
                    className="btn-ghost ai__pick-go"
                    disabled={addItem.isPending || !family.data}
                    onClick={() => pointAt(pick)}
                  >
                    点这道
                  </button>
                </div>
              ))}
              <p className="ai__foot">推荐的菜都在菜谱小书里，点「点这道」会加进今天这一餐。</p>
            </div>
          )}
        </>
      )}
    </BottomSheet>
  )
}
