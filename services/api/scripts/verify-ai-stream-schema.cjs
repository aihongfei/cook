#!/usr/bin/env node
/**
 * 流式 + 结构化输出这条路的验收（F16-02，2026-10-15）。
 *
 * 为什么要有这个脚本：`chatStreamEvents` 补上 `jsonSchema` 形参之后，**没有任何页面会用它**
 * ——它是 F16-06/07/08（拍照识别菜品 / 营养分析 / 拍照生成菜谱）的地基。地基没有用户可见
 * 入口，也就没有别的办法证到它：不能靠"点一下看看"，只能直接驱动客户端。
 *
 * 验三件事：
 * ① **schema 真的发出去了**（从 stub 那一侧看请求体，而不是看我们自己的代码——发错 schema
 *    出过一次真事故，见 D-041/R-034 与 stub 里 `schemaName` 那段注释）；
 * ② **正文增量照常流出来**（结构化不该把流式变成"憋到最后才给"）；
 * ③ **网关拒掉 `response_format` 时摘掉它重试一次**（`STUB_REJECT_SCHEMA_ONCE=1` 模拟真网关
 *    那个偶发 400）——这一条是补这个形参时**必须**想清楚的地方：流式已经吐出去的字收不回来，
 *    所以重试窗口只在"第一个事件之前"。
 *
 * 用法：先编译（`npx tsc -p tsconfig.test.json`，`pnpm test` 也会做），再：
 *   node scripts/verify-ai-stream-schema.cjs
 * 脚本自己起 stub、自己收尾，不需要先手动起服务，也不碰数据库。
 */
const { spawn } = require('node:child_process')
const path = require('node:path')

const PORT = Number(process.env.STUB_PORT ?? 18992)
const CLIENT = path.join(__dirname, '..', '.test-build', 'src', 'modules', 'ai', 'ai.client.js')

let failed = 0
const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failed += 1
}

/*
 * 传的是**整个 `response_format` 对象**，不是里面那层 schema——与 `PICKS_SCHEMA` /
 * `PROMPTS_SCHEMA` 同一个形状约定（`{type:'json_schema', json_schema:{name, strict, schema}}`）。
 * 第一版脚本只给了内层，于是 `response_format.json_schema.name` 不存在，stub 那侧看到
 * `schemaName=null`——而"正文照样流出来了"仍然是绿的。**这正是假绿**：接口层没验到，
 * 却看起来通过了大半。形状约定必须照抄产品里已有的那两份，不能自己发明一份。
 */
const SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'stream_dish_analysis',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        dish: { type: 'string' },
        calories: { type: 'number' },
        advice: { type: 'string' },
      },
      required: ['dish', 'calories', 'advice'],
      additionalProperties: false,
    },
  },
}

/** 起 stub（带 schema 拒绝开关），返回句柄 */ 
function startStub(env) {
  const child = spawn(process.execPath, [path.join(__dirname, 'ai-stub-upstream.cjs'), String(PORT)], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stub 30 秒没起来')), 30_000)
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('已就绪')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`stub 提前退出，code=${code}`))
    })
  })
  return { child, ready }
}

async function received() {
  const response = await fetch(`http://127.0.0.1:${PORT}/__received`)
  return response.json()
}

async function runStream(client, config, { systemPrompt, prompt, jsonSchema }) {
  const chunks = []
  const calls = []
  for await (const event of client.chatStreamEvents(config, {
    systemPrompt,
    messages: [{ role: 'user', content: prompt }],
    // 这是被测的那一格：不传它就等于在验旧行为（第一版脚本就是这么错的，
    // schema 根本没上电线，而"正文出来了"照样绿——假绿正是这类脚本最该防的）
    ...(jsonSchema ? { jsonSchema } : {}),
    temperature: 0.2,
  })) {
    if (event.type === 'text') chunks.push(event.text)
    else if (event.type === 'tool_calls') calls.push(event)
  }
  return { text: chunks.join(''), chunkCount: chunks.length, calls }
}

async function main() {
  /*
   * 先确认编译产物在：这个脚本不在测试套件里（它会起真连接），所以编译得由使用者或
   * `pnpm test` 先做掉。缺文件时报清楚怎么办，别让人对着 MODULE_NOT_FOUND 发愣。
   */
  let client
  try {
    client = require(CLIENT)
  } catch (error) {
    console.error(`找不到编译产物：${CLIENT}\n先跑一次 \`npx tsc -p tsconfig.test.json\`（或 \`pnpm test\`）。`)
    throw error
  }

  const config = {
    baseUrl: `http://127.0.0.1:${PORT}/v1`,
    apiKey: 'stub-key',
    model: 'stub-model',
    timeoutMs: 30_000,
    sendJsonSchema: true,
  }

  // ---------- ① 不拒绝：schema 发出去 + 正文照样增量地流 ----------
  {
    const stub = startStub({})
    await stub.ready
    try {
      const { text, chunkCount } = await runStream(client, config, {
        systemPrompt: '把这道菜的营养说清楚。',
        prompt: '分析一下番茄炒蛋。',
        jsonSchema: SCHEMA,
      })
      const sent = await received()
      check('① 请求真的带上了 response_format（从 stub 看到的，不是看我们自己的代码）',
        sent.length === 1 && sent[0].schemaName === SCHEMA.json_schema.name,
        `stub 收到 ${sent.length} 次，schemaName=${JSON.stringify(sent[0]?.schemaName)}`)
      check('① 正文是非空的（结构化没有把回答吞掉）', text.length > 0, `正文 ${text.length} 字`)
      check('① 正文是**多段**流出来的（不是憋到最后一次性给）', chunkCount > 1, `${chunkCount} 段`)
      check('① 没传工具时就没有 tool_calls（纯聊天与旧行为一致）',
        (await received()).every((row) => Array.isArray(row.tools) && row.tools.length === 0),
        '工具字段为空')
      void text
    } finally {
      stub.child.kill()
    }
  }

  // ---------- ② 网关拒 response_format：摘掉重试一次，正文照常 ----------
  {
    const stub = startStub({ STUB_REJECT_SCHEMA_ONCE: '1' })
    await stub.ready
    try {
      const { text, chunkCount } = await runStream(client, config, {
        systemPrompt: '把这道菜的营养说清楚。',
        prompt: '分析一下番茄炒蛋。',
        jsonSchema: SCHEMA,
      })
      const sent = await received()
      check('② 网关拒了 schema 之后**自动补发了一次**（摘掉 schema）',
        sent.length === 2,
        `stub 收到 ${sent.length} 次请求`)
      check('② 第一次带 schema、第二次不带（摘的正是被拒的那个东西）',
        sent[0]?.schemaName === SCHEMA.json_schema.name && sent[1]?.schemaName === null,
        `第一次=${JSON.stringify(sent[0]?.schemaName)} 第二次=${JSON.stringify(sent[1]?.schemaName)}`)
      check('② 重试那一趟**真的把正文给到用户了**（不是报了 400 就结束）',
        text.length > 0 && chunkCount > 1,
        `正文 ${text.length} 字 / ${chunkCount} 段`)
    } finally {
      stub.child.kill()
    }
  }

  // ---------- ③ 关掉总开关时不发 schema（AI_JSON_SCHEMA=0 的口径） ----------
  {
    const stub = startStub({})
    await stub.ready
    try {
      await runStream(client, { ...config, sendJsonSchema: false }, {
        systemPrompt: '把这道菜的营养说清楚。',
        prompt: '分析一下番茄炒蛋。',
        jsonSchema: SCHEMA,
      })
      const sent = await received()
      check('③ `sendJsonSchema=false` 时一个字的 schema 都不发（总开关仍然有效）',
        sent.length === 1 && sent[0].schemaName === null,
        `schemaName=${JSON.stringify(sent[0]?.schemaName)}`)
    } finally {
      stub.child.kill()
    }
  }

  for (const row of results) {
    console.log(`${row.ok ? '✅' : '❌'} ${row.name}  — ${row.detail}`)
  }
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('验收脚本自己出错了：', error)
  process.exit(1)
})
