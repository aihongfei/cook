import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ALLOWED_AVATARS,
  normalizeAccount,
  validateAccount,
  validateAvatar,
  validateNickname,
  validatePassword,
} from '../src/modules/auth/account.rules'
import { hashPassword, verifyPassword } from '../src/modules/auth/password.service'

// 注册登录的判定口径（F2-01）与密码存储（R-07）。

test('密码只存派生结果，且同一密码两次哈希不相同（加盐生效）', async () => {
  const first = await hashPassword('cook2026pass')
  const second = await hashPassword('cook2026pass')
  assert.notEqual(first, second, '两次哈希必须不同，否则说明没加随机盐')
  assert.ok(first.startsWith('scrypt$'), '格式自描述，便于日后换参数')
  assert.ok(!first.includes('cook2026pass'), '绝不能出现明文')
  // 自描述格式：算法$N$r$p$salt$hash
  assert.equal(first.split('$').length, 6)
})

test('verifyPassword 对正确密码通过、错误密码失败', async () => {
  const stored = await hashPassword('cook2026pass')
  assert.equal(await verifyPassword('cook2026pass', stored), true)
  assert.equal(await verifyPassword('cook2026Pass', stored), false, '大小写不同必须失败')
  assert.equal(await verifyPassword('cook2026pas', stored), false)
  assert.equal(await verifyPassword('', stored), false)
})

test('verifyPassword 面对损坏/陌生格式一律返回 false 而不是抛错', async () => {
  assert.equal(await verifyPassword('whatever', ''), false)
  assert.equal(await verifyPassword('whatever', 'plain-text-password'), false)
  assert.equal(await verifyPassword('whatever', 'argon2$1$2$3$aa$bb'), false, '不认识的算法拒绝')
  assert.equal(await verifyPassword('whatever', 'scrypt$0$8$1$aa$bb'), false, '非法参数拒绝')
  assert.equal(await verifyPassword('whatever', 'scrypt$32768$8$1$zz$bb'), false, '非十六进制盐拒绝')
})

test('参数升级后老哈希仍可校验（自描述格式的意义）', async () => {
  // 用较低强度参数生成的旧哈希，仍能被按它自己记录的参数校验通过
  const legacy = await hashPassword('cook2026pass', { N: 4096, r: 8, p: 1 })
  assert.ok(legacy.startsWith('scrypt$4096$'))
  assert.equal(await verifyPassword('cook2026pass', legacy), true)
})

test('账号规则：归一化大小写与空格，长度与字符集受限', () => {
  assert.equal(normalizeAccount('  Mama_01  '), 'mama_01')
  assert.equal(validateAccount('mama_01'), null)
  assert.equal(validateAccount('  Mama_01 '), null, '前后空格不算问题')
  assert.equal(validateAccount('13800138000'), null, '手机号可直接当账号')
  assert.equal(validateAccount('mama@home.cn'), null, '邮箱也可直接当账号')
  assert.ok(validateAccount('ma'))
  assert.ok(validateAccount('a'.repeat(33)))
  assert.ok(validateAccount('妈妈'), '中文账号不接受（避免同形字与大小写归一化的坑）')
  assert.ok(validateAccount('mama 01'), '不允许空格')
})

test('密码规则：8–64 位且必须同时含字母与数字', () => {
  assert.equal(validatePassword('cook2026pass'), null)
  assert.ok(validatePassword('short1'))
  assert.ok(validatePassword('12345678'), '纯数字不接受')
  assert.ok(validatePassword('abcdefgh'), '纯字母不接受')
  assert.ok(validatePassword('a'.repeat(65)), '超长拒绝')
})

test('昵称与头像规则', () => {
  assert.equal(validateNickname('妈妈'), null)
  assert.ok(validateNickname('   '))
  assert.ok(validateNickname('很长的昵称'.repeat(5)))
  assert.equal(validateNickname('a'.repeat(16)), null, '16 个字符合法')
  assert.ok(validateNickname('a'.repeat(17)))
  // emoji 按字符数算，不按 UTF-16 长度算
  assert.equal(validateNickname('👨‍👩‍👧 一家'), null)

  assert.equal(validateAvatar('🐰'), null)
  assert.ok(validateAvatar('💀'), '只能选白名单里的头像')
  assert.ok(validateAvatar(''))
  assert.equal(ALLOWED_AVATARS.length, 8)
})
