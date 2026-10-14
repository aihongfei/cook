// @vitest-environment jsdom
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { clearSince, deviceId, readSince, writeSince } from '@/api/patrol'

/**
 * 巡查的手机侧（M10 交付三）。
 *
 * 这里只盯**纯本地的那几件事**（令牌与水位线怎么存、设备标识怎么来）——
 * "怎么调插件"与"什么时候送配置"在 `patrol-sync.test.tsx` 里，
 * 后端的"该弹哪些"在 `services/api/tests/patrol.rules.test.ts` 里。
 *
 * 两条最要紧的：**设备标识稳定**（令牌按"账号 + 设备"分行，每次换个新 id 会
 * 每次登录都把旧行顶掉、家里另一台跟着乱）与**水位线按账号分开**
 * （换账号不能把上一个人的旧事当新的弹）。
 */

beforeEach(() => {
  localStorage.clear()
})

afterEach(cleanup)

it('设备标识**生成一次就稳定**（令牌按账号+设备分行，每次都换会让记录乱掉）', () => {
  const first = deviceId()
  expect(first).toBeTruthy()
  expect(deviceId()).toBe(first)
  expect(deviceId()).toBe(first)
})

it('设备标识存在本地，重开还在（不是每次会话一个新 id）', () => {
  const first = deviceId()
  // 模拟"同一台手机下次启动"：清掉内存里的东西不影响 localStorage
  const again = localStorage.getItem('yushan-patrol-device')
  expect(again).toBe(first)
})

it('水位线按账号分开：换账号各记各的（不能把上一个人的旧事当新的弹）', () => {
  writeSince('u1', '2026-10-14T10:00:00.000Z')
  writeSince('u2', '2026-10-14T12:00:00.000Z')
  expect(readSince('u1')).toBe('2026-10-14T10:00:00.000Z')
  expect(readSince('u2')).toBe('2026-10-14T12:00:00.000Z')
})

it('没有水位线时读到 null（第一次巡查 → 后端一条都不弹）', () => {
  expect(readSince('u-nobody')).toBeNull()
})

it('清水位线只清那一个账号（退出登录时用；别人的不能跟着丢）', () => {
  writeSince('u1', '2026-10-14T10:00:00.000Z')
  writeSince('u2', '2026-10-14T12:00:00.000Z')
  clearSince('u1')
  expect(readSince('u1')).toBeNull()
  expect(readSince('u2')).toBe('2026-10-14T12:00:00.000Z')
})

it('`since` 传 null 时**不覆盖**已记下的（后端偶尔没给水位线，不该把它清掉）', () => {
  writeSince('u1', '2026-10-14T10:00:00.000Z')
  writeSince('u1', null)
  expect(readSince('u1')).toBe('2026-10-14T10:00:00.000Z')
})
