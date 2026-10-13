import { DotLoading } from 'antd-mobile'
import type { AiReceipt } from '@/api/ai'

/**
 * 回执卡（F16-10 / D-052 第二节）：AI 真的写进库之后的证据 + 「撤」。
 *
 * 三件事是刻意这么画的：
 *
 * ① **一笔一行，一行一个「撤」**：一句话里写了三样（"记一下鸡蛋、牛奶、苹果"）就在**同一张卡**里
 *    列三行、每行各带一个「撤」——用户想撤中间那样不必把整批都撤掉。
 *    （卡片本身是一个：三笔写成三张卡会刷屏，尤其连说几句"记一下"的时候。）
 * ② **撤过的行划掉但不消失**：留着说清"这一笔被我撤了"。直接删掉的话，用户回头看
 *    会以为那句话根本没写进东西——而"我说了一句话它真的动过"正是这个功能要传达的。
 * ③ **正在撤的那行给转圈**：撤销是一次真实的往返，没有反馈的话用户会连点。
 */
interface AiReceiptCardProps {
  items: AiReceipt[]
  /** 正在撤的那一笔 id（null = 没有在撤的） */
  undoing: string | null
  onUndo: (item: AiReceipt) => void
}

export default function AiReceiptCard({ items, undoing, onUndo }: AiReceiptCardProps) {
  if (items.length === 0) return null
  return (
    <div className="ai__receipt">
      <div className="ai__receipt-head">
        {/* 卡片是"已经写进去了"的证据，所以它用的是完成态的说法，不是"要不要"。
            文案不说"冰箱"：v1 只有冰箱这一档，但回执机制是通用的（将来收藏、口味按同一档接）——
            写死"冰箱"的话，下一条接进来时这张卡就在说谎了。 */}
        <span className="ai__receipt-mark" aria-hidden>✅</span>
        <span className="ai__receipt-lead">已经帮你办好了</span>
      </div>
      <ul className="ai__receipt-list">
        {items.map((item) => (
          <li className={['ai__receipt-row', item.undone && 'is-undone'].filter(Boolean).join(' ')} key={item.id}>
            <span className="ai__receipt-summary">{item.summary}</span>
            {/*
              撤不了的那几笔（`label` 为空，如整餐状态流转）：**不画按钮**。
              画一个点了只会被拒的按钮比没有按钮更糟——用户会以为界面坏了，
              或者更坏：以为点了就撤了。后端用空 label 表达"这一步回不去"，
              前端不必知道具体是哪种动作（将来加一种新的不可撤动作时只改后端一处）。
            */}
            {item.label === '' ? null : item.undone ? (
              <span className="ai__receipt-undone">已{undoWord(item.label)}</span>
            ) : (
              <button
                type="button"
                className="ai__receipt-undo"
                disabled={undoing === item.id}
                onClick={() => onUndo(item)}
              >
                {undoing === item.id ? <DotLoading color="currentColor" /> : item.label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * 划掉那行显示的字。
 *
 * 按钮上是「撤掉」（动作），划掉后要变成「已撤掉」（结果）；「改回去」变「已改回去」不通顺，
 * 所以这里按口语写死三档，而不是拿按钮上的字拼一个"已"字——拼出来的话
 * 「已改回去」这种半通不通的话就会出现在界面上。
 */
function undoWord(label: string): string {
  if (label === '改回去') return '改回原样'
  if (label === '放回去') return '放回去'
  return '撤掉'
}
