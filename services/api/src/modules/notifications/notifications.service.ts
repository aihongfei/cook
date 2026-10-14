import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../recipes/prisma.service'
import { MEAL_LABEL, dateKey, dayWindow, visibleToMember } from '../orders/orders.rules'
import type { FamilyRole } from '../family/family.roles'
import { expiryState } from '../fridge/fridge.rules'
import { digest, randomToken } from '../auth/token'
import {
  buildNotifications, dateKey as calendarKey, dedupeKeyOf, mergeStored, PREP_WINDOW_DAYS, unreadByArea, unreadCount,
  type DoneFact, type FridgeFact, type NotificationInput, type NotificationItem, type NotificationKind,
  type NotificationPrefs, type PlanFact, type PrepFact, type NotificationRow,
} from './notifications.rules'
import { PATROL_MAX_ITEMS, nextSince, notifyIdOf, pickPatrolItems, type PatrolItem } from './patrol.rules'

/** 通知里往上翻多久（天）。见 `list()` 里那段说明 */
const LOOKBACK_DAYS = 30

/**
 * 「今天/明天/后天」这三档有几档。
 *
 * 单独起个名字，而**不是**复用 `PREP_WINDOW_DAYS`：那两件事凑巧都是 3，
 * 但一个是"备菜提醒看几天"（产品判断），一个是"日期有相对说法的最小窗口"
 * （`dayWindow` 只给前三天起相对名字）。共用会让改其中一个时把另一个带偏。
 */
const RELATIVE_DAY_SPAN = 3

/**
 * 消息提醒（M10）。口径见 D-078。
 *
 * ## 这个模块**不存通知**，只存用户的偏好
 *
 * 四条提醒全部由已有数据现算（详见 `notifications.rules` 文件头）。这里负责把事实查出来、
 * 套上可见性口径、交给纯规则去组装——**"什么算一条提醒"这件事只写在纯规则里**，
 * 所以它能被测到，也不会与别处的口径漂移。
 *
 * ## 可见性跟点单同一条（不另立一套）
 *
 * 共享开关关掉时，吃货看不到自己没参与的餐（D-024）——通知也必须守同一条：
 * 否则"通知说这一餐做好了、点进去却看不到这一餐"本身就自相矛盾。
 * 所以范围判据直接复用 `visibleToMember`，**不自己写一遍**。
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 我的偏好；没有行就按默认全开（**不是**"没同意过"——见 schema 里那段说明） */
  async prefs(userId: string): Promise<NotificationPrefs> {
    const row = await this.prisma.notificationPref.findUnique({ where: { userId } })
    return {
      mealPlan: row?.mealPlan ?? true,
      mealDone: row?.mealDone ?? true,
      expiry: row?.expiry ?? true,
      prep: row?.prep ?? true,
    }
  }

  /**
   * 通知中心 + 红点共用这一个接口。
   *
   * 红点要的是那个数、通知中心要的是列表，**两处不能各算一遍**：各算一遍就会出现
   * "红点说 2 条、点进去看到 1 条"（本项目在采购清单的计数上踩过，见 D-059 三）。
   * 所以 `unread` 与 `items` 由同一次调用一起给出，`unreadByKind` 也是同一份数据的投影。
   */
  async list(userId: string) {
    const membership = await this.prisma.familyMember.findUnique({ where: { userId } })
    if (!membership) throw new NotFoundException('先加入家庭，才有家里的消息')
    const { familyId, role } = membership
    const family = await this.prisma.family.findUnique({ where: { id: familyId } })
    if (!family) throw new NotFoundException('家庭不存在')

    const prefs = await this.prefs(userId)
    const scope = visibleToMember(family.shared, role as FamilyRole)
    const now = new Date()
    const today = calendarKey(now)
    const since = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - LOOKBACK_DAYS))

    const meals = await this.prisma.mealOrder.findMany({
      where: { familyId, mealDate: { gte: since } },
      include: {
        items: { include: { user: { select: { nickname: true } } } },
        confirmedBy: { select: { nickname: true } },
        doneBy: { select: { nickname: true } },
      },
    })

    // 共享关闭时只留我参与的餐（我点过菜的、或我标成做好的）——与 `GET /orders` 同一口径
    const visible = meals.filter(
      (meal) => scope === 'family' || meal.items.some((item) => item.userId === userId) || meal.doneById === userId,
    )

    const window = dayWindow(PREP_WINDOW_DAYS, now)
    const named = dayWindow(RELATIVE_DAY_SPAN, now)
    /** 「今天晚餐」；超出 3 天窗口的写「10月9日晚餐」（不编一个"周五"——那是最近邻的叫法） */
    const labelOf = (mealDate: Date, meal: 'LUNCH' | 'DINNER'): string => {
      const key = dateKey(mealDate)
      const hit = named.find((day) => day.value === key)
      if (hit) return `${hit.label}${MEAL_LABEL[meal]}`
      const [, month, day] = key.split('-')
      return `${Number(month)}月${Number(day)}日${MEAL_LABEL[meal]}`
    }

    const plan: PlanFact[] = visible
      .filter((meal) => meal.confirmedAt !== null && meal.status !== 'CANCELED')
      .map((meal) => ({
        mealKey: `${dateKey(meal.mealDate)}-${meal.meal}`,
        byName: meal.confirmedBy?.nickname ?? '家里人',
        byMe: meal.confirmedById === userId,
        at: meal.confirmedAt as Date,
        whenLabel: labelOf(meal.mealDate, meal.meal),
        dishCount: meal.items.length,
      }))

    /*
     * 「饭已做好」只给**我点过菜**的那些餐（F10-02 的原文就是"通知点单人"）：
     * 没点这道菜的人不必知道这一餐做好了——他没在等这顿饭。
     */
    const done: DoneFact[] = visible
      .filter((meal) => meal.status === 'DONE' && meal.doneAt !== null)
      .map((meal) => ({
        mealKey: `${dateKey(meal.mealDate)}-${meal.meal}`,
        byName: meal.doneBy?.nickname ?? '家里人',
        byMe: meal.doneById === userId,
        at: meal.doneAt as Date,
        whenLabel: labelOf(meal.mealDate, meal.meal),
        myDishes: [...new Set(meal.items.filter((item) => item.userId === userId).map((item) => item.recipeName))],
      }))
      // 「没点过这一餐的不提醒」那一条判据在纯规则里（见 notifications.rules）——这里只管把事实取齐

    /*
     * 快过期：只取**有保质期**的（`expiresOn` 可空，没写保质期不是"不会坏"，见 F6-05），
     * 并按 `expiryState` 筛进提醒窗口——与冰箱页那四区同一判据，不另立一套阈值。
     */
    const fridge: FridgeFact[] = (
      await this.prisma.fridgeItem.findMany({
        where: { familyId, ...(scope === 'mine' ? { addedById: userId } : {}) },
        select: { id: true, name: true, expiresOn: true, createdAt: true },
      })
    )
      .filter((row) => row.expiresOn !== null && expiryState(row.expiresOn, now) !== null)
      .map((row) => ({ id: row.id, name: row.name, expiresOn: row.expiresOn as Date, createdAt: row.createdAt }))

    /*
     * 该备菜了：接下来 3 天里还**一道菜都没有**的餐次。
     *
     * 只要"这一餐空着"就算（不区分"没点过"与"点过又删光了"——对要备菜的人来说是同一件事）。
     * 已做好的更不算：那是过去的事。
     */
    const prep: PrepFact[] = []
    for (const day of window) {
      for (const meal of ['LUNCH', 'DINNER'] as const) {
        const row = visible.find((item) => dateKey(item.mealDate) === day.value && item.meal === meal)
        if (row && (row.items.length > 0 || row.status === 'DONE' || row.status === 'CANCELED')) continue
        prep.push({ dateLabel: day.label, mealLabel: MEAL_LABEL[meal], mealKey: `${day.value}-${meal}` })
      }
    }

    const input: NotificationInput = {
      today,
      prefs: { mealPlan: prefs.mealPlan, mealDone: prefs.mealDone, expiry: prefs.expiry, prep: prefs.prep },
      plan,
      done,
      fridge,
      prep,
    }
    /*
     * ① 把"现在算出来的"写进事件日志（有明确时刻的、与状态型的，两种懒补方式见那个方法），
     * ② 再**从库里读回来**——列表与已读都以库里那份为准。
     *
     * 为什么必须先写再读：日志要留下**事件发生的那一刻**（而不是"他第一次打开通知中心的那一刻"）。
     * 菜单是今天下午定的、用户明天才打开 App，那条日志的时间必须是今天下午。
     * 所以这一步不放在"打开通知中心"里，而是每次取通知时顺手补齐（`upsert` 幂等，重复读不会写重）。
     */
    const items = buildNotifications(input, now)
    await this.recordEvents(userId, familyId, items)

    const stored = await this.prisma.notificationEvent.findMany({
      where: { userId },
      orderBy: { at: 'desc' },
      take: 200,
    })
    const byKey = new Map(stored.map((row) => [row.dedupeKey, {
      dedupeKey: row.dedupeKey,
      title: row.title,
      body: row.body,
      toPath: row.toPath,
      at: row.at,
      readAt: row.readAt,
    }]))

    // 库里那句优先（如实回放"当时那句话"），已读只认库里的 `readAt`
    const rows = mergeStored(items, byKey, userId)

    return {
      items: rows,
      /** 红点用这个数（**不是** `items.length`：已读的还要能翻回去看） */
      unread: unreadCount(rows),
      unreadByArea: unreadByArea(rows),
      /** 四条提醒各自的未读数（通知中心里按类看） */
      unreadByKind: countByKind(rows),
      prefs: { mealPlan: prefs.mealPlan, mealDone: prefs.mealDone, expiry: prefs.expiry, prep: prefs.prep },
    }
  }

  /**
   * 把当前这批提醒补进事件日志。
   *
   * **幂等靠 `dedupeKey` 的唯一约束**（不是"先查一下有没有再写"）：
   * 并发两次请求各查一次、都发现没有、然后各写一条——本项目在"并发的两次点菜各建一餐"
   * 上正是靠唯一约束兜住的（`@@unique([familyId, mealDate, meal])`）。
   * 所以这里用 `createMany({ skipDuplicates: true })`，重复的直接丢掉。
   *
   * 两类时刻的处理不一样：
   * - **有明确时刻的**（菜单定下来、饭做好了）：`at` 取事实本身的时刻，
   *   于是"下午定的菜单"记的是下午，而不是"他晚上才打开 App"；
   * - **状态型的**（快过期、该备菜）：没有"发生的那一刻"（它是"现在这个状态"），
   *   按天懒补一条、`at` 取那一刻的锚点（`item.at` 已经是算好的锚点）。
   *   语义是诚实的："那天你看到时，确实有东西快过期"——哪怕那盒奶后来被喝了。
   */
  private async recordEvents(userId: string, familyId: string, items: NotificationItem[]) {
    if (items.length === 0) return
    await this.prisma.notificationEvent.createMany({
      data: items.map((item) => ({
        userId,
        familyId,
        kind: item.kind,
        title: item.title,
        body: item.body,
        toPath: item.to,
        at: new Date(item.at),
        dedupeKey: dedupeKeyOf(item.id, userId),
      })),
      skipDuplicates: true,
    })
  }

  /**
   * 读过**一条**（点开它跳走时调用）。
   *
   * 用 `dedupeKey` 定位而不是行 id：那一条的 key 是"这件事 + 我"，
   * 前端手里拿的正是它（列表渲染用的就是同一个 id）——省掉一次 id→key 的映射。
   * 找不到时**不报错**：可能是另一台设备刚读到、也可能是这一条已经被清理了，
   * 那时"标记已读"这个动作本身没有意义，但不是错误。
   */
  async markRead(userId: string, rawKey: unknown) {
    const key = typeof rawKey === 'string' && rawKey.trim() ? rawKey.trim() : null
    if (!key) throw new BadRequestException('要标已读哪一条')
    const updated = await this.prisma.notificationEvent.updateMany({
      /*
       * 键必须用 `dedupeKeyOf` 拼（前端给的是**列表里那条的 id**）。
       * 第一版直接拿 id 去比 `dedupeKey`，于是永远匹配不到、`read: 0`——
       * 真实请求一跑就露出来了（同一类错误这一轮犯了两次：写入/读回、标已读，
       * 都源于"两边各拼一次键"，所以现在只剩这一个函数拼键）。
       * 仍然显式带上 `userId`：只能标自己的。
       */
      where: { dedupeKey: dedupeKeyOf(key, userId), userId, readAt: null },
      data: { readAt: new Date() },
    })
    return { read: updated.count }
  }

  /**
   * 一键已读（F10-04 的"全部标记已读"）。
   *
   * 只把**用户当前看得到的那一批**标掉（`keys` 由前端从列表里给过来），
   * 而不是"把这个账号所有未读都标掉"——后者会把他在别的页面上还没看到过的东西
   * 一起吞掉（"我明明没看过那条，它怎么就没了"）。
   */
  async markAllRead(userId: string, rawKeys: unknown) {
    const keys = Array.isArray(rawKeys) ? rawKeys.filter((key): key is string => typeof key === 'string' && key !== '') : []
    if (keys.length === 0) throw new BadRequestException('没有要标已读的')
    const updated = await this.prisma.notificationEvent.updateMany({
      // 同样用共用的键函数（见 `markRead` 里那段说明）
      where: { userId, readAt: null, dedupeKey: { in: keys.map((key) => dedupeKeyOf(key, userId)) } },
      data: { readAt: new Date() },
    })
    return { read: updated.count }
  }

  /** 改四个开关（只改传了的那些；没传的保持原值） */
  async updatePrefs(userId: string, patch: Partial<Pick<NotificationPrefs, 'mealPlan' | 'mealDone' | 'expiry' | 'prep'>>) {
    const row = await this.prisma.notificationPref.upsert({
      where: { userId },
      create: { userId, ...patch },
      update: patch,
    })
    return { mealPlan: row.mealPlan, mealDone: row.mealDone, expiry: row.expiry, prep: row.prep }
  }

  /**
   * 发一枚**巡查令牌**给这台手机（M10 交付三）。
   *
   * 后台那段代码没有登录会话，必须有自己的凭据——为什么不能借用刷新令牌，
   * 见 `schema.prisma` 里 `NotificationPatrolToken` 那段说明（一句话：
   * 刷新令牌一用就轮换，后台拿它续期会把用户当场登出）。
   *
   * **按"账号 + 设备"记一行**：同一台手机重登只换自己那一行，**不会顶掉家里另一台**
   * （第一版按账号唯一，那会让第二台手机一登录就把第一台静默废掉——见 schema 里的说明）。
   */
  async issuePatrol(userId: string, rawDeviceId: unknown, rawDevice: unknown) {
    const deviceId = typeof rawDeviceId === 'string' && rawDeviceId.trim() ? rawDeviceId.trim().slice(0, 64) : null
    if (!deviceId) throw new BadRequestException('缺少设备标识')
    const device = typeof rawDevice === 'string' && rawDevice.trim() ? rawDevice.trim().slice(0, 64) : null

    const token = randomToken()
    const expiresAt = new Date(Date.now() + PATROL_TTL_DAYS * 24 * 60 * 60 * 1000)
    await this.prisma.notificationPatrolToken.upsert({
      where: { userId_deviceId: { userId, deviceId } },
      create: { userId, deviceId, tokenHash: digest(token), expiresAt, device },
      // 换新令牌时顺带把吊销状态清掉（重新登录 = 重新授权这台手机）
      update: { tokenHash: digest(token), expiresAt, device, revokedAt: null },
    })
    return { token, expiresAt: expiresAt.toISOString() }
  }

  /**
   * 吊销（退出登录时调）。
   *
   * 给了 `deviceId` 就只吊销那一台（用户在这台手机上点了退出，家里的平板不该跟着哑掉）；
   * 没给就吊销这个账号的全部（"退出所有设备"的语义，与 `logout` 里那条一致）。
   */
  async revokePatrol(userId: string, rawDeviceId: unknown) {
    const deviceId = typeof rawDeviceId === 'string' && rawDeviceId.trim() ? rawDeviceId.trim() : null
    const result = await this.prisma.notificationPatrolToken.updateMany({
      where: { userId, revokedAt: null, ...(deviceId ? { deviceId } : {}) },
      data: { revokedAt: new Date() },
    })
    return { revoked: result.count }
  }

  /**
   * 手机在后台巡查一次：**只要"取过之后又发生的事"**。
   *
   * 口径与通知中心**完全同一条**（直接调 `list()`，不另查一遍）：那些句子、那些去处
   * 都由同一份实现产出，所以手机弹出来的话与用户点进应用看到的**一模一样**。
   *
   * 三条刻意的：
   * - **第一次（没有 `since`）一条都不弹**：那种"新"是伪新（历史会一次性糊到脸上），
   *   而且此刻用户本来就在看着应用（见 `patrol.rules`）；
   * - **最多弹 `PATROL_MAX_ITEMS` 条**，取最新的那些；其余仍在应用内的通知中心里，
   *   不丢、只是不弹——一次刷一屏只会让人把通知全划掉；
   * - `since` **推进到全部提醒里最新的那个时刻**（不是"弹出去的这几条里最新的"）：
   *   否则被上限挡下的那些会在下一次巡查时变成"新的"再弹一轮，连着弹四十分钟。
   */
  async patrol(userId: string, rawSince: unknown): Promise<{ items: PatrolItem[]; since: string | null; unread: number }> {
    const since = parseSince(rawSince)
    const board = await this.list(userId)

    const picked = pickPatrolItems(board.items, since, PATROL_MAX_ITEMS)
    const next = nextSince(board.items, since)

    await this.prisma.notificationPatrolToken.updateMany({
      where: { userId },
      data: { lastUsedAt: new Date() },
    })

    return {
      items: picked.map((item) => ({
        id: item.id,
        title: item.title,
        body: item.body,
        to: item.to,
        at: item.at,
        tag: item.tag,
        // 数字 id 由这一侧算好（那段后台代码 import 不了我们的前端模块，见 patrol.rules）
        notifyId: notifyIdOf(item.id),
      })),
      since: next ? next.toISOString() : null,
      unread: board.unread,
    }
  }
}

/** 巡查令牌有效期（30 天，与刷新令牌同数） */
const PATROL_TTL_DAYS = 30

/**
 * 解析手机带回来的 `since`。
 *
 * **坏的、看不懂的一律当"没有"**（返回 null）：那会退回"这次一条都不弹"，
 * 比"按一个看不懂的时刻去比"安全——后者可能把十几条历史当成新的全弹出来。
 */
function parseSince(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? new Date(parsed) : null
}

/** 按 kind 数未读（各 Tab 的红点各取自己那一项，取不到就是 0） */
function countByKind(rows: NotificationRow[]): Partial<Record<NotificationKind, number>> {
  const counts: Partial<Record<NotificationKind, number>> = {}
  for (const row of rows) {
    if (!row.unread) continue
    counts[row.kind] = (counts[row.kind] ?? 0) + 1
  }
  return counts
}
