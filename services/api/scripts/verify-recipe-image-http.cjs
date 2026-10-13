/**
 * 自建菜谱配图的 HTTP 验收（真路：真接口 + 真 MinIO）。
 * 用一张**真实的 PNG**（不是随便一段字节）：后端按文件头判类型，假数据必被拒。
 */
const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000/api'
const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000002000000020806000000f478d4fa0000001849444154789c636060606060f80f04030c0c0c0c0000ff03000100000000000049454e44ae426082', 'hex')
const dataUrl = `data:image/png;base64,${png.toString('base64')}`

let failed = 0
const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail }); if (!ok) failed += 1 }

async function call(method, path, { body, token } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const ct = res.headers.get('content-type') ?? ''
  let parsed = null
  if (ct.includes('application/json')) { try { parsed = await res.json() } catch { parsed = null } }
  return { status: res.status, body: parsed }
}

async function main() {
  const account = `img${Date.now()}`.toLowerCase()
  const reg = await call('POST', '/auth/register', { body: { account, password: 'cook2026pass', nickname: '配图验收' } })
  const token = reg.body?.token
  check('注册一个验收账号', reg.status === 201 && Boolean(token), `status=${reg.status}`)
  await call('POST', '/family', { token, body: { name: '配图验收家' } })

  // ---------- ① 建一道带配图的菜 ----------
  const created = await call('POST', '/recipes', {
    token,
    body: {
      name: '配图的红烧肉', category: '荤菜', cuisine: '家常',
      tags: [], ingredients: [{ name: '五花肉', amount: '500g' }], steps: ['切块焯水'], notes: [], calories: 480,
      aliases: [], image: dataUrl,
    },
  })
  check('**带配图新建**：201 且详情里返回了图片地址', created.status === 201 && Boolean(created.body?.image), `status=${created.status} image=${String(created.body?.image).slice(0, 60)}`)
  const id = created.body?.id
  const image = created.body?.image ?? ''
  check('返回的地址是**自托管的**（不是 dataURL、也不是源站直链）', image.startsWith('http') && image.includes('/recipes/') && image.endsWith('.png'), `image=${image}`)

  // ---------- ② 那张图真的能从对象存储取回来 ----------
  if (image) {
    const fetched = await fetch(image)
    const bytes = Buffer.from(await fetched.arrayBuffer())
    check('**图片真的存进了对象存储**（按返回的地址取回来，字节与上传的一致）', fetched.ok && bytes.equals(png), `http=${fetched.status} bytes=${bytes.length}/${png.length}`)
    check('取回来时带的是 image/png（Content-Type 跟扩展名对得上）', (fetched.headers.get('content-type') ?? '').includes('image/png'), `content-type=${fetched.headers.get('content-type')}`)
  }

  // ---------- ③ 列表里也带着图（用户能看见） ----------
  const list = await call('GET', '/recipes?mine=1', { token })
  const row = (list.body?.items ?? []).find((item) => item.id === id)
  check('**「我的菜谱」列表里这张图也在**（不是只有详情页有）', Boolean(row?.image), `image=${String(row?.image).slice(0, 60)}`)

  // ---------- ④ 假图必须被拒 ----------
  const fake = await call('POST', '/recipes', {
    token,
    body: { name: '假图菜', category: '荤菜', cuisine: '家常', tags: [], ingredients: [], steps: ['一步'], notes: [], calories: null, aliases: [], image: Buffer.from('<html>not an image</html>').toString('base64') },
  })
  check('**把 HTML 当图片传进来会被拒**（按文件头判，不是信声明的类型）', fake.status === 400, `status=${fake.status} msg=${fake.body?.message}`)

  const mismatch = await call('POST', '/recipes', {
    token,
    body: { name: '类型不符菜', category: '荤菜', cuisine: '家常', tags: [], ingredients: [], steps: ['一步'], notes: [], calories: null, aliases: [], image: `data:image/jpeg;base64,${png.toString('base64')}` },
  })
  check('声明 image/jpeg 但内容其实是 PNG：400（两边必须一致）', mismatch.status === 400, `status=${mismatch.status} msg=${mismatch.body?.message}`)

  const empty = await call('POST', '/recipes', {
    token,
    body: { name: '空图菜', category: '荤菜', cuisine: '家常', tags: [], ingredients: [], steps: ['一步'], notes: [], calories: null, aliases: [], image: '' },
  })
  check('配图留空**不算错**：照样能建出一道没图的菜', empty.status === 201 && empty.body?.image === null, `status=${empty.status} image=${empty.body?.image}`)

  // ---------- ⑤ 编辑：只换图也能存下去 ----------
  const onlyImage = await call('PATCH', `/recipes/${id}`, { token, body: { image: dataUrl } })
  check('**只换一张图、别的字段一个字没改**：不是 400（配图也算一次有效改动）', onlyImage.status === 200, `status=${onlyImage.status} msg=${onlyImage.body?.message}`)

  const patchName = await call('PATCH', `/recipes/${id}`, { token, body: { name: '改过名的红烧肉' } })
  check('不带图改字段：图片**不受影响**（没传就是保持原样）', patchName.status === 200 && patchName.body?.image === image, `image=${String(patchName.body?.image).slice(0, 60)}`)

  const nothing = await call('PATCH', `/recipes/${id}`, { token, body: {} })
  check('什么都不改又没带图：还是 400「没有要改的内容」（放行只对"带了图"成立）', nothing.status === 400, `status=${nothing.status} msg=${nothing.body?.message}`)

  // ---------- ⑥ 别人家的图看不见，也改不了 ----------
  const other = await call('POST', '/auth/register', { body: { account: `imgb${Date.now()}`.toLowerCase(), password: 'cook2026pass', nickname: '邻居' } })
  await call('POST', '/family', { token: other.body?.token, body: { name: '邻居家' } })
  const peek = await call('GET', `/recipes/${id}`, { token: other.body?.token })
  check('别家人看不到这道菜（连带它的图）：404', peek.status === 404, `status=${peek.status}`)
  const steal = await call('PATCH', `/recipes/${id}`, { token: other.body?.token, body: { name: '偷来的菜' } })
  check('别家人改不了这道菜：403', steal.status === 403, `status=${steal.status}`)

  for (const item of results) console.log(`${item.ok ? '✅' : '❌'} ${item.name}${item.detail ? `  — ${item.detail}` : ''}`)
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  if (failed) process.exitCode = 1
}

void main().catch((error) => { console.error(error); process.exitCode = 1 })
