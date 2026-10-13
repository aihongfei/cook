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

/** 今天的日期键（stub 自己算一份：它不 import 产品代码，只模仿模型的行为） */
function todayKeyForStub() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** 用户那句话里可能提到的组合名（真实模型会照用户说的取，stub 取不到就给一个固定名） */
function comboNameForStub(user) {
  const named = /组合(?:叫|名)?[「"']?([^」"'\s]{2,12})/.exec(user)?.[1]
  return named || '快手三菜'
}

/**
 * 用户说的日期（`今天`/`明天`/`后天`/`YYYY-MM-DD`）。
 *
 * 真实模型是从"今天午餐"里理解出日期的，stub 也必须听懂——第一版这里写死"今天"，
 * 于是验收里说"今天午餐"它加到了今天晚餐，断言看着像产品坏了。
 */
function menuDateForStub(user) {
  const explicit = /(\d{4}-\d{2}-\d{2})/.exec(user)?.[1]
  if (explicit) return explicit
  const offset = /后天/.test(user) ? 2 : /明天/.test(user) ? 1 : 0
  // 与产品同一口径：**按本地日历**算（容器 TZ=Asia/Shanghai，见 RUNBOOK R-18）。
  // 用 toISOString 会是 UTC，在晚上 8 点之后（东八区）差一天，验收就会"读到别的那一餐"。
  const now = new Date(Date.now() + offset * 86_400_000)
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/**
 * 把 `read_menu` 那段文字解回结构（每一天每一餐，每道菜的 itemId）。
 *
 * 为什么要解回结构而不是正则随手抓一个：菜单里有**好几餐**，抓第一个 itemId
 * 就会撤错餐里的菜（第一版就是这样：明明说"撤掉午餐那道"，它拿的是别的餐的 id）。
 * 形状是产品侧 `menuText()` 定的（`mealKey: xxx` + `- 菜名（…）（itemId: yyy）`），
 * 这里照着解——stub 与产品共用这个约定，改形状时两边一起改。
 */
function parseMenuForStub(text) {
  const rows = []
  let current = null
  for (const line of String(text).split('\n')) {
    const head = /（mealKey: ([^）]+)）/.exec(line)
    if (head) {
      current = { mealKey: head[1], dishes: [] }
      rows.push(current)
      continue
    }
    const dish = /^\s*-\s*(.+?)（.*）（itemId: ([^）]+)）$/.exec(line)
    if (dish && current) current.dishes.push({ name: dish[1], itemId: dish[2] })
  }
  return rows
}

/** 菜谱那一支的收尾话（工具都跑完之后） */
function recipeTextForStub(recipeMode, wantsDelete, wantsUpdate, failLine) {
  if (!recipeMode) return undefined
  // 工具结果里有拒绝原话就照实转述（公共菜谱改不了那类）——**不许说"改好了"**
  if (failLine) return failLine
  if (wantsDelete) return '删掉了，回执上可以放回去。'
  if (wantsUpdate) return '改好了，回执上能改回去。'
  return '存好了，「我家的菜谱」里能看到了。'
}

/**
 * 组合那一支的收尾话（工具都跑完之后）。
 * 单独一个函数是因为它要按"这次做了哪件事"分岔，写在 finalContent 那一行里会看不出在说什么。
 */
function comboTextForStub(comboMode, mode) {
  if (!comboMode) return undefined
  if (mode === 'add') return '这一组加进去了，回执上一道一个「撤」。'
  if (mode === 'delete') return '组合删掉了，回执上可以放回来。'
  if (mode === 'update') return '改好了，回执上能改回去。'
  return '存好了，回执上可以撤。'
}

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
    /*
     * **最后**一条用户消息才是用户现在问的。
     *
     * 原来是 `find`（第一条）：单条消息的验收看不出来，但真实对话会把**整场历史**一起发过来，
     * 于是 stub 一直在回答**最早**那句话——浏览器里实测就是这样（问"采购清单上有什么"，
     * 它回的是十几轮之前那句的答案）。真实模型看的是最后一条，stub 必须一致。
     */
    const lastUser = [...(parsed.messages ?? [])].reverse().find((m) => m.role === 'user')
    const user = (() => {
      const content = lastUser?.content
      if (typeof content === 'string') return content
      // 带图的消息是内容块数组（文字块在前）：判用户意图只看得见文字那部分
      if (Array.isArray(content)) {
        return content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
      }
      return ''
    })()
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

    // ---------- 冰箱（F16-10 / D-052 的 A 档：真的写库）----------
    /*
     * 演法与菜单那条**刻意不同**：冰箱这一档模型是**真的会写进去**的，
     * 所以 stub 也走真实的两轮——先 `read_fridge` 看清现状（拿真实 id），再动手。
     * 这正好压住两件会出事的地方：
     * ① **不许凭记忆操作**：删的时候那个 id 必须来自上一轮的读结果（stub 也一样，从读结果里现取）；
     * ② **一批里有一条失败时，成的那条仍要落库并出回执**——所以"加"那轮的 items 里
     *    第一样故意是"已经记过的"（验收脚本会先手记一条鸡蛋），它必然 409，
     *    而第二样（牛奶）必须仍然记进去。
     */
    /*
     * 只有用户**真的在说冰箱**时才演这条：`read_fridge` 永远在工具清单里，
     * 若只看"工具在不在"就会对每句话都去写冰箱（第一版就是这样，于是普通问一句
     * "今晚吃什么"也把冰箱写了，验收里的批次全乱）。真实模型是靠语义判断的，
     * stub 只能靠关键词——判据写成 stub 内部约定，产品代码不依赖它。
     *
     * **"买回来的收进冰箱"不算**：那句话说的是**采购清单**（`restock_shopping_items`），
     * 冰箱只是它的去处。不排掉的话两句会抢同一个"冰箱"关键词，落到冰箱那一支去
     * ——验收里就会出现"让它补货，它往冰箱记了一条牛奶"这种莫名其妙的结果。
     */
    const restockTalk = /买到|买回来|补货|采购/.test(user)
    /*
     * **"记一下"本身不算说冰箱**。这个词太泛了：「我对花生过敏，这个要记一下」
     * 一个字都没提冰箱，却会被吸到这一支来（验收现场就是这么错的：让它记忌口，
     * 它回的是"我记一下"，然后往冰箱里记东西）。真正说冰箱的那几句里都有"冰箱"，
     * 所以判据只留与冰箱绑定的那些词。
     *
     * 口味那几句也一并排掉（它们有自己的分支，见下文"口味与忌口"）。
     */
    const mentionsFridge = /冰箱|拿掉|吃完了|扔了|放进去/.test(user)
      && !restockTalk && !/忌口|过敏|口味|不吃|吃不了/.test(user)
    const fridgeMode = mentionsFridge && tools.some((t) => t.function?.name === 'read_fridge')
    /*
     * 要记的食材**从用户那句话里取**（真实模型也是这么理解"记一下鸡蛋和牛奶"的）。
     * 写死成"鸡蛋+牛奶"的话，验收脚本没法构造"两样都是新的"与"其中一样已存在"
     * 这两种情形，而它们正是这条路的两个关键分支。
     */
    const KNOWN_FOODS = ['鸡蛋', '牛奶', '西红柿', '黄瓜', '猪肉', '豆腐', '苹果', '盐', '酸奶', '白菜']
    const saidFoods = KNOWN_FOODS.filter((food) => user.includes(food))
    const fridgeRead = toolResults.find((m) => /（id: |冰箱是空的/.test(String(m.content)))
    const fridgeWrote = toolResults.some((m) => /已记下|已拿掉|已改|没记成|没找到/.test(String(m.content)))
    const wantsRemove = /拿掉|删掉|吃完了|扔了/.test(user)
    /*
     * 「改成…」= 改一条已有的（`update_fridge_item`）。这是四个冰箱工具里唯一
     * 没被端到端走过的一个（加/删/查都在验收里），而"改"恰恰是最容易出事的那条：
     * 它要**先读到 id 再动**，且撤销时要能"改回去"。
     * 判据写成"说了'改成'且点得出名字"——真实模型也是这么理解的。
     */
    const wantsUpdate = /改成|改成|变为|换成|改一下/.test(user) && !wantsRemove
    /** 想动的那条叫什么（删与改都要点名：D-052 要求"删除必须点名"） */
    const named = /(牛奶|鸡蛋|西红柿|黄瓜|猪肉|豆腐|苹果|酸奶|白菜|盐)/.exec(user)?.[1] ?? ''
    const wantedName = wantsRemove || wantsUpdate ? named : ''
    // 从上一轮读到的现状里**现取 id**（真实模型也只能这么干）
    /*
     * 工具结果的 content 是 `toolResult()` 序列化后的 **JSON 字符串**，那串 `\n` 在
     * 正则眼里不是换行符——所以不能拿 `[^\n]*` 去卡行边界：它一路跨过好几条记录，
     * 再加上贪婪量词，取到的是**想要的食材之后最后一条**的 id（验收现场就是这么错的：
     * 明说"把牛奶拿掉"，删掉的却是苹果，牛奶一直留在冰箱里）。
     * 正确做法是先把那层 JSON 解开，再按行找名字**完全相等**的那条。
     */
    const readText = (() => {
      const raw = String(fridgeRead?.content ?? '')
      try { return String(JSON.parse(raw).fridge ?? '') } catch { return '' }
    })()
    const readId = wantedName
      ? readText.split('\n')
        // 行形如「牛奶 · 两盒 · 冷藏（id: xxx）」；数量缺失时名字后面直接就是「（id: 」
        .map((line) => /^(.+?)(?: · .*?)?（id: ([^）]+)）$/.exec(line))
        .find((hit) => hit?.[1] === wantedName)?.[2] ?? ''
      : ''
    // 保质期只给牛奶带上，其余不带——顺带验"没说的字段不要编"（见 tools 里那条断言）。
    // 日期**不能写死 2099**：`parseExpiry` 会拒"年份太远"（十年外），那是刻意的护栏——
    // 第一版 stub 就写死在 2099，于是批量里两样都失败、回执一张也出不来（验收当场抓到）。
    const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
    const addArgs = {
      items: (saidFoods.length ? saidFoods : ['鸡蛋']).map((food) => ({
        name: food,
        amount: food === '牛奶' ? '两盒' : '一盒',
        zone: '冷藏',
        ...(food === '牛奶' ? { expiresOn: soon } : {}),
      })),
    }
    /*
     * 「改成…」要改成的数量：从句子里取（"改成一盒"→ 一盒）。
     * 取不到就不带这个字段——**不许编一个**（与"没说的字段不要编"同一条规矩，
     * 产品侧那条断言就是盯这个的）。区域同理：说"放到冷冻"才带 zone。
     */
    const updateAmount = /改成([一二两三四五六七八九十半\d]+[盒个袋斤把瓶包]?)/.exec(user)?.[1] ?? ''
    const updateZone = /(冷藏|冷冻|常温|干货)/.exec(user)?.[1] ?? ''
    const updateArgs = {
      itemId: readId,
      ...(updateAmount ? { amount: updateAmount } : {}),
      ...(updateZone ? { zone: updateZone } : {}),
    }
    const fridgePlan = !fridgeMode ? null
      : !fridgeRead ? { calls: [{ id: 'call_fridge_1', name: 'read_fridge', args: {} }] }
        : !fridgeWrote ? {
            calls: [wantsRemove && readId
              ? { id: 'call_fridge_2', name: 'remove_fridge_item', args: { itemId: readId } }
              // 要改但**没从读结果里拿到 id**：和删除同一条规矩——不硬猜、更不退成"记一条"
              : wantsUpdate && readId ? { id: 'call_fridge_6', name: 'update_fridge_item', args: updateArgs }
                : wantsUpdate ? { id: 'call_fridge_7', name: 'read_fridge', args: {} }
                  // 想删但**没从读结果里拿到 id**：不硬猜一个去删（真实模型也该在这儿停下问一句），
                  // 更**不能退成"记一条"**——那会让验收里出现"让它拿掉它却记了一条"这种诡异结果
                  : wantsRemove ? { id: 'call_fridge_5', name: 'read_fridge', args: {} }
                    // 已经读过一次还是找不到：说明真的没有，直说
                    : { id: 'call_fridge_3', name: 'add_fridge_items', args: addArgs }],
          }
        : {
            text: wantsRemove ? '已经从冰箱里拿掉了，要是点错了可以撤回来。'
              : wantsUpdate ? '改好了，回执卡上有「改回去」，点错了能还原。'
                : '记好了，回执卡上有「撤」，点错了能撤回来。',
          }
    if (fridgeMode) {
      console.log(`[stub] 冰箱分支：wantsRemove=${wantsRemove} wantsUpdate=${wantsUpdate} 想找=${wantedName || '-'} `
        + `读到的 id=${readId || '(空)'} 已读=${Boolean(fridgeRead)} 已写=${fridgeWrote} `
        + `→ ${fridgePlan?.calls?.map((c) => c.name).join(',') ?? '(收尾)'}`)
    }

    if (fridgePlan?.calls) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
      const frame = (delta, finish) => `data: ${JSON.stringify({
        id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
      res.write(frame({ role: 'assistant', content: wantsRemove ? '我看看冰箱里有什么。' : '我记一下。' }, null))
      fridgePlan.calls.forEach((call, index) => {
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

    // ---------- 菜单、餐次与组合（用户 2026-10-13：「软件的 CRUD ai 都可以操作」）----------
    /*
     * 与冰箱那条同一个演法：真的走"先读现状 → 再动手"两轮，id 一律**从上一轮的读结果里现取**
     * （真实模型也只能这么干）。产品侧那条"不许凭记忆操作"的规矩因此也被压住了。
     *
     * 覆盖四件事，正好是四个工具：
     * ① 加菜（`add_menu_items`，先 `search_dishes` 拿真实菜谱 id）；
     * ② 撤菜（`remove_menu_item`，id 来自 `read_menu` 的返回）；
     * ③ 改人数（`set_diners`，数字从句子里取）；
     * ④ 改状态（`set_meal_status`，目标状态从关键词取）。
     * 组合那三件另有分支（create/update/delete + 一键加菜）。
     *
     * 判据写成 stub 内部约定（关键词），产品代码不依赖它们——真实模型是靠语义判断的。
     */
    /*
     * 哪一轮"没有工具"= 服务端的**收尾轮**（`TOOL_ROUNDS_MAX` 用完时它会发一个不带 tools 的请求，
     * 见 ai.service 里那段）。真实模型在这一轮也照样说话，所以 stub 必须按同一个"用户说了什么"
     * 来判断该说哪句——第一版这里用"工具在不在"当判据，于是收尾轮掉进了通用兜底文案
     * （验收里看着像"AI 答非所问"，其实是 stub 演错了）。
     */
    const closingRound = tools.length === 0
    const menuToolsReady = closingRound || tools.some((t) => t.function?.name === 'read_menu')
    const mentionsMenu = /加进|点上|加到菜单|加菜|撤掉|从菜单|人吃|几个人|做好了|选好了|取消这餐/.test(user)
    const menuText = (() => {
      const hit = toolResults.find((m) => /mealKey|还没点菜|还没有安排/.test(String(m.content)))
      const raw = String(hit?.content ?? '')
      try { return String(JSON.parse(raw).menu ?? '') } catch { return '' }
    })()
    const menuRead = menuText !== ''
    const menuWrote = toolResults.some((m) => /已加进菜单|已从菜单里撤掉|已设定|已改：|没加成/.test(String(m.content)))
    const menuWantsRemove = /撤掉|从菜单里拿掉|不要这道/.test(user)
    const menuWantsDiners = /人吃|几个人|人数/.test(user)
    const menuStatus = /做好了/.test(user) ? 'DONE'
      : /选好了|就这么定/.test(user) ? 'PLANNED'
        : /开始做/.test(user) ? 'COOKING'
          : /取消这餐|这餐取消/.test(user) ? 'CANCELED' : ''
    const dinerCount = Number(/(\d+)\s*个?人/.exec(user)?.[1] ?? '') || 4
    const saidDish = /(番茄|鸡蛋|豆腐|黄瓜|白菜|排骨|西兰花|土豆)/.exec(user)?.[1] ?? '番茄'
    /*
     * 用户说的"哪一天哪一餐"——**真实模型是从这句话里理解的**，stub 也照做。
     * 第一版这里写死了"今天晚餐"，于是验收里明说"今天午餐"却被加到晚餐，
     * 断言看着像产品坏了（其实是 stub 没听懂话）。日期/餐次都不能写死。
     */
    const saidSlot = /午餐|午饭|中饭/.test(user) ? 'LUNCH' : /晚餐|晚饭|晚上/.test(user) ? 'DINNER' : ''
    const saidDate = menuDateForStub(user)
    /** 从"读菜单"的文字里挑出用户说的那一餐（mealKey 与它下面的菜） */
    const namedDish = /(番茄|鸡蛋|豆腐|黄瓜|白菜|排骨|西兰花|土豆)/.exec(user)?.[1] ?? ''
    const allMeals = parseMenuForStub(menuText)
    /*
     * 选哪一餐：说了餐次就按说的那一天那一餐找；**没点名餐次时按"哪一餐里有用户说的那道菜"找**
     * （真实模型也是这么理解的——"把菜单里的豆腐撤掉"里的"豆腐"就在某一餐里）。
     * 找不到再退回"说了的那一餐"，最后退回"第一顿有菜的"。
     */
    const pickMeal = () => {
      if (saidSlot) {
        const wanted = allMeals.find((row) => row.mealKey === `${saidDate}-${saidSlot}`)
        if (wanted) return wanted
      }
      if (namedDish) {
        const withDish = allMeals.find((row) => row.dishes.some((dish) => dish.name.includes(namedDish)))
        if (withDish) return withDish
      }
      return allMeals.find((row) => row.dishes.length > 0) ?? null
    }
    const saidMeal = pickMeal()
    /** 撤菜要点的那个 itemId：优先取用户点名的那道，没点名就取那一餐的第一道 */
    const menuItemId = saidMeal
      ? (saidMeal.dishes.find((dish) => !namedDish || dish.name.includes(namedDish)) ?? saidMeal.dishes[0])?.itemId ?? ''
      : ''
    /** 加菜/改人数时目标那一餐的 key：说了餐次就用说的，否则用挑出来的那一餐 */
    const targetMealKey = saidSlot ? `${saidDate}-${saidSlot}` : (saidMeal?.mealKey ?? `${saidDate}-DINNER`)
    /*
     * stub 自己的"搜索结果"：`add_menu_items` 要的是真实菜谱 id，而 stub 造不出库里的 id——
     * 所以加菜这一路先 `search_dishes`（真去库里搜，拿到真 id）再调 `add_menu_items`。
     * 这条恰好也压住"不许自己编 id"的规矩。
     */
    const menuSearch = (() => {
      const hit = toolResults.find((m) => /dishes/.test(String(m.content)))
      const raw = String(hit?.content ?? '')
      try { return String(JSON.parse(raw).dishes?.[0]?.recipeId ?? '') } catch { return '' }
    })()
    const menuMode = mentionsMenu && menuToolsReady
    /*
     * 加菜的收尾话**要照工具结果说**：写失败时（如"这一餐已经安排了"）必须如实转述那句原因，
     * 不能一律说"加进去了"——那正是产品要求模型做到的事（只说你真做成的那些），
     * stub 演反了的话，验收里就变成"AI 在骗用户"。这里从工具结果里捞出那句人话。
     */
    const menuFailLine = (() => {
      const hit = toolResults.find((m) => /没加成/.test(String(m.content)))
      if (!hit) return ''
      try { return String(JSON.parse(String(hit.content)).result ?? '') } catch { return '' }
    })()
    const menuPlan = !menuMode ? null
      // 要撤菜：先读菜单（id 只能从那里拿）
      : menuWantsRemove ? (!menuRead ? { calls: [{ id: 'call_menu_0', name: 'read_menu', args: {} }] }
        : !menuWrote ? { calls: [{ id: 'call_menu_1', name: 'remove_menu_item', args: { itemId: menuItemId } }] }
          : { text: '已经从这餐里撤掉了，回执上可以放回去。' })
        // 改人数 / 改状态：同样先读
        : (menuWantsDiners || menuStatus) ? (!menuRead || !saidMeal ? { calls: [{ id: 'call_menu_2', name: 'read_menu', args: {} }] }
          : !menuWrote ? {
              calls: [menuWantsDiners
                ? { id: 'call_menu_3', name: 'set_diners', args: { mealKey: targetMealKey, count: dinerCount } }
                : { id: 'call_menu_4', name: 'set_meal_status', args: { mealKey: targetMealKey, status: menuStatus } }],
            }
            : { text: menuWantsDiners ? '改好了，回执上能改回去。' : '改好了，这一步是往前走的，要改回来得去点单页重新安排。' })
          // 加菜：先搜菜（拿真 id）再读菜单，最后加
          : (!menuSearch ? { calls: [{ id: 'call_menu_5', name: 'search_dishes', args: { query: saidDish } }] }
            : !menuRead ? { calls: [{ id: 'call_menu_6', name: 'read_menu', args: {} }] }
              : !menuWrote ? { calls: [{ id: 'call_menu_7', name: 'add_menu_items', args: {
                  mealDate: saidDate,
                  // 没点名餐次时用"挑出来的那一餐"（多半是用户刚在说的事），最后才落晚餐
                  meal: saidSlot || (targetMealKey.endsWith('LUNCH') ? 'LUNCH' : 'DINNER'),
                  items: [{ recipeId: menuSearch, note: '少放盐' }],
                } }] }
                : { text: menuFailLine || '加进去了，回执上一道一个「撤」。' })
    if (menuMode) {
      console.log(`[stub] 菜单分支：撤=${menuWantsRemove} 人数=${menuWantsDiners} 状态=${menuStatus || '-'} `
        + `只吃${saidSlot}@${saidDate} 那一餐读到=${saidMeal ? saidMeal.mealKey : '(空)'} 菜谱 id=${menuSearch || '(空)'} itemId=${menuItemId || '(空)'} `
        + `→ ${menuPlan?.calls?.map((c) => `${c.name}${JSON.stringify(c.args)}`).join(',') ?? '(收尾)'}`)
    }
    if (menuPlan?.calls) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
      const frame = (delta, finish) => `data: ${JSON.stringify({
        id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
      res.write(frame({ role: 'assistant', content: '我看看菜单。' }, null))
      menuPlan.calls.forEach((call, index) => {
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

    // ---------- 自建菜谱（create_recipe / update_recipe / delete_recipe，F1-11/F1-12）----------
    /*
     * 这一支的存在理由很直接：**"撤 AI 新建的菜谱"曾经整条路都是坏的**
     * （`recipeTouched` 拿整份 undoData 去比，`recipeId` 在快照里找不到，
     * 于是每一次撤销都被误判成"用户自己改过"而拒绝）——而当时单测与 HTTP 验收
     * **都没走过这条路**，是浏览器里用真模型验证时才暴露的。补上它，
     * 让"撤销菜谱"这类问题在自动化里就能红。
     *
     * 演法与别处一致：要删/要改先 `read_recipes` 拿真实 id（模型也只能这么干）。
     */
    const recipeToolsReady = closingRound || tools.some((t) => t.function?.name === 'read_recipes')
    const mentionsRecipe = /菜谱/.test(user)
    const recipeMode = mentionsRecipe && recipeToolsReady
    const recipeReadText = (() => {
      const hit = toolResults.find((m) => /（id: |没找到/.test(String(m.content)))
      const raw = String(hit?.content ?? '')
      try { return String(JSON.parse(raw).recipes ?? '') } catch { return '' }
    })()
    const recipeRead = recipeReadText !== ''
    /** 工具结果里的拒绝原话（"改不了""没找到"）——收尾时照实转述，不许说"改好了" */
    const recipeFailLine = (() => {
      const hit = toolResults.find((m) => /改不了|没找到|最多|不能为空|格式不认识/.test(String(m.content)))
      if (!hit) return ''
      try { return String(JSON.parse(String(hit.content)).error ?? JSON.parse(String(hit.content)).result ?? '') } catch { return '' }
    })()
    const recipeWrote = toolResults.some((m) => /已存进|已改：|已删：|没找到|改不了/.test(String(m.content)))
    const recipeId = /（id: ([^）]+)）/.exec(recipeReadText)?.[1] ?? ''
    /*
     * 菜名从用户那句话里取：**"我家的X是这么做的" / "叫X" 两种最常见**（真实模型也是这么理解的）。
     * 取不到才退回一个占位名——第一版只认「」括起来的名字，而自然说法里根本没有引号，
     * 于是它把菜存成了"AI 写的菜"，验收断言找不到「凉拌黄瓜」而红（产品是好的，是 stub 没听懂）。
     */
    const recipeName = /「([^」]{1,40})」/.exec(user)?.[1]
      ?? /我家的([^是，,。\s]{2,12}?)(?:是|的)/.exec(user)?.[1]
      ?? /(?:叫|名字是)([^，,。\s]{2,12})/.exec(user)?.[1]
      ?? 'AI 写的菜'
    const recipeWantsDelete = /删掉|删了/.test(user) && /菜谱/.test(user)
    const recipeWantsUpdate = /改成|改一下/.test(user) && /菜谱/.test(user)
    const recipeCalls = (() => {
      if (!recipeMode) return null
      if (recipeWantsDelete) {
        if (!recipeRead) return [{ id: 'call_recipe_1', name: 'read_recipes', args: { query: recipeName } }]
        if (!recipeWrote) return [{ id: 'call_recipe_2', name: 'delete_recipe', args: { recipeId } }]
        return []
      }
      if (recipeWantsUpdate) {
        if (!recipeRead) return [{ id: 'call_recipe_3', name: 'read_recipes', args: { query: recipeName } }]
        if (!recipeWrote) return [{ id: 'call_recipe_4', name: 'update_recipe', args: { recipeId, steps: ['改过的第一步'] } }]
        return []
      }
      /*
       * 新建：名字与步骤都从用户那句话里取（真实模型也是这么理解的）。
       * 步骤至少一步——`readRecipeDraft` 就是这么卡的，stub 演错的话会撞在工具入口上。
       */
      if (!recipeWrote) {
        return [{ id: 'call_recipe_5', name: 'create_recipe', args: {
          name: recipeName,
          category: '凉菜',
          cuisine: '家常',
          ingredients: [{ name: '黄瓜' }],
          steps: ['黄瓜拍碎，加蒜末和盐拌匀。', '淋醋与香油，撒熟芝麻。'],
        } }]
      }
      return []
    })()
    if (recipeMode) {
      console.log(`[stub] 菜谱分支：名字=${recipeName} 删=${recipeWantsDelete} 改=${recipeWantsUpdate} `
        + `读到 id=${recipeId || '(空)'} → ${recipeCalls?.map((c) => c.name).join(',') ?? '(收尾)'}`)
    }
    if (recipeCalls && recipeCalls.length > 0) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
      const frame = (delta, finish) => `data: ${JSON.stringify({
        id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
      res.write(frame({ role: 'assistant', content: '我看看你家的菜谱。' }, null))
      recipeCalls.forEach((call, index) => {
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

    // ---------- 常用组合（create / 一键加菜）----------
    /*
     * 组合那两件单独一个分支：它们的 id 体系与菜单不同（comboId 来自 `read_combos`），
     * 掺进上面那棵树会把"读菜单"与"读组合"两个前置状态搅在一起。
     */
    const comboMode = /组合/.test(user) && tools.some((t) => t.function?.name === 'read_combos')
    const comboReadText = (() => {
      const hit = toolResults.find((m) => /comboId|还没有存过常用组合/.test(String(m.content)))
      const raw = String(hit?.content ?? '')
      try { return String(JSON.parse(raw).combos ?? '') } catch { return '' }
    })()
    const comboMode_ = comboMode ? (/把这一组加进|用组合加|按组合点/.test(user) ? 'add' : /删掉这个组合|删组合/.test(user) ? 'delete' : /改|重命名/.test(user) ? 'update' : 'create') : ''
    const comboId = /comboId: (\S+?)[）（]/.exec(comboReadText)?.[1] ?? ''
    const comboWrote = toolResults.some((m) => /已存：组合|已改：组合|已删：组合|已把这一组加进去/.test(String(m.content)))
    const comboCalls = (() => {
      if (!comboMode) return null
      if (comboMode_ === 'add') {
        if (!comboId) return [{ id: 'call_combo_1', name: 'read_combos', args: {} }]
        if (!comboWrote) return [{ id: 'call_combo_2', name: 'add_combo_to_meal', args: { comboId, mealDate: todayKeyForStub(), meal: 'DINNER' } }]
        return []
      }
      if (comboMode_ === 'delete') {
        if (!comboId) return [{ id: 'call_combo_3', name: 'read_combos', args: {} }]
        if (!comboWrote) return [{ id: 'call_combo_4', name: 'delete_combo', args: { comboId } }]
        return []
      }
      if (comboMode_ === 'update') {
        if (!comboId) return [{ id: 'call_combo_5', name: 'read_combos', args: {} }]
        if (!comboWrote) return [{ id: 'call_combo_6', name: 'update_combo', args: { comboId, name: '改过名的组合' } }]
        return []
      }
      // 新建：菜 id 得先搜出来（真实模型也一样）
      const ids = comboReadText.match(/\[([^\]]+)\]/g)?.map((piece) => piece.slice(1, -1)).filter(Boolean) ?? []
      if (ids.length === 0) {
        // 还没搜过菜：先搜一道，拿真 id
        if (!menuSearch) return [{ id: 'call_combo_7', name: 'search_dishes', args: { query: '豆腐' } }]
        return [{ id: 'call_combo_8', name: 'create_combo', args: { name: comboNameForStub(user), note: '工作日晚上', recipeIds: [menuSearch] } }]
      }
      return []
    })()
    if (comboMode && comboCalls) {
      if (comboCalls.length === 0) {
        // 收尾：落到下面的普通流式分支，用一句收尾话
        console.log(`[stub] 组合分支收尾：mode=${comboMode_} comboId=${comboId || '-'}`)
      } else {
        console.log(`[stub] 组合分支：mode=${comboMode_} comboId=${comboId || '-'} → ${comboCalls.map((c) => c.name).join(',')}`)
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
        const frame = (delta, finish) => `data: ${JSON.stringify({
          id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
          model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
        res.write(frame({ role: 'assistant', content: '我看下常用组合。' }, null))
        comboCalls.forEach((call, index) => {
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
    }

    // ---------- 再点一次（照抄某一餐到另一天）----------
    /*
     * 前置条件是"来源那一餐已经定局"（做好了/已取消/日子已过）——产品里 `canRepeatFrom` 判这个。
     * 所以这条路只演"读菜单 → 照抄"，来源餐次用用户那句话里的日期（今天/昨天）。
     */
    const repeatMode = /照抄|再点一次|复制到|照着点/.test(user)
      && (closingRound || tools.some((t) => t.function?.name === 'repeat_meal'))
    if (repeatMode) {
      const repeatSource = parseMenuForStub(menuText).find((row) => row.dishes.length > 0)
      const sourceDate = /昨天/.test(user)
        ? `${menuDateForStub('昨天')}-LUNCH`
        : `${menuDateForStub(user)}-LUNCH`
      const target = /明天/.test(user) ? menuDateForStub('明天') : menuDateForStub('今天')
      const source = parseMenuForStub(menuText).find((row) => row.mealKey === sourceDate) ?? repeatSource
      /*
       * 目标餐次要取**句子后半段**那个餐次词（"照抄今天午餐，明天晚餐再点一次"里要的是晚餐）。
       * 按第一个匹配就会把来源那半句的"午餐"当成目标——第一版就是这么错的，
       * 于是照抄到了明天午餐，而验收在查明天晚餐（看着像产品没写进去）。
       */
      const targetSlot = (() => {
        const tail = user.split(/[，,。；;]/).slice(-1)[0] ?? user
        const hit = /(午餐|午饭|中饭|晚餐|晚饭)/.exec(tail) ?? /(午餐|午饭|中饭|晚餐|晚饭)/.exec(user)
        return hit && /午餐|午饭|中饭/.test(hit[1]) ? 'LUNCH' : 'DINNER'
      })()
      const repeatWrote = toolResults.some((m) => /已照|都有了|没找到/.test(String(m.content)))
      const calls = !menuRead ? [{ id: 'call_repeat_1', name: 'read_menu', args: {} }]
        : !repeatWrote ? [{ id: 'call_repeat_2', name: 'repeat_meal', args: {
            mealKey: source?.mealKey ?? sourceDate,
            mealDate: target,
            meal: targetSlot,
          } }]
          : []
      if (calls.length > 0) {
        console.log(`[stub] 再点一次：来源=${source?.mealKey ?? '(没读到)'} → 目标=${target} ${targetSlot}`)
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
        const frame = (delta, finish) => `data: ${JSON.stringify({
          id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
          model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
        res.write(frame({ role: 'assistant', content: '我看看那一餐点了什么。' }, null))
        calls.forEach((call, index) => {
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
      console.log(`[stub] 再点一次收尾：来源=${source?.mealKey ?? '(没读到)'}`)
    }

    // ---------- 口味与忌口（M8，F8-01/F8-02）----------
    /*
     * 两件：`read_taste`（读全家档案）与 `update_taste`（写**自己**那份）。
     *
     * 提示词里要求"要推荐菜、要往菜单里加菜之前先 read_taste"（有人过敏还推荐那道菜
     * 是不可接受的），所以这一支也演**先读后写**：先问全家档案，再照用户那句话写。
     *
     * 两处刻意与真实模型一致：
     * ① **只写用户说的那几项**。`allergies` 会真的影响推荐过滤，添油加醋补一个进去是危险的
     *    （验收有一条断言盯这个：说了"不吃辣"就不许冒出过敏原）；
     * ② **不替别人写**。schema 里压根没有"给谁写"这个参数（服务端永远只写调用者本人），
     *    而提示词要求模型照实说"只能记你自己的"——所以 stub 遇到"我妈…"就**不下手**，
     *    演的就是那句该说的话。不这么演的话，验收里会出现"AI 把'我妈对虾过敏'记进了
     *    提问者自己的档案"这种结果，而那是模型的判断问题、不是产品的行为。
     */
    const tasteMode = /忌口|过敏|不吃|吃不了|口味|少放盐|辣/.test(user)
      && tools.some((t) => t.function?.name === 'update_taste')
    if (tasteMode) {
      const tasteRead = toolResults.some((m) => /"profiles"/.test(String(m.content)))
      const tasteWrote = toolResults.some((m) => /已记下/.test(String(m.content)))
      /**
       * 说的是**别人**的忌口（"我妈对虾过敏，帮她记一下"）：这一轮只读、不写。
       *
       * 判据只看"有没有点名别人"，**不看句子以什么开头**——第一版加了 `!/^(我|自己)/`
       * 这道闸，于是"我妈…"（也以"我"开头）被放行、真把虾写进了提问者自己的档案。
       */
      const aboutSomeoneElse = /(我妈|我爸|我老婆|我老公|我媳妇|我儿子|我女儿|我孩子|我爷爷|我奶奶|我婆婆|我丈母娘)/.test(user)
        || /(替|帮)(他|她|他们|别人)[^，。]{0,4}(记|写)/.test(user)
      const spicyWord = /不吃辣|不能吃辣|忌辣/.test(user) ? 0
        : /微辣/.test(user) ? 1
          : /中辣/.test(user) ? 2
            : /重辣|很能吃辣/.test(user) ? 3 : null
      /** 过敏原：只认"对 X 过敏"这种写法，**不许自己补**（写进去会真的过滤推荐） */
      const allergyHit = /对([\u4e00-\u9fa5]{1,6})过敏/.exec(user)?.[1] ?? ''
      /** 不爱吃：排除"辣"（那一项属于辣度，写两遍会让用户看到两条重复的忌口） */
      const dislikeHit = (() => {
        const hit = /不[爱吃]([\u4e00-\u9fa5]{1,6})/.exec(user)?.[1] ?? ''
        return hit === '辣' ? '' : hit
      })()
      const tastePatch = {
        ...(spicyWord !== null ? { spicyLevel: spicyWord } : {}),
        ...(allergyHit ? { allergies: [allergyHit] } : {}),
        ...(dislikeHit && dislikeHit !== allergyHit ? { dislikes: [dislikeHit] } : {}),
      }
      const wantsWrite = !aboutSomeoneElse && Object.keys(tastePatch).length > 0
      const tasteCalls = !tasteRead
        ? [{ id: 'call_taste_1', name: 'read_taste', args: {} }]
        : tasteWrote || !wantsWrite
          ? []
          : [{ id: 'call_taste_2', name: 'update_taste', args: tastePatch }]

      if (tasteCalls.length > 0) {
        console.log(`[stub] 口味忌口：${tasteCalls.map((call) => call.name).join(',')} 补丁=${JSON.stringify(tastePatch)}`)
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
        const frame = (delta, finish) => `data: ${JSON.stringify({
          id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
          model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
        res.write(frame({ role: 'assistant', content: '我先看下家里的口味档案。' }, null))
        tasteCalls.forEach((call, index) => {
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

      /*
       * 收尾：按**服务端真的回了什么**说一句。
       *
       * 读结果里有 `missing`（还没写档案的人），那是要转述给用户的——
       * "谁还没写"本身就是有用的一条信息。写结果里有 `已记下：…`，
       * 那说明档案真的动了，可以说"记好了"。
       */
      const seen = toolResults.map((m) => String(m.content)).join('\n')
      const readPayload = (() => {
        const raw = toolResults.map((m) => String(m.content)).find((text) => /"profiles"/.test(text))
        try { return JSON.parse(raw ?? '{}') } catch { return {} }
      })()
      const tasteFinal = aboutSomeoneElse
        ? '口味档案只能记你自己的——你自己的那份我可以马上写；家里别人得他自己在「我的 → 口味与忌口」里写，那样才算他本人的意思。'
        : /已记下/.test(seen) ? '记好了，回执卡上有「改回去」，点错了能还原。你也可以在「我的 → 口味与忌口」里改得更细。'
          : Array.isArray(readPayload.missing) && readPayload.missing.length
            ? `我看了家里的档案：${readPayload.missing.join('、')}还没写。你自己要写的我随时能记——比如"我不吃辣""我对花生过敏"。`
            : '家里的口味档案我看过了，该记的都已经记着。'
      console.log(`[stub] 口味忌口收尾：${tasteFinal.slice(0, 20)}…`)
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
      const textFrame = (chunk, finish) => `data: ${JSON.stringify({
        id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: parsed.model, choices: [{ index: 0, delta: chunk, finish_reason: finish }],
      })}\n\n`
      res.write(textFrame({ role: 'assistant', content: tasteFinal }, null))
      res.write(textFrame({}, 'stop'))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    // ---------- 「做这道菜要买什么」（preview_meal_shopping，用户 2026-10-14 报的第二件事）----------
    /*
     * 这一支必须排在采购清单那一段**前面**：用户的原话是
     * 「我让 ai 加入鱼香肉丝的配料到采购清单，他不加入，要让我加到订单中就自动出现了」——
     * 这句话里既有"采购清单"也有"要买"，会被下面那段抢走，然后演成"往清单上写东西"。
     *
     * 真实模型该走的也是这条路：**不写库**，先 read_menu 拿 mealKey，再 preview_meal_shopping
     * 把这一餐要买的几样列出来，然后说清"定了这一餐它就进清单"。
     */
    const previewMode = /要买什么|缺什么|买些什么|需要买|要买哪|得买|买点啥|缺些/.test(user)
      && tools.some((t) => t.function?.name === 'preview_meal_shopping')
      && !/收进冰箱|补货|勾掉|买到了|加进采购|加到采购/.test(user)
    if (previewMode) {
      const menuTextForPreview = String(
        toolResults.find((m) => /mealKey/.test(String(m.content)))?.content ?? '',
      )
      const previewResult = toolResults
        .map((m) => String(m.content))
        .find((text) => /要买 \d+ 样|家里已有|冰箱里还什么都没记/.test(text)) ?? ''
      /*
       * 轮次一：还没有菜单 → 先 `read_menu` 拿 mealKey。
       * 轮次二：拿到 mealKey → 调 `preview_meal_shopping`。
       * 轮次三：两条都齐了 → 收尾（不再调工具）。
       *
       * 为什么非要先读菜单：`preview_meal_shopping` 要的是 `mealKey`（如 `2026-10-14-DINNER`），
       * 而 stub 造不出真实日期——只能从 `read_menu` 的返回里解出来，与"撤菜要先拿 itemId"同一个道理。
       */
      const meals = parseMenuForStub(menuTextForPreview)
      const previewMeal = meals.find((row) => row.dishes.length > 0) ?? meals[0] ?? null
      const previewCalls = previewResult
        ? []
        : !menuTextForPreview
          ? [{ id: 'call_preview_1', name: 'read_menu', args: {} }]
          : previewMeal
            ? [{ id: 'call_preview_2', name: 'preview_meal_shopping', args: { mealKey: previewMeal.mealKey } }]
            : []
      if (previewCalls.length === 0) {
        const previewFinal = previewResult
          ? `${previewResult.split('\n')[0]}。定了这一餐，这些就会进采购清单（现在还没写进去）。`
          : '这几天的菜单上还没有菜，先点一道想吃的，我就能算出要买什么。'
        console.log(`[stub] 餐次采购预览收尾：${previewFinal.slice(0, 24)}…`)
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
        const textFrame = (chunk, finish) => `data: ${JSON.stringify({
          id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
          model: parsed.model, choices: [{ index: 0, delta: chunk, finish_reason: finish }],
        })}\n\n`
        res.write(textFrame({ role: 'assistant', content: previewFinal }, null))
        res.write(textFrame({}, 'stop'))
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      console.log(`[stub] 餐次采购预览：${previewCalls.map((call) => call.name).join(',')}`)
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
      const frame = (delta, finish) => `data: ${JSON.stringify({
        id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
      for (const call of previewCalls) {
        res.write(frame({ tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, null))
      }
      res.write(frame({}, 'tool_calls'))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    // ---------- 采购清单（M7，用户 2026-10-14 要求接入）----------
    /*
     * 五种：读清单 / 加自加条目 / 勾选 / 删自加条目 / 一键补货。
     *
     * 与冰箱那条同一个讲究——**先读再动**（勾选与补货都要清单上真实存在的名字），
     * 所以 stub 演两轮：先 `read_shopping_list` 拿下名字，再动手。
     * 「把某道菜需要的食材加进采购单」这句在真实模型那里该走**菜单**那条路
     * （加菜进菜单，清单自己按配料算出来），所以 stub 不拦那种说法。
     */
    const shoppingMode = /采购|清单|买到|买回来|要买|收进冰箱/.test(user)
      && tools.some((t) => t.function?.name === 'read_shopping_list')
    if (shoppingMode) {
      /*
       * 取**最近一次**读清单的结果，不是第一次。
       *
       * 这条区别是必需的：补货那条路是"先勾上、再收进冰箱"，中间那次勾选之后
       * 清单已经变了——照第一次那份读结果算，会得出"一样都没勾"然后原地打转，
       * 三轮轮次烧光、验收看到的是"AI 什么都没办"（第一版就是这个形状）。
       */
      const shopReads = toolResults.filter((m) => {
        try { return 'list' in JSON.parse(String(m.content)) } catch { return false }
      })
      const shopReadText = (() => {
        const raw = String(shopReads[shopReads.length - 1]?.content ?? '')
        try { return String(JSON.parse(raw).list ?? '') } catch { return '' }
      })()
      // 清单上的名字（形状由产品侧 `shoppingText()` 定：`  - 名字（要 X）[标签]`）
      const shopNames = [...shopReadText.matchAll(/^\s*- (.+?)(?:（|\[|$)/gm)].map((hit) => hit[1].trim())
      const shopRead = shopReadText !== ''
      /*
       * 「读不出来」也要认（没有家庭的人读清单是 404，工具结果里是 `{"error":"先加入家庭…"}`）。
       * 不认它的话 stub 会一轮轮地重读，把三轮轮次烧光——而真实模型这时该做的是
       * **停下来照实说**，不是接着乱试。
       */
      const shopReadFailed = toolResults.some((m) => /加入家庭/.test(String(m.content)))
      /*
       * 服务端**已经回过话**的那几类（写成了、被拒了、没找到）。分别认，
       * 因为收尾那句要按"真的发生了什么"来说：`没加成` 也在这里面——
       * 同名重复会被服务端拒（「清单上已经有『垃圾袋』了」），真实模型这时该**如实转述**，
       * 而不是再试一遍（那会白白烧掉一轮，用户等得更久）。
       */
      const shopRestocked = toolResults.some((m) => /已收进冰箱|跳过了|还没勾/.test(String(m.content)))
      const shopChecked = toolResults.some((m) => /已更新：/.test(String(m.content)))
      const shopAdded = toolResults.some((m) => /已加进采购清单|没加成|清单上没有/.test(String(m.content)))
      const shopRemoved = toolResults.some((m) => /已去掉：/.test(String(m.content)))
      /*
       * 「删不掉」也要认：菜单推出来的那几条没有自加记录，服务端会回
       * 「清单上没有「X」这条自加的条目（菜单推出来的那些删不掉，勾掉就行）」。
       * 不认它就会一轮轮地重删（把轮次烧光），而真实模型这时该**照实转述**那条理由。
       */
      const shopRemoveRefused = toolResults.some((m) => /删不掉|这条自加的条目/.test(String(m.content)))
      const wantsRestock = /收进冰箱|补货|放进冰箱|记进冰箱/.test(user)
      const wantsUncheck = /取消勾|不用买|不买了/.test(user)
      const wantsRemove = !wantsUncheck && /从清单上?去掉|划掉|删掉这条/.test(user)
      const wantsCheck = /买到了|都买了|买好了|勾掉|勾上/.test(user)
      /** 清单里标着 `已勾=买到了` 的那几样（补货只能补这些，与产品侧口径一致） */
      const shopMarked = [...shopReadText.matchAll(/^\s*- (.+?)(?:（|\[)[^\n]*已勾=买到了/gm)].map((hit) => hit[1].trim())
      /*
       * 只是问"有什么"——**一个字的库都不写**。
       *
       * 这一支必须有：默认那支是"往清单上加"，只问一句"清单上有什么要买的"会被演成
       * "顺手加了两样"（第一版就是这样），于是"读清单不写库"这条断言看着红、其实是 stub 演错。
       */
      const wantsReadOnly = /我看|看看|有什么|还剩|多少样/.test(user)
        && !wantsCheck && !wantsRestock && !wantsRemove && !wantsUncheck
      /** 用户这句话里点到的、又确实在清单上的名字（真实模型也是照着用户说的取） */
      const shopNamed = shopNames.filter((name) => user.includes(name))
      const pick = (limit) => (shopNamed.length ? shopNamed : shopNames).slice(0, limit)

      const shopCalls = !shopRead
        // 读失败（没有家庭）就**不再重读**：真实模型这时要停下来照实说
        ? (shopReadFailed ? [] : [{ id: 'call_shop_1', name: 'read_shopping_list', args: {} }])
        // 只是问"有什么"：读完就收尾，不写库
        : wantsReadOnly ? []
        : (() => {
          if (wantsRestock) {
            if (shopRestocked) return []
            if (shopMarked.length > 0) {
              return [{ id: 'call_shop_3', name: 'restock_shopping_items', args: { names: shopMarked.slice(0, 3) } }]
            }
            /*
             * 一样都没勾：**同一轮发两个调用**（先勾上、再收进冰箱）。
             * 服务端是按数组顺序一条条执行的（见 ai.service 的工具循环），
             * 所以第二个调用能看见第一个刚写下的勾——这也正是真实模型的做法
             * （"先勾上再收"是一件事，分两轮只是浪费一轮）。
             */
            const first = shopNames[0]
            if (!first) return []
            return [
              { id: 'call_shop_2', name: 'check_shopping_item', args: { names: [first], checked: true } },
              { id: 'call_shop_3', name: 'restock_shopping_items', args: { names: [first] } },
            ]
          }
          if (wantsRemove) {
            const target = pick(1)[0]
            if (!target) return []
            return (shopRemoved || shopRemoveRefused) ? [] : [{ id: 'call_shop_4', name: 'remove_shopping_item', args: { name: target } }]
          }
          if (wantsUncheck) {
            const target = pick(1)[0]
            if (!target) return []
            return shopChecked ? [] : [{ id: 'call_shop_5', name: 'check_shopping_item', args: { names: [target], checked: false } }]
          }
          if (wantsCheck) {
            const targets = pick(2)
            if (targets.length === 0) return []
            return shopChecked ? [] : [{ id: 'call_shop_6', name: 'check_shopping_item', args: { names: targets, checked: true } }]
          }
          /*
           * 默认：往清单上加几样。要加的东西从用户那句话里取，取不到给一个固定的。
           *
           * **用户点名的名字优先**（哪怕它已经在清单上）：真实模型会照说照加、
           * 由服务端回一句「清单上已经有『垃圾袋』了」——这条"同名要被拒"的路
           * 只有这么演才走得到（否则 stub 永远加一个全新的名字，那条判据一次也没被验过）。
           */
          const namedFoods = KNOWN_FOODS.filter((food) => user.includes(food))
          const errand = /垃圾袋|洗洁精|纸巾|保鲜膜|牙膏/.exec(user)?.[0]
          const said = (shopNamed.length ? shopNamed : namedFoods.length ? namedFoods : errand ? [errand] : []).slice(0, 3)
          const items = (said.length ? said : ['垃圾袋']).map((name) => ({ name, amount: name === '垃圾袋' ? '两卷' : undefined }))
          return shopAdded ? [] : [{ id: 'call_shop_7', name: 'add_shopping_items', args: { items } }]
        })()

      /*
       * 收尾那一轮（这一轮不再调工具了）：按**服务端真的做了什么**说一句。
       *
       * 为什么必须演这一段：验收里要断言"AI 有没有照实说"——比如加一样清单上已有的，
       * 服务端回的是「没加成」，模型就不能说"加好了"。兜底文案（"今晚可以煮个青菜豆腐汤"）
       * 是给普通问答用的，落在这一支上会让"它答非所问"看着像产品坏了。
       */
      if (shopCalls.length === 0) {
        const seen = toolResults.map((m) => String(m.content)).join('\n')
        const shopFinal = shopReadFailed ? '你还没加入家庭，先建一个家庭（或让家里人邀请你），采购清单才有得算。'
          : /没加成/.test(seen) ? '这几样清单上已经有了，不用再加——要的话直接勾一下就行。'
            : /删不掉|这条自加的条目/.test(seen) ? '这一条是菜单推出来的，删不掉——在清单上勾掉它就行。'
              : /已收进冰箱|跳过了/.test(seen) ? '买到的那几样收进冰箱了，回执卡上每条都能撤。'
                : /已去掉：/.test(seen) ? '从清单上去掉了，要恢复的话说一声。'
                  : /已更新：/.test(seen) ? '清单上勾好了，买到几样就勾几样。'
                    : /已加进采购清单/.test(seen) ? '加进采购清单了，回执卡上有「撤」。'
                      : shopRead ? `采购清单我看过了，上面有 ${shopNames.length} 条。`
                        : '采购清单这块我这边办不了，过会儿再试。'
        console.log(`[stub] 采购清单收尾：${shopNames.length} 样 → ${shopFinal.slice(0, 20)}…`)
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
        const textFrame = (chunk, finish) => `data: ${JSON.stringify({
          id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
          model: parsed.model, choices: [{ index: 0, delta: chunk, finish_reason: finish }],
        })}\n\n`
        res.write(textFrame({ role: 'assistant', content: shopFinal }, null))
        res.write(textFrame({}, 'stop'))
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      console.log(`[stub] 采购清单：${shopCalls.map((call) => call.name).join(',')}（清单上 ${shopNames.length} 样）`)
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
      const frame = (delta, finish) => `data: ${JSON.stringify({
        id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
      res.write(frame({ role: 'assistant', content: '我看下采购清单。' }, null))
      shopCalls.forEach((call, index) => {
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

    // ---------- 只读三件：帮我决定 / 家人最爱 / 打卡（用户 2026-10-14）----------
    /*
     * 三件都是**一次调用就完事**的只读出口（不像冰箱/清单那样先读后写），
     * 所以这一支的演法很直：认出用户问的是哪一件，发那个工具调用，然后把服务端
     * 回的那句 `reason`/数字转述出去。
     *
     * 为什么值得演：这三事事前在对话里**完全办不了**（工具表里没有），
     * 而它们的答案只有服务端算得对——「该做哪道菜」要看冰箱临期、口味过滤与家里做过几回，
     * 「连续打卡多少天」要跑热力图那段。stub 不许自己编这些数字，
     * 只能**照抄工具结果**，这与真实模型该做的事完全一样。
     */
    /*
     * **必须确认这些工具真的在这一轮的表里**（与冰箱/清单那几支同一条护栏）。
     *
     * 少了这道闸会撞上一个很隐蔽的串台：`/ai/suggest` 那条路**不带工具**，而它的
     * `hint` 是当 user 消息发的——"随便来点家常菜"正好命中下面的关键词，
     * 于是 stub 回了一个 `what_to_cook` 工具调用，而那条路根本不认工具，
     * 结果 `/ai/suggest` 全部 502（"AI 的回答不是有效的推荐结果"）。
     * 验收里表现成"反复问同一句话拿到 0 条推荐"，看着像推荐功能坏了。
     */
    const readOnlyToolsReady = tools.some((t) => t.function?.name === 'read_family_picks')
    const readOnlyMode = readOnlyToolsReady && (
      /不知道吃|吃什么好|帮我决定|随便来|来个主意|换一道/.test(user)
      || /最爱|常做|爱吃的|做过几|收藏/.test(user)
      || /打卡|连续|做了几次|下厨/.test(user)
    )
    if (readOnlyMode) {
      /*
       * 「这一件问过了」= 收到了一个**形状对的回包**（含 error 的那种也算：没有家庭时三条
       * 都回一句"先加入家庭"，那也是问到底了）。
       *
       * 只看"有没有成功回包"会漏掉失败那一种，于是 stub 一轮轮地重问、把三轮轮次烧光
       * ——验收里看到的是四句一模一样的"我看看家里现在什么情况"，像卡住了。
       */
      const answered = (keys) => toolResults.some((m) => {
        try {
          const payload = JSON.parse(String(m.content))
          return payload && typeof payload === 'object' && ('error' in payload || keys.some((key) => key in payload))
        } catch { return false }
      })
      const decideDone = answered(['canSwap'])
      const picksDone = answered(['picks'])
      const checkinDone = answered(['entries'])
      const wantsDecide = /不知道吃|吃什么好|帮我决定|随便来|来个主意|换一道/.test(user)
      const wantsPicks = !wantsDecide && /最爱|常做|爱吃的|做过几|收藏/.test(user)
      const wantsCheckin = !wantsDecide && !wantsPicks && /打卡|连续|做了几次|下厨/.test(user)
      const pickCalls = (wantsDecide && !decideDone)
        ? [{ id: 'call_ro_1', name: 'what_to_cook', args: {} }]
        : (wantsPicks && !picksDone)
          ? [{ id: 'call_ro_2', name: 'read_family_picks', args: { limit: 8 } }]
          : (wantsCheckin && !checkinDone)
            ? [{ id: 'call_ro_3', name: 'read_checkins', args: { limit: 8, stats: true } }]
            : []

      if (pickCalls.length > 0) {
        console.log(`[stub] 只读三件：${pickCalls.map((call) => call.name).join(',')}`)
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
        const frame = (delta, finish) => `data: ${JSON.stringify({
          id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
          model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
        res.write(frame({ role: 'assistant', content: '我看看家里现在什么情况。' }, null))
        pickCalls.forEach((call, index) => {
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

      /*
       * 收尾：**照抄服务端给的数字与理由**（一个都不许自己编）。
       *
       * 这就是这几条工具存在的全部意义——"该做哪道菜"的答案里含冰箱临期、口味过滤、
       * 家里做过几回三条判据，模型凭印象答必然与界面对不上。
       *
       * **失败那条也要照抄**：没有家庭时三个工具都回一句"先加入家庭…"，
       * 那是**有用的信息**（用户知道下一步该干什么），不该被换成"你家还没做过菜"。
       */
      const payloads = toolResults.map((m) => {
        try { return JSON.parse(String(m.content)) } catch { return {} }
      }).filter((payload) => payload && typeof payload === 'object')
      const payloadWith = (keys) => payloads.find((payload) => keys.every((key) => key in payload)) ?? {}
      const decidePayload = payloadWith(['canSwap'])
      const picksPayload = payloadWith(['picks'])
      const checkinPayload = payloadWith(['entries'])
      const failure = payloads.find((payload) => payload.error)?.error
      const readOnlyFinal = failure
        ? `${failure}——这一步得先办。`
        : wantsDecide
          ? decidePayload.recipe
            ? `就做「${decidePayload.recipe.name}」吧。${decidePayload.reason ?? ''}`
            : `这会儿我给不出主意：${decidePayload.reason ?? '说不清'}。`
          : wantsPicks
            ? picksPayload.picks?.length
              ? `你家最爱的是：${picksPayload.picks.map((pick) => `${pick.name}（做过 ${pick.cooked} 次、${pick.favorites} 人收藏）`).join('，')}。`
              : `你家还没做过或收藏过菜，去发现页点几道、或者点上几顿饭就有了。`
            : checkinPayload.entries
              ? `你连着打了 ${checkinPayload.stats?.myStreak ?? 0} 天卡，全家一共 ${checkinPayload.stats?.familyTotal ?? 0} 张。最近这几条：${(checkinPayload.entries ?? []).slice(0, 3).map((entry) => `${entry.nickname}${entry.mealLabel ? `（${entry.mealLabel}）` : ''}`).join('、') || '还没有' }。`
              : `打卡记录我这边没读到，过会儿再试。`
      console.log(`[stub] 只读三件收尾：${readOnlyFinal.slice(0, 24)}…`)
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
      const textFrame = (chunk, finish) => `data: ${JSON.stringify({
        id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: parsed.model, choices: [{ index: 0, delta: chunk, finish_reason: finish }],
      })}\n\n`
      res.write(textFrame({ role: 'assistant', content: readOnlyFinal }, null))
      res.write(textFrame({}, 'stop'))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    // ---------- 工具循环（D-026 第三次补充）----------
    // 服务端把工具声明发过来时，脚本按"真实模型会怎么走"来演。判据看 role=tool 的消息数：
    //   第 1 轮：没有任何工具结果 → 回 tool_calls（先搜菜，**两个并行调用**，与实测的真网关一致）
    //   第 2 轮：已有工具结果 → 回 tool_calls（提议加菜），参数里**带一条编造的 id**
    //   第 3 轮：再回喂一次 → 回正文收尾
    // 编造的 id 是故意的：服务端必须把它丢掉、只留真实那道（这条正是本次要验的核心）。
    /*
     * `!menuMode && !comboMode`：**菜单/组合那两路已经把 `search_dishes` 借去拿菜谱 id 了**
     * （真实模型也会这么干），若这里不管一句就接管，它们会被这条"搜→提建议"的流程劫持——
     * 症状是"让它加菜，它回一句'要我把这两道加进晚餐吗'"（提议而不是真加），
     * 而产品本身是好的。判据要以"用户那句话在说哪件事"为准。
     */
    const toolMode = !fridgeMode && !menuMode && !comboMode && !recipeMode && tools.some((t) => t.function?.name === 'search_dishes')
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
    // ⚠️ 冰箱那条的收尾话也要在这儿兜住：漏掉它的话走的是通用兜底文案
    // （第一版就漏了，症状是"工具都跑了、正文却在答非所问"，验收里看着像产品坏了）
    const finalContent = toolPlan?.text ?? fridgePlan?.text ?? menuPlan?.text
      ?? comboTextForStub(comboMode, comboMode_)
      ?? recipeTextForStub(recipeMode, recipeWantsDelete, recipeWantsUpdate, recipeFailLine) ?? content
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
