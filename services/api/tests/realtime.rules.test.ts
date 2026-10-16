import { strict as assert } from 'node:assert'
import test from 'node:test'
import { HEARTBEAT_MS, MAX_CONNECTIONS_PER_USER, REALTIME_PATH, originAllowed } from '../src/modules/realtime/realtime.rules'

/**
 * 实时通道的纯规则（F10-08）。
 *
 * 这一层只有两个判断，但两个都值得钉住：
 * - **来源白名单**：它决定"谁能从浏览器连上来"。写反了（该拒的放行）是安全问题，
 *   而写严了（该放行的拒掉）是"本机开发时怎么都连不上"——两头都难查；
 * - **那两个常量**：`REALTIME_PATH` 是前后端**各写一遍**的那个字符串
 *   （前端 `lib/realtime-sync.ts`、Android `RealtimeService.java`、这里），
 *   值一旦改了一处，表现是"连接被拒"而没有任何线索。所以把它写在测试里当契约。
 */

test('实时通道的路径是一个完整契约（三处必须一致）', () => {
  assert.equal(REALTIME_PATH, '/api/realtime')
  /*
   * 与全局前缀 `/api` 拼起来才是完整路径：Nest 的 `setGlobalPrefix('api')` 只作用于
   * HTTP 路由，而这条路径是我们自己在 `upgrade` 事件里比的——所以它必须自带 `/api`。
   * 忘了带的表现是"HTTP 接口都好好的，只有实时连接 404/被掐"。
   */
  assert.ok(REALTIME_PATH.startsWith('/api/'), '必须带上全局前缀（它不走 Nest 的路由表）')
})

test('没有 Origin 的客户端放行（原生那条路不带这个头）', () => {
  /*
   * Android 的 OkHttp 默认不带 `Origin`。**放行不等于没鉴权**：
   * 那条路拿的是巡查令牌，凭据才是判据（见 `realtime.service` 的 `identify`）。
   * 若在这里把"没有 Origin"当可疑拒掉，表现是"浏览器里好好的，一装到手机就收不到"。
   */
  assert.equal(originAllowed(undefined, ['http://127.0.0.1:5173']), true, '原生客户端不带 Origin')
  assert.equal(originAllowed('', ['http://127.0.0.1:5173']), true, '空串与没有同义')
})

test('配了白名单就按白名单', () => {
  const allowed = ['http://127.0.0.1:5173', 'http://localhost:5173']
  assert.equal(originAllowed('http://127.0.0.1:5173', allowed), true, '白名单里的放行')
  assert.equal(originAllowed('http://localhost:5173', allowed), true, '第二条也在白名单里')
  assert.equal(originAllowed('https://evil.example.com', allowed), false, '不在白名单里的拒掉')
  /*
   * **不做前缀匹配**：`http://127.0.0.1:5173.evil.com` 这种域名以前缀匹配会误放行。
   * 这一条钉住"比的是整个 Origin"。
   */
  assert.equal(originAllowed('http://127.0.0.1:5173.evil.com', allowed), false, '别用前缀匹配')
})

test('`*` 表示都行（本机开发与单机部署就是这个状态）', () => {
  assert.equal(originAllowed('http://anything.example.com', ['*']), true)
})

test('心跳与连接上限是"有界"的两个数', () => {
  /*
   * 心跳的意义是"认得出死连接"：太长则对方早就没了也要等很久才发现（那条连接期间
   * 推给它的消息全部石沉大海），太短则手机被频繁唤醒。30 秒是取中的那个值——
   * 这条断言不是"30 最好"，而是"别被随手改成 3 秒或 30 分钟"。
   */
  assert.ok(HEARTBEAT_MS >= 10_000 && HEARTBEAT_MS <= 120_000, `心跳 ${HEARTBEAT_MS}ms 落在合理区间`)

  /*
   * 上限是**防跑飞**用的（换账号、页面反复重载、写错的重连循环都可能留下僵尸连接）。
   * 定得比"一个账号真会开的设备数"高一点、又不能让一个账号占满整个连接表。
   */
  assert.ok(MAX_CONNECTIONS_PER_USER >= 2, '至少够"手机 + 平板"两台')
  assert.ok(MAX_CONNECTIONS_PER_USER <= 20, `上限 ${MAX_CONNECTIONS_PER_USER} 别大到失去意义`)
})
