/**
 * 图片上传体量验收（2026-10-14 用户报 413 之后新增）。
 *
 * 为什么要单独有这个脚本：**既有的打卡验收脚本用的都是几十字节的 1x1 PNG**
 * （`pngBytes(11)` 那种），所以"图片以 base64 塞 JSON"这条路上真正的体积
 * 从来没被撞到过——Express 默认 100kb 的限制就躲在测试盲区里。
 * 这里专门用**真实照片量级**的体量走一遍，把盲区补上。
 */
const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000/api'
let failed = 0
function check(name, ok, detail) {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}
async function call(method, path, { body, token } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const contentType = response.headers.get('content-type') ?? ''
  let parsed = null
  if (contentType.includes('application/json')) { try { parsed = await response.json() } catch { parsed = null } }
  return { status: response.status, body: parsed }
}

async function main() {

// 真照片量级的 data URL：客户端压到 1600px 后约 300–800KB，base64 再 ×4/3。
//
// ⚠️ 开头三个字节必须是**真的 JPEG 魔数**（`FF D8 FF`）——后端靠文件头判类型
// （`sniffImageType` 只看头几个字节），随便拿 0xff 填出来的字节会被判成
// 「这个文件不是图片」。第一版就是栽在这（占了三条"失败"）。
  const kb = (n) => {
    const bytes = Buffer.alloc(n * 1024, 0x41)
    bytes[0] = 0xff
    bytes[1] = 0xd8
    bytes[2] = 0xff
    return 'data:image/jpeg;base64,' + bytes.toString('base64')
  }

  const account = `imgsize${Date.now()}`
  const reg = await call('POST', '/auth/register', { body: { account, password: 'cook2026pass', nickname: '体量验收' } })
  check('注册一个新账号（后面要带令牌）', reg.status === 201 || reg.status === 200, `HTTP ${reg.status}`)
  const token = reg.body?.token
  if (!token) { console.log('拿不到令牌，后续跳过'); process.exit(1) }

  // 打卡与 AI 附件都要求"先有家庭"（这是业务前置，不是本次要验的事）——先建一个
  const fam = await call('POST', '/family', { token, body: { name: '体量验收家' } })
  check('建一个家庭（上传的前置条件）', fam.status === 201, `HTTP ${fam.status}`)
  // 限流窗口内建家可能被 429 挡下，等一轮
  if (fam.status === 429) {
    await new Promise((r) => setTimeout(r, 61_000))
    const retry = await call('POST', '/family', { token, body: { name: '体量验收家' } })
    check('限流等待后建家成功', retry.status === 201, `HTTP ${retry.status}`)
  }

// ① 真实照片量级（400KB）必须过——修前这里是 413 request entity too large
  const mid = await call('POST', '/checkins', { body: { image: kb(400), note: '真实照片量级 400KB' }, token })
  check('400KB 的图能传（修前 413）', mid.status === 201 || mid.status === 200, `HTTP ${mid.status} ${JSON.stringify(mid.body).slice(0, 90)}`)

// ② 1MB 也应当过（8MB 上限以内，且要盖住大多数手机压缩后的照片）
  const oneMb = await call('POST', '/checkins', { body: { image: kb(1024) }, token })
  check('1MB 的图能传', oneMb.status === 201 || oneMb.status === 200, `HTTP ${oneMb.status}`)

// ③ 超过业务上限（8MB）：必须拿到**中文话术**，而不是英文 413
//    这正是"请求体上限必须大于业务上限"那条设计的原因
  const over = await call('POST', '/checkins', { body: { image: kb(9 * 1024) }, token })
  const overText = JSON.stringify(over.body ?? '')
  check('超 8MB 拿到中文话术（不是英文 413）', over.status === 400 && /不能超过 8MB/.test(overText), `HTTP ${over.status} ${overText.slice(0, 90)}`)

// ④ AI 附件上传同一套限制（对话里发图）
  const att = await call('POST', '/ai/attachments', { body: { image: kb(400) }, token })
  check('AI 附件 400KB 也能传', att.status === 200 || att.status === 201, `HTTP ${att.status} ${JSON.stringify(att.body).slice(0, 80)}`)

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
