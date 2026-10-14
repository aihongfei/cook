import { Body, Controller, Delete, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard'
import { PatrolAuthGuard } from './notifications.patrol.guard'
import { NotificationsService } from './notifications.service'

interface PrefsBody {
  mealPlan?: unknown
  mealDone?: unknown
  expiry?: unknown
  prep?: unknown
}

/** 标一条已读：那条的 id（列表里渲染用的那个） */
interface ReadBody { id?: unknown }
/** 一键已读：**当前列表里**那些 id（不是"这个账号所有未读"，见 service 的说明） */
interface ReadAllBody { ids?: unknown }
/** 领巡查令牌：带这台手机的稳定标识与名字（都只用于排查与分行，不参与鉴权） */
interface PatrolTokenBody { deviceId?: unknown; device?: unknown }

/**
 * 消息提醒（M10）。口径见 D-078。
 *
 * 四个接口：**看**（`GET`，红点与通知中心共用）、**标一条已读**（`POST /read`）、
 * **一键已读**（`POST /read-all`）、**改开关**（`POST /prefs`）。
 * 全部要求登录——提醒是"给我的"，挂在账号上（开关按账号，用户 2026-10-15 选定）。
 */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '我的提醒（含未读数与各 Tab 的未读数）（M10 / F10-01~03）' })
  async list(@CurrentUserId() userId: string) {
    return this.notifications.list(userId)
  }

  /**
   * 读过**一条**（前端在点开它跳走时调用）。用 POST 不用 GET：它有副作用。
   *
   * 传的是那一条的 `id`（列表里渲染用的就是它）——不传行号不传数组：
   * 用户点的是"屏幕上哪一条"，那件事在界面上就是一个 id。
   */
  @Post('read')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '标一条为已读（点开通知跳走时调用）（M10 / F10-04）' })
  async read(@CurrentUserId() userId: string, @Body() body: ReadBody) {
    return this.notifications.markRead(userId, body?.id)
  }

  /**
   * 一键已读（F10-04）。
   *
   * 只标**用户当前看得到的那一批**（`ids` 由前端从列表里给过来）：不这么做的话，
   * 会把他在别的页面上还没看到过的东西一起标掉——"我明明没看过那条，它怎么就没了"。
   */
  @Post('read-all')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '一键已读（只标当前列表里那些）（M10 / F10-04）' })
  async readAll(@CurrentUserId() userId: string, @Body() body: ReadAllBody) {
    return this.notifications.markAllRead(userId, body?.ids)
  }

  /**
   * 四个开关（F10-04）。**只接受布尔值**：传 `"true"` 这种字符串一律当没传——
   * 否则前端一处拼错就会把开关静默改掉，而用户看到的界面还是他自己点的那样。
   */
  @Post('prefs')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '改提醒开关（只改传了的那些）（M10 / F10-04）' })
  async prefs(@CurrentUserId() userId: string, @Body() body: PrefsBody) {
    const patch: { mealPlan?: boolean; mealDone?: boolean; expiry?: boolean; prep?: boolean } = {}
    for (const key of ['mealPlan', 'mealDone', 'expiry', 'prep'] as const) {
      if (typeof body?.[key] === 'boolean') patch[key] = body[key]
    }
    return this.notifications.updatePrefs(userId, patch)
  }

  /**
   * 领一枚**巡查令牌**给这台手机（M10 交付三，**凭登录态领**）。
   *
   * 后台那段代码跑在系统的调度器里、没有登录会话，所以要一枚自己的凭据——
   * 而它不能借用刷新令牌（一用就轮换，会把用户当场登出，见 service 的说明）。
   *
   * `deviceId` 是**必填**的：令牌按"账号 + 设备"记一行，同一台手机重登不会顶掉家里另一台。
   */
  @Post('patrol/token')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '这台手机领一枚后台取提醒的令牌（M10 交付三）' })
  async patrolToken(@CurrentUserId() userId: string, @Body() body: PatrolTokenBody) {
    return this.notifications.issuePatrol(userId, body?.deviceId, body?.device)
  }

  /**
   * 吊销巡查令牌（退出登录时调）。
   *
   * 带 `deviceId` 就只吊销那一台（这台手机退出，家里的平板不该跟着哑掉）；
   * 不带则吊销该账号全部。
   */
  @Delete('patrol/token')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '吊销这台手机（或全部）的巡查令牌（退出登录时调）' })
  async revokePatrolToken(@CurrentUserId() userId: string, @Query('deviceId') deviceId?: string) {
    return this.notifications.revokePatrol(userId, deviceId)
  }

  /**
   * 手机在后台**巡查一次**（凭巡查令牌，不是登录令牌）。
   *
   * 这是"应用在后台也能收到家里刚发生的事"那一半的实现入口：系统的调度器
   * 每隔一段时间唤起一段不依赖 WebView 的 JS，它到这里问一句"有没有新的"，
   * 有就地弹本机通知。**取的是"上次之后又发生的事"**（`since` 由手机带来），
   * 所以同一条不会反复弹（口径见 `patrol.rules`）。
   */
  @Get('patrol')
  @UseGuards(PatrolAuthGuard)
  @ApiOperation({ summary: '取"上次之后又发生的"提醒（手机后台用，凭巡查令牌）（M10 交付三）' })
  async patrol(@CurrentUserId() userId: string, @Query('since') since?: string) {
    return this.notifications.patrol(userId, since)
  }
}
