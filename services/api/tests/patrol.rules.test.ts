import assert from 'node:assert/strict'
import test from 'node:test'
import { PATROL_MAX_ITEMS, nextSince, pickPatrolItems } from '../src/modules/notifications/patrol.rules'

/**
 * 巡查（手机后台取提醒）的纯规则（M10 交付三）。
 *
 * 这一组盯的是**"什么时候会弹、什么时候不该弹"**——错了用户是感受得到的：
 * 该弹没弹（白折腾）、或者每 15 分钟重复弹同一条（用户会把通知权限关掉，
 * 那连交付二那两条正常的提醒也一起没了）。
 *
 * 三条最关键的性质：
 * 1. **第一次（没有 since）一条都不弹**——否则装完/刚登录就被十几条历史糊一屏；
 * 2. **弹过的不再弹**（`since` 推进用"全部提醒里最新的时刻"，不是"弹出去那几条里最新的"）；
 * 3. **上限是"最新的几条"**，被挡下的那些不丢（仍在应用内的通知中心里）。
 */

const at = (iso: string, id = iso) => ({ id, at: iso })

test('pickPatrolItems：**第一次（since 为 null）一条都不弹**（那种"新"是伪新）', () => {
  const items = [at('2026-10-14T10:00:00.000Z'), at('2026-10-14T09:00:00.000Z')]
  assert.deepEqual(pickPatrolItems(items, null, 3), [])
})

test('pickPatrolItems：只挑 since **之后**的（严格大于：等于的那条已经弹过了）', () => {
  const items = [
    at('2026-10-14T12:00:00.000Z', 'new'),
    at('2026-10-14T10:00:00.000Z', 'same'),
    at('2026-10-14T08:00:00.000Z', 'old'),
  ]
  const out = pickPatrolItems(items, new Date('2026-10-14T10:00:00.000Z'), 5)
  assert.deepEqual(out.map((item) => item.id), ['new'])
})

test('pickPatrolItems：一条都没有新的就返回空（不该"没事也弹一条"）', () => {
  assert.deepEqual(pickPatrolItems([at('2026-10-14T08:00:00.000Z')], new Date('2026-10-14T10:00:00.000Z'), 3), [])
})

test('pickPatrolItems：按时刻**倒序**取（用户先看到最要紧的）', () => {
  const items = [at('2026-10-14T08:00:00.000Z'), at('2026-10-14T12:00:00.000Z'), at('2026-10-14T10:00:00.000Z')]
  const out = pickPatrolItems(items, new Date('2026-10-14T00:00:00.000Z'), 5)
  assert.deepEqual(out.map((item) => item.at), [
    '2026-10-14T12:00:00.000Z',
    '2026-10-14T10:00:00.000Z',
    '2026-10-14T08:00:00.000Z',
  ])
})

test('pickPatrolItems：超过上限时**只弹最新的几条**（一次刷一屏只会让人把通知全划掉）', () => {
  const items = Array.from({ length: 7 }, (_, index) => at(`2026-10-14T0${index}:00:00.000Z`, `i${index}`))
  const out = pickPatrolItems(items, new Date('2026-10-13T00:00:00.000Z'), PATROL_MAX_ITEMS)
  assert.equal(out.length, PATROL_MAX_ITEMS)
  assert.deepEqual(out.map((item) => item.id), ['i6', 'i5', 'i4'])
})

test('pickPatrolItems：看不懂的时刻跳过（不因为一条脏数据把整次巡查搞挂）', () => {
  const items = [at('不是时刻'), at('2026-10-14T12:00:00.000Z', 'ok')]
  const out = pickPatrolItems(items, new Date('2026-10-14T00:00:00.000Z'), 3)
  assert.deepEqual(out.map((item) => item.id), ['ok'])
})

test('pickPatrolItems：上限传 0 就一条不弹（留着这个口子）', () => {
  const items = [at('2026-10-14T12:00:00.000Z')]
  assert.deepEqual(pickPatrolItems(items, new Date('2026-10-14T00:00:00.000Z'), 0), [])
})

test('nextSince：**推进到全部提醒里最新的时刻**，不是"弹出去那几条里最新的"', () => {
  // 这是"不重复弹"的关键：被上限挡下的那些会在下一次变成"新的"再弹一轮
  const all = [at('2026-10-14T12:00:00.000Z'), at('2026-10-14T11:00:00.000Z'), at('2026-10-14T10:00:00.000Z')]
  const since = new Date('2026-10-14T00:00:00.000Z')
  assert.equal(pickPatrolItems(all, since, 1).length, 1)
  assert.equal(nextSince(all, since)?.toISOString(), '2026-10-14T12:00:00.000Z')
  // 于是下一次同样的数据不会再弹
  assert.deepEqual(pickPatrolItems(all, nextSince(all, since), 3), [])
})

test('nextSince：没有新的就**保持原值**（不该把 since 推到现在，否则中间的会漏掉）', () => {
  const since = new Date('2026-10-14T10:00:00.000Z')
  assert.equal(nextSince([at('2026-10-14T08:00:00.000Z')], since)?.toISOString(), '2026-10-14T10:00:00.000Z')
})

test('nextSince：第一次（没有 since、也没有提醒）仍然是 null', () => {
  assert.equal(nextSince([], null), null)
})

test('nextSince：第一次就把所有提醒里最新的那个记下来（**但不弹**）', () => {
  const all = [at('2026-10-14T12:00:00.000Z'), at('2026-10-14T08:00:00.000Z')]
  // 这正是"装完第一次巡查"的形态：不弹，但把水位线立起来，之后从它往后比
  assert.deepEqual(pickPatrolItems(all, null, 3), [])
  assert.equal(nextSince(all, null)?.toISOString(), '2026-10-14T12:00:00.000Z')
})

test('nextSince：脏数据不影响水位线（跳过看不懂的）', () => {
  assert.equal(nextSince([at('不是时刻'), at('2026-10-14T12:00:00.000Z')], null)?.toISOString(), '2026-10-14T12:00:00.000Z')
})
