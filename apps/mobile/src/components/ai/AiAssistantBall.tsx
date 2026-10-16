import Icon from '@/components/icons/Icon'
import { useAiAssistantSession } from '@/stores/ai-assistant-session'

/**
 * 全局 AI 助手的悬浮球（F16-10 / D-052 第一节，用户 2026-10-13 拍板"悬浮球"）。
 *
 * 挂在 **TabLayout** 里而不是各页里：它要**任意页都在**，而"任意页"这件事只有在
 * 外壳层写一次才是真的（写在每个页面里迟早漏一个，且新页面会忘）。
 *
 * 位置：右下角、**让开 Tab 栏**（`--spacing-tabbar`），否则它会压在最后一个 Tab 上——
 * 那是最容易点错的地方（用户想切"我的"却点开了助手）。
 *
 * **不做跟随拖拽**：悬浮球不是抽屉，原生 App 里这类助手球也很少能拖；能拖意味着要处理
 * 吸附边、记住位置、避开安全区，而它真正的价值是"一直在那儿、位置固定可预期"——
 * 每次都得先找它在哪反而更慢。将来若要拖，改这一个组件即可（位置在这一层）。
 */
export default function AiAssistantBall() {
  const open = useAiAssistantSession((state) => state.open)
  const openSheet = useAiAssistantSession((state) => state.openSheet)

  // 抽屉开着时把球收起来：它会被遮罩盖住（点了也没用），留着只是个视觉噪音
  if (open) return null

  return (
    <button type="button" className="ai-ball" onClick={openSheet} aria-label="问问 AI 助手">
      {/* 起伏动画套在**里面这层**，不是按钮本身：按钮是命中区，它一动，
          拇指落点就跟着飘（±3px 足够点空），自动化也永远等不到它"稳定"。
          外层静止、里面的图案轻轻上下，动感一样在，点起来却是死的。 */}
      <span className="ai-ball__inner">
        <span className="ai-ball__face" aria-hidden><Icon name="pan" size={21} /></span>
        <span className="ai-ball__hint">AI</span>
      </span>
    </button>
  )
}
