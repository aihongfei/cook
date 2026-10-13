/**
 * 自建菜谱是不是"全家共享"：真的建第二个家庭成员来验（不是读代码推断）。
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
  if (ct.includes('application/json')) { try { parsed = await res.json() } catch {} }
  return { status: res.status, body: parsed }
}
const main = async () => {
  const stamp = Date.now()
  const mama = await call('POST', '/auth/register', { body: { account: `famm${String(stamp).slice(-6)}`, password: 'cook2026pass', nickname: '妈妈' } })
  const family = await call('POST', '/family', { token: mama.body.token, body: { name: '共享验收家' } })
  const invite = family.body?.family?.inviteCode ?? family.body?.inviteCode
  check('妈妈建家成功', family.status === 201 && Boolean(invite), `status=${family.status} invite=${invite}`)

  const papa = await call('POST', '/auth/register', { body: { account: `famp${String(stamp).slice(-6)}`, password: 'cook2026pass', nickname: '爸爸' } })
  const joined = await call('POST', '/family/join', { token: papa.body.token, body: { inviteCode: invite } })
  check('爸爸用邀请码加入同一个家', joined.status === 201 || joined.status === 200, `status=${joined.status}`)

  const dishName = `妈妈的拿手菜${String(stamp).slice(-5)}`
  const made = await call('POST', '/recipes', { token: mama.body.token, body: { name: dishName, category: '荤菜', cuisine: '家常', tags: [], ingredients: [{ name: '肉', amount: '1斤' }], steps: ['炖'], notes: [], calories: null, aliases: [] } })
  check('妈妈写下一道自家菜谱', made.status === 201, `status=${made.status}`)
  const id = made.body.id

  const papaList = await call('GET', '/recipes?mine=1', { token: papa.body.token })
  const seen = (papaList.body?.items ?? []).find((i) => i.id === id)
  check('**爸爸在「我的菜谱」里看得见妈妈写的菜**（这就是"全家共享"）', Boolean(seen), `count=${(papaList.body?.items ?? []).length}`)
  check('爸爸看它时 `mine` 也是 true（他也能改）', seen?.mine === true, `mine=${seen?.mine}`)

  const papaDetail = await call('GET', `/recipes/${id}`, { token: papa.body.token })
  check('爸爸打得开详情（连带配图与做法）', papaDetail.status === 200, `status=${papaDetail.status}`)

  const papaEdit = await call('PATCH', `/recipes/${id}`, { token: papa.body.token, body: { notes: ['爸爸补了一句话'] } })
  check('**爸爸能改妈妈写的菜**（一家人都能改）', papaEdit.status === 200 && papaEdit.body?.notes?.[0] === '爸爸补了一句话', `status=${papaEdit.status} notes=${JSON.stringify(papaEdit.body?.notes)}`)

  const mamaSees = await call('GET', `/recipes/${id}`, { token: mama.body.token })
  check('妈妈看得见爸爸改的内容（同一份数据，不是各自一份拷贝）', mamaSees.body?.notes?.[0] === '爸爸补了一句话', `notes=${JSON.stringify(mamaSees.body?.notes)}`)

  const out = await call('POST', '/auth/register', { body: { account: `famx${String(stamp).slice(-6)}`, password: 'cook2026pass', nickname: '邻居' } })
  await call('POST', '/family', { token: out.body.token, body: { name: '邻居家' } })
  const peek = await call('GET', `/recipes/${id}`, { token: out.body.token })
  check('**别家人看不到**这家共享的菜：404', peek.status === 404, `status=${peek.status}`)

  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.n}${r.d ? `  — ${r.d}` : ''}`)
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  if (failed) process.exitCode = 1
}
void main().catch((e) => { console.error(e); process.exitCode = 1 })
