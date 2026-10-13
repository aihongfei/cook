/**
 * AI 附件（图片）与冰箱拍照识别的 HTTP 验收 —— **走真模型 + 真图**。
 *
 * 为什么必须走真模型：这一整套的价值就是"它真的看见了"。用 stub 的话验的只是
 * "我们把图传出去了"，而"模型能不能据此办事"一个字都没验到。
 *
 * 用一张**画了字的图**（不是纯色块）：纯色只能验"看到了颜色"，画上内容才能验
 * "它读到了图里的信息"——这正是用户要的（拍冰箱、拍菜品）。
 */
const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000/api'
let failed = 0
const results = []
const check = (n, ok, d) => { results.push({ n, ok, d }); if (!ok) failed += 1 }

async function call(method, path, { body, token, raw } = {}) {
  const headers = {}
  if (!raw) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)) })
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('json')) return { status: res.status, body: null, bytes: Buffer.from(await res.arrayBuffer()), contentType: ct }
  let parsed = null
  try { parsed = await res.json() } catch {}
  return { status: res.status, body: parsed, contentType: ct }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 用 sharp 不可得，所以用 Node 侧的 canvas 替代：直接生成一张带文字的 PNG 太麻烦，
// 改用 **SVG → 不是图片类型**（会被 sniff 拒）。所以这里用一张手写的 PNG：
// 画 8x8 的红/白棋盘 —— 模型能看出"棋盘格"，足以证明它真的在读像素。
function checkerPng(size = 64, cell = 8) {
  const { deflateSync } = require('node:zlib')
  const crcTable = []
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0 }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    let crc = 0xffffffff
    for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)
    const c = Buffer.alloc(4); c.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([len, body, c])
  }
  const rows = []
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3)
    for (let x = 0; x < size; x += 1) {
      const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0
      row[1 + x * 3] = on ? 200 : 245
      row[2 + x * 3] = on ? 60 : 240
      row[3 + x * 3] = on ? 40 : 230
    }
    rows.push(row)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
}

async function waitFor(pick, { tries = 40, gapMs = 3000, label = '' } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const value = await pick()
    if (value) return value
    await sleep(gapMs)
  }
  throw new Error(`等不到：${label}`)
}

async function main() {
  const stamp = Date.now()
  const me = await call('POST', '/auth/register', { body: { account: `vis${String(stamp).slice(-7)}`, password: 'cook2026pass', nickname: '看图的我' } })
  const token = me.body?.token
  await call('POST', '/family', { token, body: { name: '看图之家' } })
  check('注册并建家', Boolean(token), `status=${me.status}`)

  // ---------- ① 上传附件 ----------
  const png = checkerPng()
  const up = await call('POST', '/ai/attachments', { token, body: { image: `data:image/png;base64,${png.toString('base64')}` } })
  check('**上传一张图拿到 id**', up.status === 201 && typeof up.body?.id === 'string', `status=${up.status} id=${String(up.body?.id).slice(0, 12)}`)
  const id = up.body?.id

  // 传两次同一张图 → 同一个 id（内容哈希去重）
  const again = await call('POST', '/ai/attachments', { token, body: { image: `data:image/png;base64,${png.toString('base64')}` } })
  check('同一张图再传一次，**复用同一条记录**（不堆重复行、不占额度）', again.body?.id === id, `again=${String(again.body?.id).slice(0, 12)}`)

  // 假图必须被拒
  const fake = await call('POST', '/ai/attachments', { token, body: { image: Buffer.from('<html>hi</html>').toString('base64') } })
  check('**HTML 假冒图片会被拒**（按文件头判，不信声明的类型）', fake.status === 400, `status=${fake.status} msg=${fake.body?.message}`)

  // ---------- ② 取图 ----------
  const got = await call('GET', `/ai/attachments/${id}/photo`, { token })
  check('**取回来的字节与上传的完全一致**', got.status === 200 && got.bytes.equals(png), `http=${got.status} bytes=${got.bytes.length}/${png.length} type=${got.contentType}`)

  const anon = await call('GET', `/ai/attachments/${id}/photo`)
  check('未登录取图：401', anon.status === 401, `status=${anon.status}`)

  const stranger = await call('POST', '/auth/register', { body: { account: `vsb${String(stamp).slice(-7)}`, password: 'cook2026pass', nickname: '外人' } })
  await call('POST', '/family', { token: stranger.body?.token, body: { name: '外人家' } })
  const peek = await call('GET', `/ai/attachments/${id}/photo`, { token: stranger.body?.token })
  check('**别家人取图：404**（不是 200，也不是 500）', peek.status === 404, `status=${peek.status}`)

  // ---------- ③ 冒烟：流式对话带图 ----------
  console.log('\n（要等真模型看图回答，可能要一会儿…）')
  const reply = await call('POST', '/ai/chat/stream', {
    token,
    body: { messages: [{ role: 'user', content: '这张图是什么样的？两个词以内回答。', attachments: [id] }] },
  })
  const text = (() => {
    const out = []
    for (const line of String(reply.bytes?.toString('utf8') ?? '').split('\n')) {
      if (!line.startsWith('data: ')) continue
      try { const d = JSON.parse(line.slice(6)); if (d.type === 'text') out.push(d.text) } catch {}
    }
    return out.join('')
  })()
  check('**带图问一问，模型答得出来**（说明图真的到了它眼前）', reply.status === 200 && text.trim().length > 0, `status=${reply.status} 答=${JSON.stringify(text.slice(0, 60))}`)
  check('它认出了图里的内容（棋盘/格/方块）', /棋|格|方块|方|红/.test(text), `答=${JSON.stringify(text.slice(0, 60))}`)

  // 引一张不存在的图 → 明确拒绝，而不是静默丢图
  const ghost = await call('POST', '/ai/chat/stream', {
    token,
    body: { messages: [{ role: 'user', content: '这张呢？', attachments: ['no-such-image'] }] },
  })
  check('引用一张不存在的图：**明确报错**，不静默当没事', ghost.status >= 400, `status=${ghost.status} body=${JSON.stringify(ghost.body)?.slice(0, 60)}`)

  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.n}${r.d ? `  — ${r.d}` : ''}`)
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  if (failed) process.exitCode = 1
}
void main().catch((e) => { console.error(e); process.exitCode = 1 })
