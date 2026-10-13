import assert from 'node:assert/strict'
import test from 'node:test'
import { isResponseFormatRejection } from '../src/modules/ai/ai.client'

// "这个 400 是不是不接受 response_format 引起的"——决定要不要摘掉 schema 重试一次（D-044）。
//
// 为什么值得单独测：这个判定写宽了会"什么都重试一遍"（白花用户额度、还掩盖真正的问题），
// 写窄了会让推荐/提示词两条路在网关抽风时直接 502（真网关实测踩过：迁移后第一版就是
// 无条件不重试，`/ai/prompts` 立刻 502 了）。两边的错误都要能认出来，别的一律不认。

test('认出网关明说的那种拒绝（实测原文）', () => {
  assert.equal(
    isResponseFormatRejection('Upstream request failed: [invalid_request_error] This response_format type is unavailable now (request_id: 35c85c...)'),
    true,
  )
})

test('只提到"不可用"也算（错误体被截断时措辞还在）', () => {
  assert.equal(isResponseFormatRejection('The requested feature is unavailable now'), true)
})

test('别的 400 不认——否则会拿用户的额度反复重试一个真问题', () => {
  // 模型名写错：重试一百次也还是错，还会让现场看不到真正的原因
  assert.equal(isResponseFormatRejection('model not found: gpt-5'), false)
  // 消息格式不对
  assert.equal(isResponseFormatRejection('messages must be a non-empty array'), false)
  // 空详情（网关只回 {"model":"..."} 那种截断形状）：认不出来就不重试，如实报错
  assert.equal(isResponseFormatRejection(''), false)
})
