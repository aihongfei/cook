import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addedLabel, RECENT_LIMIT_DEFAULT } from '../src/modules/fridge/fridge.rules'

/**
 * 「最近录入」（M6 / F6-06）。
 *
 * 这一条要盯住的只有一件事：**那句话必须是真的**。
 * "今天""昨天""3 天前"是用户拿来判断"这盒奶是不是我刚买的"的依据，
 * 算错了他会以为冰箱里有东西——与保质期那句 `expiryLabel` 同一条线。
 *
 * 所以这里按**日历日**数，不按 24 小时：昨晚 23:00 记的，今早 8:00 看就是"昨天"，
 * 而不是"9 小时前"（人的记忆是日历，不是秒表）。
 */

/** 造一个"本地日历的某时刻"，与生产口径一致（容器 TZ=Asia/Shanghai） */
function at(year: number, month: number, day: number, hour = 12, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute)
}

test('刚记的算"刚刚"（一小时内）：用户刚点完保存回来看，说"今天"没有信息量', () => {
  const now = at(2026, 10, 13, 12, 0)
  assert.equal(addedLabel(at(2026, 10, 13, 11, 30), now), '刚刚')
})

test('同一天但超过一小时：说"今天"', () => {
  const now = at(2026, 10, 13, 12, 0)
  assert.equal(addedLabel(at(2026, 10, 13, 9, 0), now), '今天')
})

test('**按日历年，不按 24 小时**：昨晚 23:00 记的，今早看是"昨天"而不是"9 小时前"', () => {
  const now = at(2026, 10, 13, 8, 0)
  // 原始毫秒差只有 9 小时，日历上却是昨天——人的记忆是日历
  assert.equal(addedLabel(at(2026, 10, 12, 23, 0), now), '昨天')
})

test('前几天说"N 天前"（3 天前、6 天前）', () => {
  const now = at(2026, 10, 13, 12, 0)
  assert.equal(addedLabel(at(2026, 10, 10, 12, 0), now), '3 天前')
  assert.equal(addedLabel(at(2026, 10, 7, 12, 0), now), '6 天前')
})

test('一周以上说"更早"（不再报天数：那已经不是"最近"了，报天数反而像在强调）', () => {
  const now = at(2026, 10, 13, 12, 0)
  assert.equal(addedLabel(at(2026, 10, 6, 12, 0), now), '更早')
  assert.equal(addedLabel(at(2026, 9, 1, 12, 0), now), '更早')
})

test('跨月也算得对（不能拿"几号相减"当日期差）', () => {
  const now = at(2026, 11, 2, 12, 0)
  assert.equal(addedLabel(at(2026, 10, 31, 12, 0), now), '2 天前')
  assert.equal(addedLabel(at(2026, 10, 20, 12, 0), now), '更早')
})

test('跨年也算得对（元旦看跨年那天）', () => {
  const now = at(2027, 1, 1, 12, 0)
  assert.equal(addedLabel(at(2026, 12, 31, 12, 0), now), '昨天')
})

test('**未来的时间不说"明天"**：时钟偏差或被改过的数据，一律当"刚刚"',
  () => {
    const now = at(2026, 10, 13, 12, 0)
    // 服务器与数据库时钟差一点就会造出"未来"的行；说"N 天后记的"是句胡话
    assert.equal(addedLabel(at(2026, 10, 13, 12, 30), now), '刚刚')
    assert.equal(addedLabel(at(2026, 10, 15, 12, 0), now), '刚刚')
  })

test('一页最多几条是个常量（界面按它说"还有 N 样"）', () => {
  assert.equal(RECENT_LIMIT_DEFAULT, 8)
})
