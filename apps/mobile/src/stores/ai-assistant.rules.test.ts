// @vitest-environment jsdom
import { expect, it } from 'vitest'
import type { ChatTurn } from '@/api/ai'
import { WIRE_MAX, chatTimeLabel, conversationTitle, pruneTurns, wireMessages } from './ai-assistant.rules'

/**
 * 助手会话的三条纯规则（F16-10 / D-052）。
 *
 * 这三条都属于"算错了很难发现，但后果确定"的那类：
 * ① `wireMessages` 越过后端的条数上限 → 整句话 400（用户看到"它突然不理我了"）；
 * ② `pruneTurns` 漏掉那个空格 → 下次请求同样 400；
 * ③ `chatTimeLabel` 算错 → 历史列表里写着"3 分钟前"而其实是昨天。
 * 所以全部直接单测，不经过界面。
 */

const turn = (role: ChatTurn['role'], content: string): ChatTurn => ({ role, content })

it('发给模型的只有最近十条（后端 AI_MESSAGES_MAX = 10 硬卡着，超了整句 400）', () => {
  const many: ChatTurn[] = []
  for (let index = 0; index < 20; index += 1) many.push(turn('user', `问${index}`), turn('assistant', `答${index}`))

  const wire = wireMessages(many)
  expect(wire).toHaveLength(WIRE_MAX)
  // 取的是**最近**的十条（最早的丢在前面），不是最早的十条
  expect(wire[0]).toEqual(turn('user', '问15'))
  expect(wire[wire.length - 1]).toEqual(turn('assistant', '答19'))
})

it('**这一句新问的也算在十条里**（"截十条历史再追加一句"是十一条，会被 400）', () => {
  /*
   * 这是第一版实现真实犯过的错：`[...wireMessages(turns), 新的一句]`。
   * 单测把它算成 11 条抓出来了——所以这里钉的是"总数不超过十条"，
   * 而不是"历史那部分不超过十条"（后者是前者的错读）。
   * 界面上调用时是把新的一句并进数组一起过筛的。
   */
  const turns: ChatTurn[] = []
  for (let index = 0; index < 12; index += 1) turns.push(turn(index % 2 === 0 ? 'user' : 'assistant', `第${index}句`))

  const payload = wireMessages([...turns, turn('user', '新问的一句')])
  expect(payload).toHaveLength(WIRE_MAX)
  // 最新的那句一定在（被丢的是最老的）
  expect(payload[payload.length - 1]).toEqual(turn('user', '新问的一句'))
  // 一共十条：新的那句 + 九句历史
  expect(payload.filter((item) => item.content !== '新问的一句')).toHaveLength(WIRE_MAX - 1)
})

it('空内容一条都不发（后端会 400"消息内容不能为空"），且**先过滤再截断**', () => {
  // 末尾挂两个空格 + 恰好十条有内容的：先截断再过滤的话，末端空格会把有用的话挤掉，只剩八条
  const turns: ChatTurn[] = []
  for (let index = 0; index < 10; index += 1) turns.push(turn(index % 2 === 0 ? 'user' : 'assistant', `第${index}句`))
  turns.push(turn('assistant', ''), turn('assistant', '   '))

  const wire = wireMessages(turns)
  expect(wire).toHaveLength(10)
  expect(wire.every((item) => item.content.trim() !== '')).toBe(true)
  expect(wire[0]).toEqual(turn('user', '第0句'))
})

it('落盘前剪掉末尾那个"还没长出字"的 assistant 空格，只剪末尾', () => {
  expect(pruneTurns([turn('user', '记一下酸奶'), turn('assistant', '')]))
    .toEqual([turn('user', '记一下酸奶')])

  // 中间的空格**不剪**：那是别处有 bug 的迹象，留着更容易发现（静默剪掉等于把问题藏了）
  const middle = [turn('user', '一'), turn('assistant', ''), turn('user', '二')]
  expect(pruneTurns(middle)).toEqual(middle)

  // 别的角色、有内容的一律不动
  const normal = [turn('user', '一'), turn('assistant', '答')]
  expect(pruneTurns(normal)).toEqual(normal)
})

it('标题取头一句用户话的前 14 个字（长句截断，空句给"新的对话"）', () => {
  expect(conversationTitle('记一下冰箱里有酸奶')).toBe('记一下冰箱里有酸奶')
  // 14 个字是硬切（"今天想做一道很复杂的佛跳墙给" 正好 14 个），后面补个省略号说明还有下文
  expect(conversationTitle('今天想做一道很复杂的佛跳墙给全家人吃')).toBe('今天想做一道很复杂的佛跳墙给…')
  // 空白也算空（用户敲了几个空格就发是不允许的，但标题这里不能跟着崩）
  expect(conversationTitle('   ')).toBe('新的对话')
})

it('历史里的时间说人话：刚刚 / N 分钟前 / HH:MM / 昨天 / 月日 / 年月日', () => {
  const now = new Date('2026-10-13T15:30:00+08:00').getTime()
  const at = (iso: string) => new Date(iso).getTime()

  expect(chatTimeLabel(now - 10_000, now)).toBe('刚刚')
  expect(chatTimeLabel(now - 5 * 60_000, now)).toBe('5 分钟前')
  // 同一天但超过一小时：给具体时刻（"3 小时前"不如"12:30"好定位）
  expect(chatTimeLabel(at('2026-10-13T09:00:00+08:00'), now)).toBe('09:00')
  expect(chatTimeLabel(at('2026-10-12T09:00:00+08:00'), now)).toBe('昨天')
  expect(chatTimeLabel(at('2026-10-03T09:00:00+08:00'), now)).toBe('10 月 3 日')
  expect(chatTimeLabel(at('2025-12-31T09:00:00+08:00'), now)).toBe('2025 年 12 月 31 日')
})
