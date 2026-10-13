/**
 * 冰箱拍照识别（F16-04）的 HTTP 验收 —— 真模型 + 真图。
 *
 * 重点验三件：
 * ① 识别出的东西**只当草稿**（这一步真的没写库）；
 * ② 草稿的形状与 `/fridge` 的入参对得上（前端能直接拿它去批量入库）；
 * ③ **看图之后仍能调工具写库**（用户要的"识别完直接让它记进冰箱"）。
 */
const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000/api'
let failed = 0
const results = []
const check = (n, ok, d) => { results.push({ n, ok, d }); if (!ok) failed += 1 }

async function call(method, path, { body, token } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const ct = res.headers.get('content-type') ?? ''
  let parsed = null
  if (ct.includes('json')) { try { parsed = await res.json() } catch {} }
  const text = ct.includes('event-stream') ? await res.text() : ''
  return { status: res.status, body: parsed, text }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 上游偶发 502 时重试一次。
 *
 * 为什么要给验收脚本带上重试：模型服务偶尔会回 502（"连不上 AI 服务"这层是我们自己的
 * 兜底文案，真因是上游那一下没接上——本次就跑出过一次）。那不是被测行为的问题，
 * 却会让整份验收红掉，于是"红"就不再意味着"代码坏了"——这才是最坏的结果。
 * **只重试 5xx，且只重试一次**：真报错（400/403/429）必须原样冒出来。
 */
async function callRetry(method, path, options) {
  let last = await call(method, path, options)
  // 最多三次：本次实测里上游短时间连挂两下的情况出现过
  for (let attempt = 1; attempt <= 2 && last.status >= 500; attempt += 1) {
    console.log(`（上游 ${last.status}，等一下重试第 ${attempt} 次…）`)
    await sleep(2500 * attempt)
    last = await call(method, path, options)
  }
  return last
}
function streamText(raw) {
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue
    try { const d = JSON.parse(line.slice(6)); if (d.type === 'text') out.push(d.text) } catch {}
  }
  return out.join('')
}

/**
 * 一张**画着食材的 PNG**（番茄 + 一板鸡蛋 + 一把葱，见 mkGroceries）。
 *
 * 为什么需要它、而不是只有下面那张纯色块：纯色块上模型会老老实实答"认不出食材"、
 * 于是 `items` 是空数组——而"每条草稿名字非空、区在四区之内"这种断言在空数组上**必然通过**，
 * 看着绿其实什么都没验（这是本次自查发现的盲区）。真放着几样能认出来的东西，
 * 那几条断言才真的在断言。
 */
function groceriesPng() {
  const { deflateSync } = require('node:zlib')
  const W = 720
  const H = 900
  const px = Buffer.alloc(W * H * 3)
  const fill = (r, g, b) => { for (let i = 0; i < W * H; i += 1) { px[i*3] = r; px[i*3+1] = g; px[i*3+2] = b } }
  const rect = (x0, y0, w, h, r, g, b) => {
    for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y += 1)
      for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x += 1) {
        const i = (y * W + x) * 3; px[i] = r; px[i+1] = g; px[i+2] = b
      }
  }
  const disc = (cx, cy, rad, r, g, b) => {
    for (let y = cy - rad; y <= cy + rad; y += 1)
      for (let x = cx - rad; x <= cx + rad; x += 1) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue
        const dx = x - cx, dy = y - cy
        if (dx * dx + dy * dy <= rad * rad) { const i = (y * W + x) * 3; px[i] = r; px[i+1] = g; px[i+2] = b }
      }
  }

  fill(198, 162, 116)
  disc(180, 430, 62, 205, 55, 40)
  disc(320, 470, 56, 190, 48, 34)
  disc(255, 350, 50, 214, 62, 46)
  rect(172, 366, 16, 14, 78, 125, 54)
  rect(312, 410, 16, 14, 78, 125, 54)
  rect(120, 620, 480, 250, 214, 206, 190)
  for (let row = 0; row < 2; row += 1)
    for (let col = 0; col < 3; col += 1) disc(190 + col * 160, 690 + row * 130, 46, 250, 244, 226)
  for (let i = 0; i < 5; i += 1) rect(96 + i * 18, 560, 10, 120, 79, 138, 59)

  const raw = Buffer.alloc(H * (W * 3 + 1))
  for (let y = 0; y < H; y += 1) px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3)
  const table = []
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0 }
  const chunk = (t, d) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length)
    const body = Buffer.concat([Buffer.from(t, 'latin1'), d])
    let crc = 0xffffffff
    for (const b of body) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
    const c = Buffer.alloc(4); c.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([len, body, c])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

// 一张**画着内容的 PNG**：白底 + 中间一块黄色（"像一个鸡蛋/柠檬"），
// 纯色块能被模型描述出来，足以证明它在读像素（拍照识别的实质就是这件事）。
function blobPng(size = 96) {
  const { deflateSync } = require('node:zlib')
  const crcTable = []
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0 }
  const chunk = (t, d) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length)
    const body = Buffer.concat([Buffer.from(t, 'latin1'), d])
    let crc = 0xffffffff
    for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)
    const c = Buffer.alloc(4); c.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([len, body, c])
  }
  const rows = []
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3)
    for (let x = 0; x < size; x += 1) {
      const dx = x - size / 2, dy = y - size / 2
      const inside = dx * dx + dy * dy < (size / 3) ** 2
      const r = inside ? 240 : 252, g = inside ? 205 : 250, b = inside ? 60 : 240
      row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b
    }
    rows.push(row)
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
}

async function main() {
  const stamp = Date.now()
  const me = await call('POST', '/auth/register', { body: { account: `ocr${String(stamp).slice(-7)}`, password: 'cook2026pass', nickname: '拍照的我' } })
  const token = me.body?.token
  await call('POST', '/family', { token, body: { name: '拍照之家' } })

  // 识别这一路用"真有食材"的那张：见 groceriesPng 的说明（纯色块上断言会空过）
  const groceries = groceriesPng()
  const upPhoto = await call('POST', '/ai/attachments', { token, body: { image: `data:image/png;base64,${groceries.toString('base64')}` } })
  const photoId = upPhoto.body?.id
  check('上传一张**有食材的**照片', upPhoto.status === 201 && Boolean(photoId), `status=${upPhoto.status}`)

  // 纯色块那张继续用来验"认不出时不乱写"（那是另一条要紧的规矩）
  const png = blobPng()
  const up = await call('POST', '/ai/attachments', { token, body: { image: `data:image/png;base64,${png.toString('base64')}` } })
  const id = up.body?.id
  check('上传一张冰箱照片', up.status === 201 && Boolean(id), `status=${up.status}`)

  const before = await call('GET', '/fridge', { token })
  const countBefore = (before.body?.zones ?? []).reduce((sum, z) => sum + (z.items?.length ?? 0), 0)

  console.log('\n（要等真模型看图识别，可能要一会儿…）')
  // 用**有食材**的那张（photoId）：这一段的断言都是"认出东西之后"才有意义的
  const scan = await callRetry('POST', '/ai/scan-fridge', { token, body: { attachmentId: photoId } })
  check('识别接口通', scan.status === 200, `status=${scan.status} body=${JSON.stringify(scan.body)?.slice(0, 120)}`)
  check('回的是**草稿**：`items` 是数组（可能识别不出，但形状必须对）', Array.isArray(scan.body?.items), `items=${JSON.stringify(scan.body?.items)?.slice(0, 120)}`)
  check('每条草稿的形状对得上 /fridge 的入参', (scan.body?.items ?? []).every((it) => it.name && ['常温','保鲜','冷藏','冷冻'].includes(it.zone)), `items=${JSON.stringify(scan.body?.items)?.slice(0, 200)}`)
  check('这条草稿里**每一条都有名字**（不是空数组空过——见 groceriesPng 的说明）', (scan.body?.items ?? []).length > 0, `items=${JSON.stringify(scan.body?.items)?.slice(0, 200)}`)
  /*
   * 数量里**只该有数目与单位**，"灰色蛋托中可见六枚"这种外观描述曾经被模型塞进备注、
   * 而界面上不显示备注 → 静默入库（2026-08 那次是浏览器实测抓到的）。
   * 这里钉住"描述不该出现在这两个字段里"，因为提示词治不了每一次发挥。
   */
  const descriptive = /(色|外观|可见|像是|位于|旁边|质地|光泽|摆放|中可)/
  const dirty = (scan.body?.items ?? []).flatMap((it) => [it.amount, it.note]
    .filter((v) => typeof v === 'string' && descriptive.test(v))
    .map((v) => `${it.name}: ${v}`))
  check('数量/备注里不该混进外观描述（那是静默入库的通道）', dirty.length === 0, dirty.join(' | ') || '干净')

  console.log('\n（再等一次真模型：换纯色块，看它认不出时会不会乱写…）')
  const blank = await callRetry('POST', '/ai/scan-fridge', { token, body: { attachmentId: id } })
  /*
   * 失败时把 status 也打出来：**上游 502 与"模型乱写"是两件事**——
   * 前者重试即可、后者是产品缺陷。把两者混在一个 ❌ 里，看红的人会去查错方向。
   */
  check('认不出的图上**一样都不写**（宁可少写也不猜）',
    blank.status === 200 && (blank.body?.items ?? []).length === 0,
    `status=${blank.status} items=${JSON.stringify(blank.body?.items)?.slice(0, 160)}`)

  const after = await call('GET', '/fridge', { token })
  const countAfter = (after.body?.zones ?? []).reduce((sum, z) => sum + (z.items?.length ?? 0), 0)
  check('**识别这一步没有写库**（冰箱条数没变——入库必须等用户确认）', countBefore === countAfter, `${countBefore} → ${countAfter}`)

  // ---------- 看图之后还能调工具写库（用户要的那条路） ----------
  console.log('\n（再等一次真模型：让它看图并把东西记进冰箱…）')
  const chat = await call('POST', '/ai/chat/stream', {
    token,
    body: { messages: [{ role: 'user', content: '照片里是我刚买的一个柠檬，帮我记进冰箱，放冷藏。', attachments: [id] }] },
  })
  check('带图的对话请求是 200', chat.status === 200, `status=${chat.status}`)

  const finalBoard = await call('GET', '/fridge', { token })
  const finalCount = (finalBoard.body?.zones ?? []).reduce((sum, z) => sum + (z.items?.length ?? 0), 0)
  check('**AI 带图说话之后真的把东西记进了冰箱**（工具链路在图之后仍然可用）', finalCount > countBefore, `${countBefore} → ${finalCount}`)

  const receipts = await call('GET', '/ai/actions', { token })
  check('这笔写入留了回执（可撤）', (receipts.body?.items ?? []).length > 0, `条数=${(receipts.body?.items ?? []).length}`)

  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.n}${r.d ? `  — ${r.d}` : ''}`)
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  if (failed) process.exitCode = 1
}
void main().catch((e) => { console.error(e); process.exitCode = 1 })
