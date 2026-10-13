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
/** STUB_REJECT_SCHEMA_ONCE 已经拒过哪些 schema 名（每种只拒一次，好让重试能走通） */
const rejectedSchemaNames = new Set()

const server = http.createServer((req, res) => {
  // 验收脚本用它取"服务端到底发了什么"（只读，仅本机验收用）
  if (req.url === '/__received' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(received))
    return
  }
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
    // **协议形状校验**：上游只认 {id, type:'function', function:{name, arguments}} 这种形状的
    // tool_calls。第一版服务端把内部对象直接塞回来了（{id,name,arguments}），真实网关 400 拒掉，
    // 而当时 stub 照单全收、什么都没报——于是"第一轮搜完菜就断"这个 bug 只能花真额度才能发现。
    // 这里补上这一层：形状不对就按上游的做法回 400，让本地验收也能拦住它。
    const badCalls = (parsed.messages ?? []).flatMap((m) => m.role === 'assistant' ? (m.tool_calls ?? []) : [])
      .filter((c) => c.type !== 'function' || typeof c.function?.name !== 'string' || typeof c.function?.arguments !== 'string')
    const orphanTool = (parsed.messages ?? []).some((m) => m.role === 'tool' && !m.tool_call_id)
    if (badCalls.length || orphanTool) {
      console.log(`[stub] !! 协议形状不合法：tool_calls=${JSON.stringify(badCalls).slice(0, 120)} 缺 tool_call_id=${orphanTool}`)
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model: parsed.model, error: { message: 'invalid tool_calls shape' } }))
      return
    }

    const system = parsed.messages?.find((m) => m.role === 'system')?.content ?? ''
    const user = parsed.messages?.find((m) => m.role === 'user')?.content ?? ''
    const tools = parsed.tools ?? []
    received.push({
      model: parsed.model,
      hasAuth: Boolean(req.headers.authorization),
      system,
      user,
      tools: tools.map((t) => t.function?.name),
      /**
       * 收到的结构化输出 schema 名（没有就 null）。
       *
       * 为什么要专门记这个：2026-10-13 出过一次真事故——server 对所有 `json: true` 的调用
       * 统一发推荐用的 `PICKS_SCHEMA`，于是"提示词"那条路被强制返回 `{picks:[...]}`、
       * 解析必然失败、前端静默回退到写死的那批。**只有从"发出去的请求"这一侧才能看到它**，
       * 所以 stub 记下来、验收脚本断言它（单测比不了两份常量，那是假安慰——试过，改接线不会红）。
       */
      schemaName: parsed.response_format?.json_schema?.name ?? null,
    })
    // 工具循环的第几轮：靠"消息里有没有 tool 结果"判断（服务端把工具结果回喂时才有 role=tool）
    const toolResults = parsed.messages?.filter((m) => m.role === 'tool') ?? []
    console.log(`[stub] model=${parsed.model} auth=${Boolean(req.headers.authorization)} 候选清单=${/id=/.test(system)} `
      + `response_format=${parsed.response_format?.type ?? '无'}(schema=${parsed.response_format?.json_schema?.name ?? '-'}) 工具=${tools.map((t) => t.function?.name).join(',') || '无'} `
      + `已回喂工具结果=${toolResults.length} 用户说=${user.slice(0, 40)}`)

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

    /*
     * STUB_REJECT_SCHEMA_ONCE=1 模拟**真网关偶发拒绝 response_format**（约 8 次里 5 次，
     * 错误体明说 `This response_format type is unavailable now`，见 D-026 / D-043）。
     *
     * 为什么需要它：这条路径唯一的替代验证是"拿真额度反复碰运气"，而它恰恰是**偶发**的
     * ——迁移到 pi-ai 之后第一次真网关验证就撞上了（`/ai/prompts` 502），说明它并不罕见。
     * 只拒第一次（按 schema 名记账），这样"摘掉 schema 重试一次"能真的走通并被验收看见。
     */
    const rejectSchemaOnce = process.env.STUB_REJECT_SCHEMA_ONCE === '1'
      && Boolean(parsed.response_format?.json_schema?.name)
      && !rejectedSchemaNames.has(parsed.response_format.json_schema.name)
    if (rejectSchemaOnce) {
      rejectedSchemaNames.add(parsed.response_format.json_schema.name)
      // 在记录上打标：验收脚本据此断言"客户端摘掉 schema 补发了一次"
      if (received.length > 0) received[received.length - 1].schemaRejected = true
      console.log(`[stub] !! 按 STUB_REJECT_SCHEMA_ONCE 拒绝这次 response_format（schema=${parsed.response_format.json_schema.name}）`)
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        param: null,
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: 'Upstream request failed: [invalid_request_error] This response_format type is unavailable now',
      }))
      return
    }

    // ---------- 快问/示例问题（用户 2026-10-12：「内置的这些不够用」）----------
    // 提示词要的是 {"hints":[...],"examples":[...]}。stub 故意回**一份脏数据**：
    // 一条重复的、一条超长的、一条非字符串的 —— 服务端必须清洗掉它们并且仍然凑够一屏，
    // 这样"模型的回包要核对"这条在本地就验到了（不然只能靠真额度碰运气）。
    const askedForPrompts = /"hints"/.test(system)
    const promptsAnswer = JSON.stringify({
      hints: ['清淡点', '想吃肉', '想吃肉', '孩子也能吃', '快手菜', '想喝汤', 42, '这是一条故意超长的快问超过十二个字'],
      examples: ['肉怎么去腥', '肉怎么去腥', '鱼怎么煎不破皮', null, '鸡蛋能放多久'],
    })

    const content = echoObject
      ? JSON.stringify(parsed.response_format)
      : askedForPrompts ? promptsAnswer
        : askedForPicks ? picksAnswer : '今晚可以煮个青菜豆腐汤，配一盘蒜蓉西兰花，清爽又省事。'

    // ---------- 工具循环（D-026 第三次补充）----------
    // 服务端把工具声明发过来时，脚本按"真实模型会怎么走"来演。判据看 role=tool 的消息数：
    //   第 1 轮：没有任何工具结果 → 回 tool_calls（先搜菜，**两个并行调用**，与实测的真网关一致）
    //   第 2 轮：已有工具结果 → 回 tool_calls（提议加菜），参数里**带一条编造的 id**
    //   第 3 轮：再回喂一次 → 回正文收尾
    // 编造的 id 是故意的：服务端必须把它丢掉、只留真实那道（这条正是本次要验的核心）。
    const toolMode = tools.some((t) => t.function?.name === 'search_dishes')
    const searchHit = toolResults.find((m) => /dishes/.test(String(m.content)))
    // 真 id **从上一轮的工具结果里现取**（stub 自己编的搜索结果里放的什么，就提什么）
    const realId = /"recipeId":"([^"]+)"/.exec(String(searchHit?.content ?? ''))?.[1] ?? ''
    // 轮次判据按**内容**分，不按工具结果的条数：模型会并行发多个调用（实测真网关就是两个
    // search_dishes 一起回），那一轮就有两条 tool 消息——按条数分会把第 2 轮误判成第 3 轮，
    // 直接跳到收尾，propose 那一轮永远轮不到（这个 bug 让第一次验收红了）。
    const proposed = toolResults.some((m) => /accepted/.test(String(m.content)))
    const searched = toolResults.length > 0
    const toolPlan = (!toolMode) ? null
      : !searched ? { calls: [
          { id: 'call_stub_1', name: 'search_dishes', args: { query: '清淡' } },
          { id: 'call_stub_2', name: 'search_dishes', args: { query: '汤' } },
        ] }
      : !proposed ? { calls: [
          { id: 'call_stub_3', name: 'propose_menu_items', args: { items: [
            { recipeId: 'invented-by-model', mealDate: '2026-10-12', meal: 'DINNER' },
            ...(realId ? [{ recipeId: realId, mealDate: '2026-10-12', meal: 'DINNER', note: '少放盐' }] : []),
          ] } },
        ] }
      : { text: '今晚就这两道吧，一荤一素搭着刚好。要我把它们加进今天晚餐吗？' }

    if (toolPlan?.calls) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
      const frame = (delta, finish) => `data: ${JSON.stringify({
        id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
      res.write(frame({ role: 'assistant', content: '我看看菜谱库里有什么。' }, null))
      // 工具调用**按碎片发**：参数一段一段来（真实上游就是这样，见 ai.client 的归并逻辑）。
      // 一次发完的话，"参数碎片要按 index 拼起来"这条实现就没被验到。
      toolPlan.calls.forEach((call, index) => {
        const json = JSON.stringify(call.args)
        res.write(frame({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] }, null))
        for (const piece of json.match(/.{1,8}/gs) ?? []) {
          res.write(frame({ tool_calls: [{ index, function: { arguments: piece } }] }, null))
        }
      })
      res.write(frame({}, 'tool_calls'))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    if (toolPlan?.text) { /* 落到下面的正常流式分支，正文用收尾那句话 */ }

    // 真实服务在 stream:false 时回普通 JSON；STUB_FORCE_STREAM=1 时强制走 SSE，
    // 用来验客户端的"网关不听话照样回 SSE"降级路径
    const finalContent = toolPlan?.text ?? content
    const useSse = parsed.stream === true || process.env.STUB_FORCE_STREAM === '1'
    if (!useSse) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-stub', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: parsed.model,
        choices: [{ index: 0, message: { role: 'assistant', content: finalContent }, finish_reason: 'stop' }],
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
    for (const piece of finalContent.match(/.{1,12}/gs) ?? []) {
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
