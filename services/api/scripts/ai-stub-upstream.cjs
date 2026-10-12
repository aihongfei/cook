#!/usr/bin/env node
/**
 * 起一个 OpenAI 兼容的本地 stub 上游，用来验收「AI 已配置」那条路径（RUNBOOK R-018）。
 *
 * 为什么需要它：AI 的功能验收不能依赖用户的真实密钥与真实额度（也不该把密钥写进脚本）。
 * 这个 stub 回**固定但形状真实**的 SSE 回包，于是能验证一件最关键的事——
 * **服务端确实把候选清单发给了模型、并且把模型编造的 id 丢掉了**。
 *
 * 用法：node scripts/ai-stub-upstream.cjs [port]（默认 18990）
 * 启动服务时把 AI_API_BASE 指过来即可：
 *   AI_API_BASE=http://host.docker.internal:18990/v1 AI_API_KEY=stub-key AI_MODEL=stub-model \
 *     docker compose up -d --build api
 */
const http = require('node:http')

const port = Number(process.argv[2] ?? 18990)
const received = []

const server = http.createServer((req, res) => {
  if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
    res.writeHead(404).end()
    return
  }
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    let parsed = {}
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = {}
    }
    const system = parsed.messages?.find((m) => m.role === 'system')?.content ?? ''
    const user = parsed.messages?.find((m) => m.role === 'user')?.content ?? ''
    received.push({ model: parsed.model, hasAuth: Boolean(req.headers.authorization), system, user })
    console.log(`[stub] model=${parsed.model} auth=${Boolean(req.headers.authorization)} 候选清单=${/id=/.test(system)} response_format=${parsed.response_format?.type ?? '无'} 用户说=${user.slice(0, 40)}`)

    // 回包形状要跟真实网关一致：推荐那段**带一条编造的 id**，用来验证服务端会不会丢掉它。
    // 故意**不加 ```json 包裹**——实测真实网关就是这么回的（提示词要 JSON，它给裸数组）。
    const askedForPicks = /picks|id=/.test(system)
    // 真 id 必须**从收到的候选清单里现取**：这样"推荐能落到本库的菜上"才有意义——
    // 写死一个假 id 的话，服务端把它（连同编造的 id）一起丢掉也照样"通过"，等于没验。
    const firstRealId = /- id=(\S+)/.exec(system)?.[1] ?? ''
    const picksAnswer = JSON.stringify({
      picks: [
        { id: 'invented-by-model', reason: '我编的这条必须被丢掉' },
        ...(firstRealId ? [{ id: firstRealId, reason: '清单里的第一道，清淡快手' }] : []),
      ],
    })

    // STUB_ECHO_JSON_OBJECT=1 模拟**老 json_object 模式的故障**：模型把该参数原样当正文回。
    // 这不是虚构——实测真实网关（DeepSeek）就是这个行为，所以客户端只能用 json_schema（见 D-026）。
    const echoObject = parsed.response_format?.type === 'json_object' && process.env.STUB_ECHO_JSON_OBJECT === '1'
    const content = echoObject
      ? JSON.stringify(parsed.response_format)
      : askedForPicks ? picksAnswer : '今晚可以煮个青菜豆腐汤，配一盘蒜蓉西兰花，清爽又省事。'

    // 真实服务在 stream:false 时回普通 JSON；STUB_FORCE_STREAM=1 时强制走 SSE，
    // 用来验客户端的"网关不听话照样回 SSE"降级路径
    const useSse = parsed.stream === true || process.env.STUB_FORCE_STREAM === '1'
    if (!useSse) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-stub', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: parsed.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }))
      return
    }

    const chunk = (delta, finish) => JSON.stringify({
      id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
      model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }],
    })
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
    res.write(`data: ${chunk({ role: 'assistant', content: '' }, null)}\n\n`)
    // **按小段发**，别一整段塞进一个 chunk：真实模型是逐段吐的，而验收里有一条
    // "流式要分段到（不是攒成一坨）"——stub 一次发完时那条会红，看起来像产品坏了，
    // 实际是 stub 不够真实。这里按字符切几段，形状与真实上游一致。
    for (const piece of content.match(/.{1,12}/gs) ?? []) {
      res.write(`data: ${chunk({ content: piece }, null)}\n\n`)
    }
    res.write(`data: ${chunk({}, 'stop')}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

// 供测试脚本查询"服务端到底发了什么"（只用于验收，不参与产品逻辑）
server.on('request', () => {})

server.listen(port, () => console.log(`[stub] OpenAI 兼容上游已就绪：http://127.0.0.1:${port}/v1`))

process.on('SIGTERM', () => { server.close(); process.exit(0) })
