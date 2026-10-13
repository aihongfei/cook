import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
/* `dateKey` 从点单那边导入：冰箱复用它的日期口径（见 fridge.rules 文件头的说明） */
import { dateKey } from '../src/modules/orders/orders.rules'
import {
  FRIDGE_AMOUNT_MAX,
  FRIDGE_NAME_MAX,
  FRIDGE_NOTE_MAX,
  FRIDGE_ZONES,
  SOON_DAYS,
  daysUntil,
  expiryLabel,
  expiryState,
  needsAttention,
  parseAmount,
  parseExpiry,
  parseName,
  parseNote,
  parseZone,
  toView,
} from '../src/modules/fridge/fridge.rules'

// 冰箱的纯规则（M6 / F6-01~F6-05，口径见 D-049）。不碰数据库，也不起 MySQL。
//
// 这里盯的是两件靠"看着对"验不出来的事：
// ① **保质期按日历日算**，不是按 24 小时——食材的保质期是人按日子写的（"15 号到期"）；
// ② **数量不强迫填数字**——逼人填会让人干脆不录，而"录了但没写多少"比"没录"有用。

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h)

// ---------- 四区（F6-04） ----------

test('存放区只认那四档，不认的值直接拒（不用默认值兜住打错的区）', () => {
  assert.deepEqual([...FRIDGE_ZONES], ['常温', '保鲜', '冷藏', '冷冻'])
  for (const zone of FRIDGE_ZONES) assert.equal(parseZone(zone), zone)
  assert.equal(parseZone('  冷藏  '), '冷藏', '首尾空格要容忍')
  // 打错的区**不能**悄悄记成冷藏：用户下次在冷藏里找不到它
  for (const bad of ['冷冻室', 'cold', '', null, undefined, 3]) {
    assert.throws(() => parseZone(bad), BadRequestException, `${JSON.stringify(bad)} 应被拒`)
  }
})

// ---------- 名字 / 数量 / 备注 ----------

test('食材名去首尾空格、不许空、有长度上限', () => {
  assert.equal(parseName('  鸡蛋  '), '鸡蛋')
  assert.equal(parseName('西'.repeat(FRIDGE_NAME_MAX)).length, FRIDGE_NAME_MAX)
  for (const bad of ['', '   ', null, undefined, 42]) {
    assert.throws(() => parseName(bad), BadRequestException, `${JSON.stringify(bad)} 应被拒`)
  }
  assert.throws(() => parseName('蛋'.repeat(FRIDGE_NAME_MAX + 1)), /最多 40 个字/)
})

test('数量可空、是自由文本（不逼人填数字）', () => {
  assert.equal(parseAmount(undefined), null)
  assert.equal(parseAmount(null), null)
  assert.equal(parseAmount('   '), null, '空白串归一成 null，不是空字符串')
  // 「半盒」「约 500g」都该能写：很多食材就是"有一点"，逼人填数字会让人干脆不录
  assert.equal(parseAmount('半盒'), '半盒')
  assert.equal(parseAmount(' 约 500g '), '约 500g')
  assert.throws(() => parseAmount('长'.repeat(FRIDGE_AMOUNT_MAX + 1)), /最多 24 个字/)
})

test('备注可空、归一空白串', () => {
  assert.equal(parseNote(undefined), null)
  assert.equal(parseNote('  '), null)
  assert.equal(parseNote(' 给奶奶买的 '), '给奶奶买的')
  assert.throws(() => parseNote('记'.repeat(FRIDGE_NOTE_MAX + 1)), /最多 60 个字/)
})

// ---------- 保质期（F6-05） ----------

test('保质期只认 YYYY-MM-DD，且要真的是个存在的日子', () => {
  assert.equal(dateKey(parseExpiry('2026-10-15')!), '2026-10-15')
  assert.equal(parseExpiry(undefined), null)
  assert.equal(parseExpiry(null), null)
  assert.equal(parseExpiry(''), null)
  // 2 月 31 号会被 Date 悄悄滚到 3 月——那种"填错了还存进去"最坑，必须拦
  assert.throws(() => parseExpiry('2026-02-31'), /这个日期不存在/)
  assert.throws(() => parseExpiry('2026-13-01'), /这个日期不存在/)
  for (const bad of ['10-15', '2026/10/15', '2026-10-15T00:00:00Z', '明天', 20261015]) {
    assert.throws(() => parseExpiry(bad), /保质期要写成/, `${JSON.stringify(bad)} 应被拒`)
  }
  // 年份远到离谱的（多打一位）也拦：那是打错，不是真的想记 8026 年
  assert.throws(() => parseExpiry('8026-10-15'), /年份太远/)
})

test('保质期按**日历日**算，不按 24 小时', () => {
  // 今天 23:00 看"明天到期"仍是 1 天——按小时算会变成 0.04 天（显示成"今天"或"不到一天"，吓人）
  const late = at(2026, 10, 14, 23)
  assert.equal(daysUntil(at(2026, 10, 15), late), 1)
  // 今天 00:01 看"今天到期"是 0 天，与今天 23:59 看它一致
  assert.equal(daysUntil(at(2026, 10, 14), at(2026, 10, 14, 0)), 0)
  assert.equal(daysUntil(at(2026, 10, 14), at(2026, 10, 14, 23)), 0)
  // 昨天到期 = -1
  assert.equal(daysUntil(at(2026, 10, 13), at(2026, 10, 14)), -1)
})

test('三档状况与那句人话：已过期 / 今天 / 三天内', () => {
  const now = at(2026, 10, 14)

  assert.equal(expiryState(at(2026, 10, 12), now), 'expired')
  assert.equal(expiryLabel(at(2026, 10, 12), now), '过期 2 天')
  assert.equal(expiryState(at(2026, 10, 13), now), 'expired')
  assert.equal(expiryLabel(at(2026, 10, 13), now), '过期 1 天')

  assert.equal(expiryState(at(2026, 10, 14), now), 'today')
  assert.equal(expiryLabel(at(2026, 10, 14), now), '今天到期')

  assert.equal(expiryState(at(2026, 10, 15), now), 'soon')
  assert.equal(expiryLabel(at(2026, 10, 15), now), '明天到期', '第 2 天不该写成"还有 1 天"')
  assert.equal(expiryLabel(at(2026, 10, 17), now), `还有 ${SOON_DAYS} 天`)

  // 第四天起不提醒：冰箱里排满"还有 8 天"的提醒等于没有提醒
  assert.equal(expiryState(at(2026, 10, 18), now), null)
  assert.equal(expiryLabel(at(2026, 10, 18), now), '还有 4 天', '话还是明说，只是不当成"要提醒"')
  assert.equal(needsAttention(at(2026, 10, 18), now), false)
})

test('没写保质期 = 不提醒（不是"不会坏"）', () => {
  const now = at(2026, 10, 14)
  assert.equal(expiryState(null, now), null)
  assert.equal(expiryLabel(null, now), null)
  assert.equal(needsAttention(null, now), false)
})

test('该提醒的边界：过期与三天内都算，第 4 天不算', () => {
  const now = at(2026, 10, 14)
  for (const day of [10, 13, 14, 15, 16, 17]) {
    assert.equal(needsAttention(at(2026, 10, day), now), true, `10-${day} 应提醒`)
  }
  assert.equal(needsAttention(at(2026, 10, 18), now), false)
})

// ---------- 输出行 ----------

test('数据库行 → 界面行：保质期那句话由后端算好（前端不重算）', () => {
  const now = at(2026, 10, 14)
  const row = {
    id: 'f1',
    name: '牛奶',
    amount: '一盒',
    zone: '冷藏',
    expiresOn: at(2026, 10, 15),
    note: null,
    addedByName: '妈妈',
    createdAt: at(2026, 10, 13, 9),
  }
  const view = toView(row, now)
  assert.equal(view.id, 'f1')
  assert.equal(view.zone, '冷藏')
  assert.equal(view.expiresOn, '2026-10-15', '保质期输出成 YYYY-MM-DD')
  assert.equal(view.expiryLabel, '明天到期')
  assert.equal(view.attention, true)
  assert.equal(view.addedBy, '妈妈', '显示的是昵称，不是 id')
  // 没写保质期的行
  const plain = toView({ ...row, expiresOn: null }, now)
  assert.equal(plain.expiresOn, null)
  assert.equal(plain.expiryLabel, null)
  assert.equal(plain.attention, false)
})
