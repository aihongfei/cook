import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../recipes/prisma.service'
import { RealtimeService } from '../realtime/realtime.service'
import { MEAL_LABEL, dateKey, dayWindow, mealWhenLabel, visibleToMember } from '../orders/orders.rules'
import type { FamilyRole } from '../family/family.roles'
import { expiryState } from '../fridge/fridge.rules'
import { digest, randomToken } from '../auth/token'
import {
  areaOfKind,
  buildChange, buildNotifications, dateKey as calendarKey, dedupeKeyOf, mergeStored, NOTIFICATION_PREF_KEYS, prefOfKind,
  PREP_WINDOW_DAYS, unreadByArea, unreadCount,
  type ChangeFact, type DoneFact, type FridgeFact, type NotificationArea, type NotificationInput, type NotificationItem,
  type NotificationKind, type NotificationPrefKey, type NotificationPrefs, type PlanFact, type PrepFact, type NotificationRow,
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
 * 消息提醒（M10）。口径见 D-078 与 `notifications.rules` 文件头。
 *
 * ## 这个模块不存"通知正文"的副本，存的是"发生过这件事"
 *
 * **状态型**那四类由已有数据现算（菜单定了 / 做好了 / 快过期 / 该备菜），
 * 所以那一半永远等于事实；**事件型**那六类（点菜、冰箱、打卡、评论、家庭、菜谱）
 * 说的是一件发生过就不在库里的事（撤了一道菜、从冰箱拿走一盒奶），
 * 只能由**做事的那一侧当场写下来**——入口就是本服务的 `recordChange`。
 *
 * 两条路的写法与理由见 `notifications.rules` 文件头那张表。
 *
 * ## 可见性跟点单同一条（不另立一套）
 *
 * 共享开关关掉时，吃货看不到自己没参与的餐（D-024）——通知也必须守同一条：
 * 否则"通知说这一餐做好了、点进去却看不到这一餐"本身就自相矛盾。
 * 所以范围判据直接复用 `visibleToMember`，**不自己写一遍**。
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /** 我的偏好；没有行就按默认全开（**不是**"没同意过"——见 schema 里那段说明） */
  async prefs(userId: string): Promise<NotificationPrefs> {
    const row = await this.prisma.notificationPref.findUnique({ where: { userId } })
    /*
     * 逐列写默认值，而**不是**"没行就返回一张常量表"：
     * 以后加开关时，这里漏一列会立刻表现为"那个开关永远是默认值"（改不动），
     * 而漏在常量表里则表现为"整个账号所有开关都回到默认"——后者更难查。
     * 两处都写不出来才是真的好，所以这里有单测钉住"九个键一个不少"。
     */
    return {
      mealPlan: row?.mealPlan ?? true,
      mealDone: row?.mealDone ?? true,
      expiry: row?.expiry ?? true,
      prep: row?.prep ?? true,
      orderChange: row?.orderChange ?? true,
      fridgeChange: row?.fridgeChange ?? true,
      checkin: row?.checkin ?? true,
      family: row?.family ?? true,
      recipe: row?.recipe ?? true,
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
    /*
     * 「今天晚餐」这个说法**只有一份**：`mealWhenLabel` 在 `orders.rules` 里，
     * 订单变动提醒（`orders.service`）也用同一个。两处各写一遍的话，
     * 同一天同一餐会在两条提醒里出现两种叫法（"后天晚餐" vs "10月18日晚餐"）。
     */
    const labelOf = (mealDate: Date, meal: 'LUNCH' | 'DINNER'): string =>
      mealWhenLabel(mealDate, meal, now, RELATIVE_DAY_SPAN)

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
      kind: row.kind,
      title: row.title,
      body: row.body,
      toPath: row.toPath,
      at: row.at,
      readAt: row.readAt,
      mealKey: row.mealKey,
      tag: row.tag,
    }]))

    /*
     * 库里那句优先（如实回放"当时那句话"），已读只认库里的 `readAt`。
     * **事件型那六类也从这一份里出来**（它们没有现算的对应条目），开关在这里再过一遍。
     */
    const rows = mergeStored(items, byKey, userId, prefs)

    return {
      items: rows,
      /** 红点用这个数（**不是** `items.length`：已读的还要能翻回去看） */
      unread: unreadCount(rows),
      unreadByArea: unreadByArea(rows),
      /** 各类提醒各自的未读数（通知中心里按类看） */
      unreadByKind: countByKind(rows),
      prefs,
    }
  }

  /**
   * 记下**刚刚发生的一件事**（事件型那六类的唯一入口，2026-10-16 加）。
   *
   * 谁来调：**做事的那一侧**（订单、冰箱、打卡、家庭、菜谱的写接口），
   * 在写完库、拿到返回之后顺手调一次。它拿不到"事实"就永远补不出来了
   * （撤掉的那道菜已经不在库里），所以这件事必须在**动作发生的那个请求里**做。
   *
   * 调用方只报"发生了什么"（`fact` + `actorId`）：**谁做的**由这里查出来补上、
   * **提醒谁**由这里扇出——这两件事在五个调用点完全一样，各写一遍就是五份会分叉的副本。
   *
   * ## 三件事由这一侧统一负责
   *
   * ① **扇出给全家人**（一人一行）：日志按账号存（已读也按账号），所以写入时扇出；
   * ② **不给做事的人自己写**（`actorId` 排除掉）——"自己做的事不必被告知"
   *    与 `plan`/`done` 的 `byMe` 是同一条规矩。同时**跳过关掉了这一类开关的人**：
   *    关掉期间不写，于是重新打开时不会涌出一批"我关掉那阵子发生的事"；
   * ③ **幂等**：靠 `dedupeKey` 的唯一约束 + `skipDuplicates`，重复调用不会写重
   *    （与 `recordEvents` 同一条：不靠"先查后写"，并发下那会写两条）。
   *
   * ## 调用方应当 `await` 它，但**不为它失败**
   *
   * 这一侧吞掉异常（通知是**副作用**：加菜已经成功了，不该因为"提醒写不进去"让用户
   * 看到一个报错、以为加菜失败而再点一次），所以调用方不必 try/catch；
   * 但**要 await**——先写完再回响应，客户端拿到"成功"时提醒已经在库里了。
   * 第一版让调用方 `void` 掉它（不等），后果是前端做完动作立刻重取通知时
   * 那几毫秒里还没有这一条：表现就是"我刚点的菜，通知里看不见"，
   * 要等下一次刷新才出现（`staleTime` 是 60 秒）。这正是本项目反复记过的
   * "页面上看不见刚发生的事"那一族（R-78）。
   * 代价是写接口多两三次小查询；比"用户以为功能没生效"便宜得多。
   */
  async recordChange(familyId: string, fact: ChangeFact, actorId: string): Promise<void> {
    try {
      // ① 家里除我之外的人 + ② 我叫什么（两个查询互不依赖，一起发）
      const [actor, members] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: actorId }, select: { nickname: true } }),
        this.prisma.familyMember.findMany({
          where: { familyId, userId: { not: actorId } },
          select: { userId: true },
        }),
      ])
      if (members.length === 0) return

      const item = buildChange(actor?.nickname ?? '家里人', fact)

      /*
       * 关掉这一类开关的人不写。
       * 一次把这些人的偏好查回来（九列布尔、几十字节），**不按 kind 动态挑列**：
       * 动态 select 在 Prisma 里要拼一个类型不定的对象，为此多一层间接不值得。
       */
      const prefKey = prefOfKind(item.kind)
      const off = await this.prisma.notificationPref.findMany({
        where: { userId: { in: members.map((member) => member.userId) }, [prefKey]: false },
        select: { userId: true },
      })
      const muted = new Set(off.map((row) => row.userId))
      const receivers = members.map((member) => member.userId).filter((id) => !muted.has(id))
      if (receivers.length === 0) return

      await this.prisma.notificationEvent.createMany({
        data: receivers.map((userId) => ({
          userId,
          familyId,
          kind: item.kind,
          title: item.title,
          body: item.body,
          toPath: item.to,
          mealKey: item.mealKey,
          tag: item.tag,
          at: new Date(item.at),
          dedupeKey: dedupeKeyOf(item.id, userId),
        })),
        skipDuplicates: true,
      })

      /*
       * ③ **当场推给正开着应用的那几台**（2026-10-16 加的实时通道，见 `realtime.service`）。
       *
       * 放在**写库之后**、`await` 之前的位置不是随意的：先落库再推，
       * 收到通知的那台设备立刻去取列表时那一行**一定已经在了**——反过来（先推后写）
       * 会重现 R-78 那一族"页面上看不见刚发生的事"。
       *
       * 推的是一句**信号**，不是那条通知本身：前端收到就刷新通知列表（`invalidateQueries`），
       * 拿到的仍然是自己这一份（可见范围、开关、已读都在服务端算过，同一次 `list()`）。
       * 若把整条提醒塞进推送里，就等于把"谁能看什么"的判断复制到了推送这一侧
       * ——本项目在别处栽过两次的那种重复（见 D-078 四）。
       *
       * 不在线（应用关着/被系统冻住）就发出去 0 条，**这不是失败**：
       * 那件事已经在库里，他下次打开或后台巡查时照旧看得到（口径见 `realtime.rules`）。
       */
      this.realtime.signal(receivers, { type: 'changed', area: areaOfKind(item.kind) })
    } catch (error) {
      this.logger.warn(`记录变动提醒失败（不影响主流程）：${String(error)}`)
    }
  }

  /**
   * 给家里其他人推一条"有变化"的信号（**状态型**那几类用它）。
   *
   * 为什么要单独一个入口：`plan`（菜单定下来了）与 `done`（饭做好了）这两类
   * **不走 `recordChange`**——它们由事实现算（`confirmedAt` / `doneAt`），
   * 在这儿再写一条事件型的会导致同一件事两条提醒（见 `orders.updateStatus` 那段）。
   * 但"不写提醒"不等于"不告诉那台设备"：正开着应用的家里人应当**当场**看到红点亮、
   * 卡片上多出「选好了」那个角标——那两项都是从那两个事实算出来的，
   * 所以推一句"这一块有变化"、让他去重取就够了。
   *
   * 开关在这一层**不过滤**：信号只是"去重取一次"，取回来的东西仍然按他自己的开关过滤
   * （正确性不受影响），而为此在这里再查一遍偏好表不值当——一次重取的成本是几十毫秒。
   */
  async signalFamily(familyId: string, area: NotificationArea, actorId: string): Promise<void> {
    try {
      const members = await this.prisma.familyMember.findMany({
        where: { familyId, userId: { not: actorId } },
        select: { userId: true },
      })
      this.realtime.signal(members.map((member) => member.userId), { type: 'changed', area })
    } catch (error) {
      this.logger.warn(`推送变动信号失败（不影响主流程）：${String(error)}`)
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

  /** 改开关（只改传了的那些；没传的保持原值） */
  async updatePrefs(userId: string, patch: Partial<NotificationPrefs>): Promise<NotificationPrefs> {
    const row = await this.prisma.notificationPref.upsert({
      where: { userId },
      create: { userId, ...patch },
      update: patch,
    })
    /*
     * 回写**九列的值**，返回形状与 `prefs()`/`GET /notifications` 同一份
     * （前端三处用同一份 `NotificationPrefs`，少一列就是"改完这个开关没反应"）。
     */
    return {
      mealPlan: row.mealPlan,
      mealDone: row.mealDone,
      expiry: row.expiry,
      prep: row.prep,
      orderChange: row.orderChange,
      fridgeChange: row.fridgeChange,
      checkin: row.checkin,
      family: row.family,
      recipe: row.recipe,
    }
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
