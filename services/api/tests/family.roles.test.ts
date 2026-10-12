import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAPABILITIES,
  FAMILY_MEMBER_LIMIT,
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  ROLE_CAPABILITIES,
  can,
  capabilitiesOf,
  generateInviteCode,
  isFamilyRole,
  normalizeInviteCode,
} from '../src/modules/family/family.roles'
import { normalizeEmail, validateEmail } from '../src/modules/auth/account.rules'

// 家庭角色与权限口径（F2-05/06/09，见 DECISIONS D-021）。

test('角色只有三档，且必须能识别非法角色', () => {
  assert.ok(isFamilyRole('OWNER') && isFamilyRole('COOK') && isFamilyRole('EATER'))
  assert.ok(!isFamilyRole('ADMIN'), '不存在的角色必须被拒')
  assert.ok(!isFamilyRole(undefined) && !isFamilyRole(null) && !isFamilyRole(''))
})

test('掌勺人拥有全部能力，吃货只能点菜', () => {
  const all = Object.values(CAPABILITIES)
  assert.deepEqual([...capabilitiesOf('OWNER')].sort(), [...all].sort(), '掌勺人应当拥有全部能力（新增能力点时会提醒维护者）')
  assert.deepEqual(capabilitiesOf('EATER'), [CAPABILITIES.ORDER_CREATE], '吃货只能点菜')

  // 帮厨：能干活但不能管人（这是"帮厨"和"掌勺人"的关键区别）
  assert.ok(can('COOK', CAPABILITIES.MENU_MANAGE))
  assert.ok(can('COOK', CAPABILITIES.MENU_CONFIRM))
  assert.ok(can('COOK', CAPABILITIES.ORDER_CREATE))
  assert.ok(!can('COOK', CAPABILITIES.MEMBER_MANAGE), '帮厨不能管成员')
  assert.ok(!can('COOK', CAPABILITIES.INVITE_RESET), '帮厨不能重置邀请码')
  assert.ok(!can('COOK', CAPABILITIES.FAMILY_EDIT), '帮厨不能改家庭信息')

  // 吃货连"改菜单"都不行——这是点菜与安排的分界
  assert.ok(!can('EATER', CAPABILITIES.MENU_MANAGE))
  assert.ok(!can('EATER', CAPABILITIES.MENU_CONFIRM))
})

test('M3/M4 的能力点已预留在同一张表里（不另起一套）', () => {
  // 这三个是下一个里程碑要用的，先断言存在：将来谁把 key 改掉，这里会失败
  assert.equal(CAPABILITIES.ORDER_CREATE, 'order.create')
  assert.equal(CAPABILITIES.MENU_MANAGE, 'menu.manage')
  assert.equal(CAPABILITIES.MENU_CONFIRM, 'menu.confirm')
  for (const role of ['OWNER', 'COOK', 'EATER'] as const) {
    assert.ok(ROLE_CAPABILITIES[role].includes(CAPABILITIES.ORDER_CREATE), `${role} 至少要能点菜`)
  }
})

test('邀请码是六位，且不含会认错的字符', () => {
  assert.equal(INVITE_CODE_LENGTH, 6, '用户明确要求六位')
  const code = generateInviteCode()
  assert.equal(code.length, 6)
  for (const char of code) {
    assert.ok(INVITE_CODE_ALPHABET.includes(char), `邀请码出现了字符集外的字符：${char}`)
  }
  // 口头念给对方时最容易认错的就是这几个
  for (const char of ['I', 'O', '0', '1']) {
    assert.ok(!code.includes(char), `邀请码不该出现易混字符 ${char}`)
  }
})

test('邀请码生成有随机性，不会每次都一样', () => {
  const codes = new Set(Array.from({ length: 40 }, () => generateInviteCode()))
  assert.ok(codes.size > 30, `40 次生成应基本不重复，实际只有 ${codes.size} 个不同的码`)
})

test('邀请码归一：小写与空格都当作大写输入处理', () => {
  assert.equal(normalizeInviteCode('  a b 2 c d 9 '), 'AB2CD9')
  assert.equal(normalizeInviteCode('ab2cd9'), 'AB2CD9')
})

test('家庭成员上限是个合理的小数字', () => {
  assert.ok(FAMILY_MEMBER_LIMIT >= 2 && FAMILY_MEMBER_LIMIT <= 20, `上限 ${FAMILY_MEMBER_LIMIT} 超出合理范围`)
})

test('邮箱：小写归一、格式非法被拒（F2-04）', () => {
  assert.equal(normalizeEmail('  Mama@Example.COM '), 'mama@example.com')
  assert.equal(validateEmail('mama@example.com'), null)
  assert.equal(validateEmail('mama+1@sub.example.com'), null, '带子域名的邮箱也要能过')
  assert.ok(validateEmail('mama'), '没有 @ 的不是邮箱')
  assert.ok(validateEmail('mama@localhost'), '没有点号的域名不收（找回密码要能真发到）')
  assert.ok(validateEmail('@example.com') && validateEmail('mama@.com'))
})
