import assert from 'node:assert/strict'
import test from 'node:test'
import { isResponseFormatRejection } from '../src/modules/ai/ai.client'
import { shouldRetryStructuredStream } from '../src/modules/ai/ai.pi.rules'

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

// ---------------------------------------------------------------------------
// 流式那条路上的重试判据（F16-02，2026-10-15 补）
//
// 与非流式那条的差别只有**一个条件**：`emitted`（已经吐过字没有）。
// 那一条是这次补 `jsonSchema` 形参时才存在的——流式把正文一段段 yield 出去，
// 调用方（SSE）当场就写到用户屏幕上了；吐过字之后再重试，用户会看到自己刚读的
// 那段话被抹掉重写一遍，那比报一次错更糟。
// ---------------------------------------------------------------------------

test('一个字都没吐时：结构化被拒 → 重试（与 chatJson 的行为对齐）', () => {
  assert.equal(
    shouldRetryStructuredStream({
      withSchema: true,
      emitted: false,
      status: 400,
      message: 'Upstream request failed: [invalid_request_error] This response_format type is unavailable now',
    }),
    true,
  )
})

test('**已经吐过字就不再重试**——用户会看到刚读的话被抹掉重写', () => {
  assert.equal(
    shouldRetryStructuredStream({
      withSchema: true,
      emitted: true,
      status: 400,
      message: 'This response_format type is unavailable now',
    }),
    false,
  )
})

test('已经去掉 schema 的那一趟不再重试（天然防循环）', () => {
  // 去掉之后还被 400（比如模型名写错），再摘也没有可摘的东西了
  assert.equal(
    shouldRetryStructuredStream({ withSchema: false, emitted: false, status: 400, message: 'response_format' }),
    false,
  )
})

test('别的 400 不认（模型名写错、消息格式不对：重试一百次还是错，还白花额度）', () => {
  for (const message of ['model not found: gpt-5', 'messages must be a non-empty array', '']) {
    assert.equal(
      shouldRetryStructuredStream({ withSchema: true, emitted: false, status: 400, message }),
      false,
      `${JSON.stringify(message)} 不该触发重试`,
    )
  }
})

test('不是 400 就不认（401/429/5xx 都该如实报，重试解决不了它们）', () => {
  for (const status of [401, 403, 429, 500, 502]) {
    assert.equal(
      shouldRetryStructuredStream({
        withSchema: true,
        emitted: false,
        status,
        message: 'This response_format type is unavailable now',
      }),
      false,
      `${status} 不该触发重试`,
    )
  }
})

test('两条路的判据同源于一个正则：认得出 response_format 的措辞就都认得出', () => {
  // 搬去 ai.pi.rules 之后两边共用 isResponseFormatRejection——分开写必然漂移
  const samples = [
    '[invalid_request_error] This response_format type is unavailable now',
    'The requested feature is unavailable now',
    'model not found',
  ]
  for (const sample of samples) {
    assert.equal(
      shouldRetryStructuredStream({ withSchema: true, emitted: false, status: 400, message: sample }),
      isResponseFormatRejection(sample),
      `「${sample}」两边判定不一致`,
    )
  }
})
