/*
 * 后台巡查（M10 交付三）——**跑在系统调度器里的那段 JS**。
 *
 * ## 这个文件在哪跑、为什么不 import 任何东西
 *
 * 它被 @capacitor/background-runner 用一个独立的 JS 引擎执行（不进 WebView、没有页面、
 * 也没有我们的前端模块）。所以：**不能 import、不能读 localStorage、不能碰 DOM**。
 * 能用的只有引擎内置的一小撮：`console`、`fetch`、`setTimeout`、`TextEncoder` 之类，
 * 以及插件给的那几个对象（`CapacitorKV` / `CapacitorNotifications` / `CapacitorDevice`…）。
 *
 * ## 它做的一件事
 *
 * 系统每隔一段时间唤起它一次 → 它拿着"巡查令牌"问后端"我上次之后家里又发生了什么事"
 * → 有新的事就弹一条本机通知 → 把"这次取到哪儿"记回 KV。
 *
 * ## 三样东西都存在 KV 里（主应用读不到它，只能通过事件写给它）
 *
 * KV 是插件给这段代码的私有存储（SharedPreferences 按 runner label 命名）。
 * 主应用**读写不了**它，所以配置是靠 `dispatchEvent('patrolConfig', {...})` 送进来的
 * （见 `src/lib/patrol-sync.ts`）。键只有四个：
 * - `token`：巡查令牌（长期、只读、不轮换，见后端 schema 的说明）
 * - `apiBase`：后端地址（构建时注入，见 patrol-sync）
 * - `userId`：水位线按账号分开（换账号要重新立，不能把上一个人的旧事当新的弹）
 * - `since`：上次取到哪一刻（ISO）
 *
 * ## 一处如实的边界
 *
 * 用户点开这条通知**只能落到通知中心**：插件的点击意图里只带 `notificationId`，
 * 不带自定义路径（读了它的 Kotlin 源码确认过——`extra` 不进点击意图）。
 * 所以这里不假装能直达某一餐；落到通知中心，用户一眼看到那件事并点进去。
 */

/* eslint-disable no-undef -- 这段代码的运行时由插件提供（见文件头），不是浏览器也不是 Node */

var KV_CONFIG = 'patrol-config'
/** 单次弹的上限（与后端 PATROL_MAX_ITEMS 一致；后端也会截断，这里是双保险） */
var MAX_POP = 3

/**
 * 读一个 KV 值。
 *
 * ⚠️ **第一次运行时这里必然要处理"没有"**：插件的 Kotlin 侧签名是 `String?`，
 * 键不存在时它整个返回 null，于是 `CapacitorKV.get(k).value` 会抛
 * `cannot read property 'value' of null`——实测就是这么炸的（第一次 dispatchEvent
 * 直接把错误冒到主应用侧）。所以取值只有这一条路：**先判空，再看 `.value`**。
 */
function kvGet(key) {
  try {
    var result = CapacitorKV.get(key)
    if (!result) return null
    var value = result.value
    return typeof value === 'string' && value ? value : null
  } catch (error) {
    // 存储读不出来（引擎版本差异、首次运行）当"没有"：没有配置就什么都不做，
    // 而不是让这次巡查以一个错误结束。**但要留下痕迹**——排查时这段日志
    // 是"为什么它一条都不弹"的第一个线索
    console.log('patrol: KV 读不出来（当成没有）：' + String(error))
    return null
  }
}

function readConfig() {
  var raw = kvGet(KV_CONFIG)
  if (!raw) return null
  try {
    var parsed = JSON.parse(raw)
    return parsed && parsed.token && parsed.apiBase ? parsed : null
  } catch (error) {
    console.error('patrol: 配置读不出来，跳过这次巡查', error)
    return null
  }
}

function writeConfig(config) {
  CapacitorKV.set(KV_CONFIG, JSON.stringify(config))
}

/** 第一次巡查只立水位线、不弹（后端也是这么做的，见 patrol.rules） */
function loadConfig(args) {
  var incoming = (args && args.config) || {}
  var previous = readConfig()
  /*
   * 换账号（userId 变了）= 重新开始：不继承上一个人的水位线，
   * 也不继承他的任何东西——只留这台手机的配置位。
   */
  var sameUser = previous && incoming.userId && previous.userId === incoming.userId
  writeConfig({
    token: incoming.token || null,
    apiBase: incoming.apiBase || (previous ? previous.apiBase : null),
    userId: incoming.userId || null,
    since: sameUser ? previous.since : null,
  })
  console.log('patrol: 配置已更新（账号 ' + (incoming.userId || '无') + '）')
}

function tick(resolve) {
  var config = readConfig()
  if (!config) {
    // 没登录/没配置：什么都不做。这不是错误（退出登录之后就应该是这个状态）
    resolve({ skipped: 'no-config' })
    return
  }

  var url = config.apiBase + '/notifications/patrol' + (config.since ? '?since=' + encodeURIComponent(config.since) : '')

  fetch(url, { method: 'GET', headers: { 'x-patrol-token': config.token } })
    .then(function (response) {
      if (response.status === 401) {
        /*
         * 令牌失效（退出登录/被吊销/过期）：**把令牌清掉**，这样它不会每 15 分钟
         * 白问一次；下一次用户在应用里登录时 patrol-sync 会送来新的。
         */
        writeConfig({ token: null, apiBase: config.apiBase, userId: config.userId, since: null })
        return null
      }
      if (response.status !== 200) return null
      return response.json()
    })
    .then(function (body) {
      if (!body) {
        resolve({ skipped: 'not-ok' })
        return
      }
      var items = (body.items || []).slice(0, MAX_POP)
      if (items.length > 0) {
        CapacitorNotifications.schedule(
          items.map(function (item) {
            return {
              id: item.notifyId,
              title: item.title,
              body: item.body || '',
              /*
               * 走「家里的事」那个渠道（2026-10-16）。
               *
               * **必须指定**：不写就会落到插件自己那个叫 `default` 的渠道上，
               * 而它在系统设置里的名字就是 "Default"、说明栏空——vivo 要求
               * "把所有正在使用的本地通知渠道登记备案"，那种名字说不清发什么；
               * 用户看到也不知道该不该关。
               *
               * 这里**不能 import**（这段代码跑在独立的 JS 引擎里，见文件头），
               * 所以这个 id 是**第三份拷贝**：`NotifyChannels.java`（建）、
               * `lib/local-notify.ts`（做饭提醒用另一个）、以及这里。
               * 三处必须一致；改一处就要改三处。
               */
              channelId: 'family_events',
              // 排到"此刻"：插件的这条路径就是走系统闹钟（见 Notifications.kt），
              // 给当前时刻等于立刻弹
              scheduleAt: new Date(),
              autoCancel: true,
            }
          })
        )
        console.log('patrol: 弹了 ' + items.length + ' 条')
      }
      // 水位线以后端给的那个为准（两侧都是服务端时钟，不会被手机快慢影响）
      writeConfig({ token: config.token, apiBase: config.apiBase, userId: config.userId, since: body.since || config.since })
      resolve({ popped: items.length })
    })
    .catch(function (error) {
      // 网络不通是常态（地铁里、息屏省电），**不记错误也不清配置**：下一轮再试
      console.log('patrol: 这次没连上（' + String(error) + '），下一轮再试')
      resolve({ error: String(error) })
    })
}

addEventListener('patrolConfig', function (resolve, reject, args) {
  try {
    loadConfig(args)
    resolve()
  } catch (error) {
    reject(error)
  }
})

addEventListener('patrolTick', function (resolve, reject, args) {
  try {
    tick(resolve, reject, args)
  } catch (error) {
    reject(error)
  }
})
