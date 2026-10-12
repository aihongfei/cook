import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException, UnauthorizedException } from '@nestjs/common'
import {
  CHECKIN_MAX_BYTES,
  CHECKIN_NOTE_MAX,
  sniffImageType,
  buildHeatmap,
  dayKey,
  dayStart,
  extensionFor,
  heatLevel,
  heatmapStart,
  parseContentType,
  parseDayKey,
  parseNote,
  storedDayKey,
  streakOf,
} from '../src/modules/checkins/checkins.rules'
import { signedPhotoPath, verifyPhotoSignature, SIGNED_URL_TTL_SECONDS } from '../src/modules/checkins/checkins.signature'

// 打卡的纯规则（M9 / F9-03、F9-07；见 DECISIONS D-023）。
// 热力图与连续天数这类逻辑算错了界面不会报错、只会静静地显示假数据，所以这里逐个钉住。

// 签名测试需要 JWT_SECRET（真实值在 .env，测试里给一个足够长的假值）
process.env.JWT_SECRET ??= 'test-secret-that-is-long-enough-for-hmac-signing-32'

// ---------- 日期 ----------

test('打卡日按本地日历日，不随时区漂移', () => {
  // 本地 2026-03-01 00:30 与 23:30 必须是同一天（不能用 toISOString 那样按 UTC 切）
  assert.equal(dayKey(new Date(2026, 2, 1, 0, 30)), '2026-03-01')
  assert.equal(dayKey(new Date(2026, 2, 1, 23, 30)), '2026-03-01')
  // 月末/年末边界
  assert.equal(dayKey(new Date(2026, 11, 31, 23, 59)), '2026-12-31')
  assert.equal(dayKey(new Date(2027, 0, 1, 0, 1)), '2027-01-01')
})

test('打卡日：此刻用本地日历，入库值用 UTC 读回（两者是不同的东西）', () => {
  const previous = process.env.TZ
  process.env.TZ = 'Asia/Shanghai'
  try {
    const earlyMorning = new Date('2026-10-12T17:00:00Z') // 北京 10-13 01:00
    assert.equal(dayKey(earlyMorning), '2026-10-13', '凌晨打卡要算今天')
    // 入库值（UTC 零点）读回：与部署时区无关，永远是同一天
    assert.equal(storedDayKey(new Date('2026-10-13T00:00:00.000Z')), '2026-10-13')
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

test('日期字符串解析：只认 YYYY-MM-DD，非法值被拒', () => {
  assert.equal(dayKey(dayStart('2026-10-13')), '2026-10-13')
  assert.equal(parseDayKey('2026-10-13'), '2026-10-13')
  for (const bad of ['2026/10/13', '13-10-2026', '2026-1-3', '', undefined, null, 20261013]) {
    assert.throws(() => parseDayKey(bad), BadRequestException, `${String(bad)} 应被拒`)
  }
})

// ---------- 备注与图片 ----------

test('备注：空白等于没写，超长被拒', () => {
  assert.equal(parseNote('  给小满做的生日面  '), '给小满做的生日面')
  assert.equal(parseNote('   '), null)
  assert.equal(parseNote(undefined), null)
  assert.equal(parseNote('好'.repeat(CHECKIN_NOTE_MAX)), '好'.repeat(CHECKIN_NOTE_MAX))
  assert.throws(() => parseNote('好'.repeat(CHECKIN_NOTE_MAX + 1)), BadRequestException)
  assert.throws(() => parseNote(42), BadRequestException)
})

test('只收 JPEG / PNG / WebP（带 charset 之类的参数要能剥掉）', () => {
  assert.equal(parseContentType('image/jpeg'), 'image/jpeg')
  assert.equal(parseContentType('IMAGE/PNG'), 'image/png')
  assert.equal(parseContentType('image/webp;charset=binary'), 'image/webp')
  for (const bad of ['image/gif', 'image/svg+xml', 'text/html', '', undefined]) {
    assert.throws(() => parseContentType(bad), BadRequestException, `${String(bad)} 应被拒`)
  }
  assert.equal(extensionFor('image/jpeg'), 'jpg')
  assert.equal(extensionFor('image/webp'), 'webp')
})

test('单张照片上限 8MB', () => {
  assert.equal(CHECKIN_MAX_BYTES, 8 * 1024 * 1024)
})

test('按文件头认出真实图片类型，不是图片就拒绝', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)])
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)])
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)])
  assert.equal(sniffImageType(png), 'image/png')
  assert.equal(sniffImageType(jpeg), 'image/jpeg')
  assert.equal(sniffImageType(webp), 'image/webp')

  // 这些都不该被当成图片：HTML、纯文本、SVG（可能是脚本载体）、空、太短、截断的 PNG 头
  assert.equal(sniffImageType(Buffer.from('<html><body>hi</body></html>')), null)
  assert.equal(sniffImageType(Buffer.from('just some text')), null)
  assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null)
  assert.equal(sniffImageType(Buffer.alloc(0)), null)
  assert.equal(sniffImageType(Buffer.from([0x89, 0x50])), null)
  assert.equal(sniffImageType(Buffer.from('RIFFxxxxNOPE')), null)
})

// ---------- 热力图 ----------

test('热力等级：没打卡是 0，1/2/3 次逐级加深，4 次及以上最深', () => {
  assert.equal(heatLevel(0), 0)
  assert.equal(heatLevel(1), 1)
  assert.equal(heatLevel(2), 2)
  assert.equal(heatLevel(3), 3)
  assert.equal(heatLevel(4), 4)
  assert.equal(heatLevel(20), 4, '再多也不超过最深一档')
})

test('网格从本周一往前数 N 周开始（周一是第一天）', () => {
  // 2026-10-12 是周一
  const monday = new Date(2026, 9, 12)
  assert.equal(dayKey(heatmapStart(monday, 1)), '2026-10-12')
  assert.equal(dayKey(heatmapStart(monday, 2)), '2026-10-05')
  // 周三开始算：本周一仍是 10-12，不是周三
  assert.equal(dayKey(heatmapStart(new Date(2026, 9, 14), 1)), '2026-10-12')
  // 周日：仍属"本周"（周一为一周之首），起点不该滑到下周一
  assert.equal(new Date(2026, 9, 18).getDay(), 0, '2026-10-18 应是周日')
  assert.equal(dayKey(heatmapStart(new Date(2026, 9, 18), 1)), '2026-10-12')
})

test('热力图：每格一个日历日，最后一周不足 7 天也算一周', () => {
  const today = new Date(2026, 9, 14) // 周三
  const counts = new Map([
    ['2026-10-12', 1],
    ['2026-10-14', 3],
  ])
  const grid = buildHeatmap(counts, today, 2)

  assert.equal(grid.from, '2026-10-05')
  assert.equal(grid.to, '2026-10-14')
  assert.equal(grid.weeks.length, 2, '两周 = 两组')
  assert.equal(grid.weeks[0].length, 7)
  assert.equal(grid.weeks[1].length, 3, '最后一周只有周一到周三三天')

  const flat = grid.weeks.flat()
  assert.equal(flat[0].date, '2026-10-05')
  assert.equal(flat.at(-1)?.date, '2026-10-14')
  assert.equal(flat.find(cell => cell.date === '2026-10-12')?.level, 1)
  assert.equal(flat.find(cell => cell.date === '2026-10-14')?.level, 3)
  assert.equal(flat.find(cell => cell.date === '2026-10-13')?.level, 0, '没打卡的那天是 0 级，不能漏格')

  assert.equal(grid.totalCount, 4, '总张数 = 各天之和（1+3）')
  assert.equal(grid.totalDays, 2, '有打卡的天数（不是张数）')
})

test('热力图默认覆盖 18 周（约 4 个月，一屏放得下）', () => {
  const grid = buildHeatmap(new Map(), new Date(2026, 9, 14))
  assert.equal(grid.weeks.length, 18)
  assert.equal(grid.weeks.flat().length, 7 * 17 + 3)
  assert.equal(grid.totalCount, 0)
})

// ---------- 连续天数 ----------

test('连续天数：今天打了就该算今天', () => {
  const today = new Date(2026, 9, 14)
  const counts = new Map([
    ['2026-10-14', 2],
    ['2026-10-13', 1],
    ['2026-10-12', 1],
  ])
  assert.equal(streakOf(counts, today), 3)
})

test('连续天数：今天还没打，从昨天起算（下午看到"连续 5 天"不该掉成 0）', () => {
  const today = new Date(2026, 9, 14)
  const counts = new Map([
    ['2026-10-13', 1],
    ['2026-10-12', 1],
  ])
  assert.equal(streakOf(counts, today), 2)
})

test('连续天数：断一天就停，不把更早的记录接上去', () => {
  const today = new Date(2026, 9, 14)
  const counts = new Map([
    ['2026-10-12', 5],
    ['2026-10-11', 1],
    ['2026-10-10', 1],
  ])
  assert.equal(streakOf(counts, today), 0, '今天与昨天都没打 → 连续 0')
})

test('连续天数：跨月与跨年都能连', () => {
  const counts = new Map([
    ['2026-03-01', 1],
    ['2026-02-28', 1],
    ['2026-02-27', 1],
  ])
  assert.equal(streakOf(counts, new Date(2026, 2, 1)), 3, '跨月')

  const acrossYear = new Map([
    ['2027-01-01', 1],
    ['2026-12-31', 1],
  ])
  assert.equal(streakOf(acrossYear, new Date(2027, 0, 1)), 2, '跨年')
})

// ---------- 签名链接 ----------

test('签名链接：能被自己验过，且带上有效期', () => {
  const now = new Date('2026-10-12T10:00:00Z')
  const { path, expiresAt } = signedPhotoPath('ck-1', now)
  assert.ok(path.startsWith('/checkins/photos/ck-1?'), `路径形状不对：${path}`)
  assert.equal(expiresAt, Math.floor(now.getTime() / 1000) + SIGNED_URL_TTL_SECONDS)

  const url = new URL(path, 'http://localhost')
  assert.equal(url.searchParams.get('e'), String(expiresAt))
  verifyPhotoSignature('ck-1', url.searchParams.get('e'), url.searchParams.get('s'), now) // 不抛即通过
})

test('签名链接：改 id、改有效期、改签名都不能通过', () => {
  const now = new Date('2026-10-12T10:00:00Z')
  const { path } = signedPhotoPath('ck-1', now)
  const url = new URL(path, 'http://localhost')
  const expires = url.searchParams.get('e')!
  const signature = url.searchParams.get('s')!

  // 换一张照片的 id，但沿用原签名 → 必须失败（否则等于所有照片共用一张通行证）
  assert.throws(() => verifyPhotoSignature('ck-2', expires, signature, now), UnauthorizedException)
  // 改有效期以延长使用 → 失败
  assert.throws(() => verifyPhotoSignature('ck-1', String(Number(expires) + 86_400), signature, now), UnauthorizedException)
  // 乱写签名 → 失败
  assert.throws(() => verifyPhotoSignature('ck-1', expires, 'forged', now), UnauthorizedException)
  assert.throws(() => verifyPhotoSignature('ck-1', 'not-a-number', signature, now), UnauthorizedException)
  assert.throws(() => verifyPhotoSignature('ck-1', expires, '', now), UnauthorizedException)
})

test('签名链接：过期后拒绝（有效期是 24 小时）', () => {
  const now = new Date('2026-10-12T10:00:00Z')
  const { path } = signedPhotoPath('ck-1', now)
  const url = new URL(path, 'http://localhost')
  const expires = url.searchParams.get('e')!
  const signature = url.searchParams.get('s')!

  const justBefore = new Date((Number(expires) - 1) * 1000)
  verifyPhotoSignature('ck-1', expires, signature, justBefore) // 还没过期，通过

  const justAfter = new Date((Number(expires) + 1) * 1000)
  assert.throws(() => verifyPhotoSignature('ck-1', expires, signature, justAfter), UnauthorizedException)
})
