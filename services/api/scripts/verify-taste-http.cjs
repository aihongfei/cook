#!/usr/bin/env node
/**
 * 口味与健康档案接口验收（真实请求，不 mock）。M8 / F8-01、F8-02。
 * 用法：先启动服务，再执行 pnpm run test:http:taste
 *
 * 覆盖三块，每一块都是"错了会在别处出问题"的那种：
 *
 * ① **档案本身**：部分更新（只改传了的字段）、只认自己那份、辣度/荤素的字面值校验；
 * ② **F3-08 点菜提醒**：对花生过敏的人 → 点含花生的菜要带提醒；
 *    **菜名不算数**（鱼香肉丝里没有鱼，不该提醒对鱼过敏的人）；
 * ③ **F5-03 推荐过滤**：有人过敏时，AI 推荐**绝不会**给出含过敏原的菜。
 *
 * 为什么第 ③ 条要用真模型跑：那是一整条从"档案"到"候选清单"的链路，
 * 而我们能验的只有**最终推荐结果**——中间少了哪一步都不会有编译错误。
 */
const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000/api'

let failed = 0
const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail }); if (!ok) failed += 1 }

async function call(method, path, { body, token } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const contentType = response.headers.get('content-type') ?? ''
  let parsed = null
  if (contentType.includes('application/json')) {
    try { parsed = await response.json() } catch { parsed = null }
  }
  return { status: response.status, body: parsed, retryAfter: response.headers.get('retry-after') }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 全局限流 60 次/分（按 IP）；连跑第二遍会被自己打到 429，遇 429 等窗口重试 */
async function callRetry(method, path, options = {}) {
  let last = await call(method, path, options)
  for (let round = 1; round <= 3 && last.status === 429; round += 1) {
    const waitMs = (Number(last.retryAfter) || 60) * 1000 + 1000
    console.log(`（被限流了，等 ${Math.round(waitMs / 1000)} 秒重试第 ${round} 次…）`)
    await sleep(waitMs)
    last = await call(method, path, options)
  }
  // 上游偶发 5xx 也重试（见 RISKS R-41：不重试的话"红"就不再意味着"代码坏了"）
  for (let round = 1; round <= 2 && last.status >= 500; round += 1) {
    console.log(`（上游 ${last.status}，等一下重试第 ${round} 次…）`)
    await sleep(2500 * round)
    last = await call(method, path, options)
  }
  return last
}

async function register(nickname) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`
  const me = await callRetry('POST', '/auth/register', {
    body: { account: `taste${stamp.slice(-9)}`, password: 'cook2026pass', nickname },
  })
  return { token: me.body?.token, account: `taste${stamp.slice(-9)}` }
}

async function main() {
  // ---------- ① 档案本身 ----------
  const mama = await register('妈妈')
  check('注册成功', Boolean(mama.token), `token=${Boolean(mama.token)}`)
  const family = await callRetry('POST', '/family', { token: mama.token, body: { name: '口味验收家' } })
  check('建家成功', family.status === 201, `status=${family.status}`)

  const options = await call('GET', '/taste/options')
  check('可选项**免登录可读**（空态就要能看见"原来可以写过敏"）',
    options.status === 200 && (options.body?.allergies ?? []).length > 0, `status=${options.status}`)

  const empty = await callRetry('GET', '/taste', { token: mama.token })
  check('没写过时返回 null（不是一条空记录）', empty.status === 200 && empty.body === null, `body=${JSON.stringify(empty.body)}`)

  // 部分更新：先只写忌口
  const first = await callRetry('PATCH', '/taste', { token: mama.token, body: { dislikes: ['香菜'] } })
  check('只写一个字段也能存（部分更新）', first.status === 200 && first.body?.dislikes?.[0] === '香菜', `body=${JSON.stringify(first.body)}`)
  check('没传的字段保持"没说过"（没被默认值填上）',
    first.body?.spicyLevel === null && first.body?.allergies?.length === 0, `spicyLevel=${first.body?.spicyLevel}`)

  // 再改另一个字段：不能把刚才那个冲掉
  const second = await callRetry('PATCH', '/taste', { token: mama.token, body: { allergies: ['花生'] } })
  check('**改第二个字段不冲掉第一个**（只传了的才动）',
    second.body?.dislikes?.[0] === '香菜' && second.body?.allergies?.[0] === '花生',
    `dislikes=${JSON.stringify(second.body?.dislikes)} allergies=${JSON.stringify(second.body?.allergies)}`)

  const badSpicy = await callRetry('PATCH', '/taste', { token: mama.token, body: { spicyLevel: 9 } })
  check('辣度超出范围 → 400 且给人话', badSpicy.status === 400, `status=${badSpicy.status} msg=${badSpicy.body?.message}`)
  const badDiet = await callRetry('PATCH', '/taste', { token: mama.token, body: { diet: '吃素' } })
  check('荤素只认三档 → 400', badDiet.status === 400, `status=${badDiet.status}`)
  const emptyPatch = await callRetry('PATCH', '/taste', { token: mama.token, body: {} })
  check('什么都没传 → 400（不能拿空请求建一条空记录）', emptyPatch.status === 400, `status=${emptyPatch.status}`)

  const anon = await call('GET', '/taste')
  check('未登录读档案：401', anon.status === 401, `status=${anon.status}`)

  // 全家视角：把爸爸也拉进来（他不写）
  const papa = await register('爸爸')
  const code = family.body?.inviteCode
  const join = await callRetry('POST', '/family/join', { token: papa.token, body: { inviteCode: code } })
  check('爸爸加入家庭成功（后面两条要用）', join.status === 200, `status=${join.status} body=${JSON.stringify(join.body)?.slice(0, 120)}`)
  const whole = await callRetry('GET', '/taste/family', { token: mama.token })
  check('全家视角含**还没写的人**（不能只回填过的，那会显示成"全家都护上了"）',
    (whole.body?.missing ?? []).includes('爸爸'), `missing=${JSON.stringify(whole.body?.missing)}`)
  check('全家视角不泄露内部的判据形状', whole.body?.active === undefined, `keys=${Object.keys(whole.body ?? {}).join(',')}`)

  // ---------- ② F3-08 点菜提醒 ----------
  // 找一道**含花生**的菜和一道**含鱼**的菜（后者用来验"菜名不算数"）
  const peanut = await callRetry('GET', '/recipes?q=花生&pageSize=20', { token: mama.token })
  const peanutDish = (peanut.body?.items ?? []).find((item) => /花生/.test(item.name)) ?? null
  const fishNamed = await callRetry('GET', '/recipes?q=鱼香&pageSize=20', { token: mama.token })
  const fishDish = (fishNamed.body?.items ?? []).find((item) => /鱼香/.test(item.name)) ?? null
  check('库里能搜到带"花生"的菜与"鱼香"的菜（后面两条要用）',
    Boolean(peanutDish && fishDish), `花生=${peanutDish?.name} 鱼香=${fishDish?.name}`)

  if (peanutDish) {
    const ordered = await callRetry('POST', '/orders/items', {
      token: mama.token,
      body: { recipeId: peanutDish.id, mealDate: new Date().toISOString().slice(0, 10), meal: 'DINNER' },
    })
    check('点含过敏原的菜**仍然点得进去**（提醒不是拦截）', ordered.status === 201, `status=${ordered.status}`)
    check('但返回里带上了提醒，且说清是谁、因为哪样配料',
      ordered.body?.tasteWarning?.verdict === 'block' && /花生/.test(ordered.body?.tasteWarning?.text ?? ''),
      `warning=${JSON.stringify(ordered.body?.tasteWarning)}`)
  }

  if (fishDish) {
    /*
     * **这一条是判据的核心**：对鱼过敏的人点「鱼香肉丝」不该被提醒——
     * 那道菜里没有鱼。按菜名匹配的实现会在这里红。
     */
    await callRetry('PATCH', '/taste', { token: mama.token, body: { allergies: ['花生', '鱼'] } })
    const fake = await callRetry('POST', '/orders/items', {
      token: mama.token,
      body: { recipeId: fishDish.id, mealDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), meal: 'DINNER' },
    })
    check('**菜名里有"鱼"但配料里没有鱼 → 不提醒**（判据只看配料表）',
      fake.status === 201 && !fake.body?.tasteWarning, `warning=${JSON.stringify(fake.body?.tasteWarning)}`)
  }

  /*
   * 提醒是**按全家算的，不是按点菜那个人**：爸爸（没写档案）点了含花生的菜，
   * 仍然要收到"妈妈对花生过敏"的提醒——这道菜是做给全家人吃的，
   * 按"点菜人自己的档案"去判会把最该提醒的那种情况漏掉。
   *
   * 这条一开始被我写成了"爸爸不该收到提醒"，跑出来才发现**是测试错了、代码是对的**。
   */
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
  const crossOrder = await callRetry('POST', '/orders/items', {
    token: papa.token,
    body: peanutDish
      ? { recipeId: peanutDish.id, mealDate: tomorrow, meal: 'LUNCH' }
      : { dishName: '随便一道', mealDate: tomorrow, meal: 'LUNCH' },
  })
  check('**提醒按全家算，不按点菜那个人**（爸爸点的菜也提醒他"妈妈过敏"）',
    crossOrder.status === 201 && /妈妈/.test(crossOrder.body?.tasteWarning?.text ?? ''),
    `status=${crossOrder.status} warning=${JSON.stringify(crossOrder.body?.tasteWarning)}`)

  /*
   * 而"一个人都没写过"时**什么都不说**：那才是文件头 ③ 说的"不假装有保护"。
   * 单独建一个空档案的家来验——用上面那个家验不了（妈妈写过）。
   */
  const stranger = await register('陌生人')
  await callRetry('POST', '/family', { token: stranger.token, body: { name: '没人写档案的家' } })
  const bare = await callRetry('POST', '/orders/items', {
    token: stranger.token,
    body: peanutDish
      ? { recipeId: peanutDish.id, mealDate: new Date().toISOString().slice(0, 10), meal: 'DINNER' }
      : { dishName: '随便一道', mealDate: new Date().toISOString().slice(0, 10), meal: 'DINNER' },
  })
  check('**一个人都没写过档案时，一句提醒都没有**（不假装有保护）',
    bare.status === 201 && !bare.body?.tasteWarning,
    `status=${bare.status} warning=${JSON.stringify(bare.body?.tasteWarning)}`)

  // ---------- ③ F5-03 推荐过滤（真模型） ----------
  /*
   * 判据：让妈妈对**库里最常见的两样**过敏，然后要 AI 推荐，返回的菜名/理由里
   * 不该出现那两样对应的菜。这里用"花生"与"虾"——库里量够大，不排掉的话
   * 模型很容易挑到。
   */
  await callRetry('PATCH', '/taste', { token: mama.token, body: { allergies: ['花生', '虾'] } })
  console.log('\n（要等真模型推荐，可能要一会儿…）')
  const suggest = await callRetry('POST', '/ai/suggest', { token: mama.token, body: { hint: '想吃点下饭的' } })
  const picks = suggest.body?.picks ?? []
  check('推荐接口通（含口味过滤那一段）', suggest.status === 201 || suggest.status === 200, `status=${suggest.status} body=${JSON.stringify(suggest.body)?.slice(0, 160)}`)

  // 逐条回查配料表：**推荐的菜里不能有过敏原**（这是这一整块最硬的一条）
  const offenders = []
  for (const pick of picks) {
    const detail = await callRetry('GET', `/recipes/${pick.recipeId}`, { token: mama.token })
    const names = (detail.body?.ingredients ?? []).map((item) => item.name).join('、')
    if (/花生|虾/.test(names)) offenders.push(`${pick.name}（${names}）`)
  }
  check('**推荐的菜里一个过敏原都没有**（F5-03 过滤真的生效了）',
    picks.length > 0 && offenders.length === 0,
    `推荐 ${picks.length} 道，命中=${offenders.join(' | ') || '无'}`)

  for (const item of results) console.log(`${item.ok ? '✅' : '❌'} ${item.name}${item.detail ? `  — ${item.detail}` : ''}`)
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  if (failed) process.exitCode = 1
}

void main().catch((error) => { console.error(error); process.exitCode = 1 })
