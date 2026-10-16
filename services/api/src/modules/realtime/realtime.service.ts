import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { WebSocket, WebSocketServer } from 'ws'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { PrismaService } from '../recipes/prisma.service'
import { digest } from '../auth/token'
import { HEARTBEAT_MS, MAX_CONNECTIONS_PER_USER, REALTIME_PATH, originAllowed } from './realtime.rules'

/** 挂在 ws 上的自留字段：这一轮心跳里它回过话没有 */
interface Live extends WebSocket {
  isAlive?: boolean
}

/**
 * 实时通道（M10 交付五 / F10-08）：应用开着时，家里发生的变动**当场**推到那台设备上。
 *
 * ## 这一层是**纯管道**，不认识"通知"
 *
 * 它只管三件事：谁能连（鉴权）、连着的现在有几条（连接表）、给谁推一条什么样的消息
 * （`signal`）。**消息长什么样、什么时候该发，是业务侧的事**——`NotificationsService`
 * 发的是 `{ type: 'changed', area }`，那是它定义的协议（见那边的说明）。
 *
 * 这样分开的好处是将来换实现只动这一个文件：真到了多实例部署那天，
 * 把 `signal()` 里的"就地扇出"换成"publish 到 Redis、各实例订阅后推本机连接"，
 * 业务侧与前端一行都不改（见 `realtime.rules` 文件头那段）。
 *
 * ## 两条凭据都收（各有一个非它不可的场景）
 *
 * - **`?t=<登录令牌>`**：应用前台那条路（WebView 里的 `WebSocket`）。就用登录令牌——
 *   那个连接的生命周期本来就跟着前台会话走，重连时从 auth store 现取；
 * - **`?p=<巡查令牌>`**：**原生服务**那条路（Android 前台服务里的 OkHttp）。它**不能**用登录
 *   令牌：那是 2 小时就过期的，而这条连接要跨着后台活几个小时甚至几天。
 *   巡查令牌正是为"没有 WebView 会话的长期只读凭据"设计的（见 `schema.prisma` 那段说明），
 *   所以直接复用——**不为实时通道另造一种令牌**（那是同一个问题在第二处的答案）。
 *
 * ## 一个如实的取舍：连上之后不再管令牌过期
 *
 * WebSocket 是长连接，握手那一刻验过就算数；登录令牌 2 小时后过期时，
 * **已经连上的这条不会因此断开**（它不再经过 HTTP 鉴权）。这是刻意的：
 * 断掉它需要服务端自己起一个定时器去追每条连接的令牌到期时间，而收益是零
 * ——能连上的人本来就持有有效凭据，他手里的会话到期后**重连会失败**，
 * 那条路是通的。真被吊销（退出登录、改密码）时靠的是巡查令牌那一路的 `revokedAt`，
 * 而登录令牌那一路最多活到下一次重连。
 */
@Injectable()
export class RealtimeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeService.name)
  /** userId → 这台账号现在开着的连接 */
  private readonly online = new Map<string, Set<Live>>()
  private wss: WebSocketServer | null = null
  private timer: NodeJS.Timeout | null = null
  private upgradeListener: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  /**
   * 挂到**既有那个 http server** 上（`upgrade` 事件），不新开端口。
   *
   * 这一点对部署很实在：容器只暴露 3000，nginx 只转 3000，WebSocket 走的是同一条路
   * （协议升级是 HTTP 层的，同一端口天然支持）。新开端口的话每加一个环境都要改两处配置
   * ——而那正是"本机好好的、服务器上连不上"的经典成因。
   */
  onApplicationBootstrap(): void {
    const server = this.adapterHost.httpAdapter?.getHttpServer() as Server | undefined
    if (!server || typeof server.on !== 'function') {
      // 起不来也不该让整个服务起不来：实时只是"更快"，其余接口照常
      this.logger.warn('拿不到 http server，实时通道未启用（通知仍会在下次刷新时到）')
      return
    }

    this.wss = new WebSocketServer({ noServer: true })
    this.upgradeListener = (request, socket, head) => {
      void this.handleUpgrade(request, socket, head)
    }
    server.on('upgrade', this.upgradeListener)

    this.timer = setInterval(() => this.sweep(), HEARTBEAT_MS)
    // 别让这个定时器把进程拖住（关停时要能干净退出）
    this.timer.unref?.()

    this.logger.log(`实时通道已挂载：${REALTIME_PATH}（心跳 ${HEARTBEAT_MS / 1000}s）`)
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const sockets of this.online.values()) {
      for (const socket of sockets) socket.close()
    }
    this.online.clear()
    this.wss?.close()
    this.wss = null
  }

  /** 现在连着几条（不给 `userId` 就是全部）。测试与排查用，不是业务接口。 */
  onlineCount(userId?: string): number {
    if (userId) return this.online.get(userId)?.size ?? 0
    let total = 0
    for (const sockets of this.online.values()) total += sockets.size
    return total
  }

  /**
   * 给这几个账号推一条消息，返回**实际发出去的条数**。
   *
   * 不抛错：推送是"更快"，不是"必须到"——收件人没连（应用关着、或者在后台被系统冻住）
   * 就从 0 条发出去，那件事**仍然在库里**，他下次打开应用/巡查时照旧看得到。
   * 这条口径与巡查那条同源（那边也是"没取到就下次再取"，见 `patrol.rules`）。
   */
  signal(userIds: string[], message: unknown): number {
    if (!this.wss || userIds.length === 0) return 0
    const payload = JSON.stringify(message)
    let sent = 0
    for (const userId of userIds) {
      const sockets = this.online.get(userId)
      if (!sockets) continue
      for (const socket of sockets) {
        if (socket.readyState !== WebSocket.OPEN) continue
        socket.send(payload)
        sent += 1
      }
    }
    return sent
  }

  // ---------------------------------------------------------------- 握手与鉴权

  private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost')

    if (url.pathname !== REALTIME_PATH) {
      /*
       * 不是我们的路径就把这条 socket 收掉：`noServer: true` 模式下没人会处理它，
       * 留着会变成一个永远不响应的连接（客户端那边表现是"一直在连"）。
       */
      socket.destroy()
      return
    }

    const allowed = this.allowedOrigins()
    if (!originAllowed(request.headers.origin, allowed)) {
      this.refuse(socket, 403, 'origin not allowed')
      return
    }

    let userId: string | null = null
    try {
      userId = await this.identify(url)
    } catch (error) {
      this.logger.warn(`实时通道鉴权出错：${String(error)}`)
    }
    if (!userId) {
      this.refuse(socket, 401, 'unauthorized')
      return
    }
    if (socket.destroyed) return

    this.wss?.handleUpgrade(request, socket, head, (ws) => this.attach(userId as string, ws as Live))
  }

  /**
   * 认人：登录令牌（`t`）或巡查令牌（`p`），两条路各自的判据与对应的守卫**同一套**
   * （登录那条用 `JwtService.verifyAsync`、巡查那条按 `tokenHash` 查表并看吊销/过期）。
   */
  private async identify(url: URL): Promise<string | null> {
    const access = url.searchParams.get('t')
    if (access) {
      try {
        const payload = await this.jwt.verifyAsync<{ sub?: string }>(access)
        return payload.sub ?? null
      } catch {
        return null
      }
    }

    const patrol = url.searchParams.get('p')
    if (patrol) {
      const row = await this.prisma.notificationPatrolToken.findUnique({ where: { tokenHash: digest(patrol) } })
      if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now()) return null
      return row.userId
    }

    return null
  }

  private attach(userId: string, socket: Live): void {
    let sockets = this.online.get(userId)
    if (!sockets) {
      sockets = new Set()
      this.online.set(userId, sockets)
    } else if (sockets.size >= MAX_CONNECTIONS_PER_USER) {
      /*
       * 超上限就**拒绝新的**，不去挤掉最旧那条。
       *
       * 第一版写的是"挤掉最旧的"（理由是新连接多半是用户正看的那台），实测下来它是错的：
       * 被挤掉的那台断了会重连、重连又挤掉下一条，几台机器互相踢成一个**稳定的风暴**
       * （日志里同一账号每两秒接入一次、永远是满的）。而"拒绝新的"只会让那台连不上的
       * 按退避重试（最多 15 秒一次），已经在用的几台一条都不受影响。
       *
       * 僵尸连接不靠这个上限清：心跳（30 秒一轮）会把不回话的直接掐掉，
       * 所以上限只是"防跑飞"的兜底，不是常规回收手段。
       */
      socket.close(1013, 'too many connections')
      this.logger.warn(`实时通道拒绝接入：${userId} 已有 ${sockets.size} 条（上限 ${MAX_CONNECTIONS_PER_USER}）`)
      return
    }

    sockets.add(socket)
    socket.isAlive = true
    socket.on('pong', () => {
      socket.isAlive = true
    })
    socket.on('close', () => {
      const set = this.online.get(userId)
      if (!set) return
      set.delete(socket)
      if (set.size === 0) this.online.delete(userId)
    })
    // 客户端一般不发消息（这是单向的"推"通道）；发什么都不理，但别让它变成未处理事件
    socket.on('message', () => {})
    socket.on('error', () => {
      // 连接层的错误（对端猝死、网络重置）在这里收掉即可，不往上抛
    })

    this.logger.log(`实时通道接入：${userId}（现有 ${sockets.size} 条）`)
  }

  /** 掐掉那些**上一轮心跳没回话**的连接（对端早就没了，但 TCP 还以为在） */
  private sweep(): void {
    for (const sockets of this.online.values()) {
      for (const socket of sockets) {
        if (socket.isAlive === false) {
          socket.terminate()
          continue
        }
        socket.isAlive = false
        try {
          socket.ping()
        } catch {
          socket.terminate()
        }
      }
    }
  }

  private refuse(socket: Duplex, status: number, reason: string): void {
    try {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
    } catch {
      // 对端已经走了：下面那行 destroy 照样要做
    }
    socket.destroy()
  }

  private allowedOrigins(): string[] {
    const raw = process.env.CORS_ORIGIN
    if (!raw) return ['*']
    return raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  }
}
