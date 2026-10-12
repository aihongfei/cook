import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import { CurrentUserId, JwtAuthGuard } from '../auth/jwt-auth.guard'
import { FamilyService, FamilyView } from './family.service'
import { FAMILY_MEMBER_LIMIT, FAMILY_ROLES, ROLE_LABELS, ROLE_CAPABILITIES } from './family.roles'

interface CreateBody { name?: string }
interface JoinBody { inviteCode?: string }
interface UpdateBody { name?: string; shared?: boolean }
interface RoleBody { role?: string }

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${field}不能为空`)
  return value
}

@ApiTags('family')
@Controller('family')
export class FamilyController {
  constructor(private readonly family: FamilyService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '我的家庭（未加入返回 null）（F2-05/07）' })
  async mine(@CurrentUserId() userId: string): Promise<FamilyView | null> {
    return this.family.mine(userId)
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '创建家庭（创建者即掌勺人）（F2-06）' })
  async create(@CurrentUserId() userId: string, @Body() body: CreateBody): Promise<FamilyView> {
    return this.family.create(userId, typeof body?.name === 'string' ? body.name : undefined)
  }

  @Post('join')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  // 邀请码只有 6 位，必须限流，否则可以拿来猜码（F2-06）
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '凭六位邀请码加入家庭（F2-06）' })
  async join(@CurrentUserId() userId: string, @Body() body: JoinBody): Promise<FamilyView> {
    return this.family.join(userId, requireString(body?.inviteCode, '邀请码'))
  }

  @Patch()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '改家庭名与共享开关（需 family.edit）（F2-07）' })
  async update(@CurrentUserId() userId: string, @Body() body: UpdateBody): Promise<FamilyView> {
    return this.family.update(userId, {
      name: typeof body?.name === 'string' ? body.name : undefined,
      shared: typeof body?.shared === 'boolean' ? body.shared : undefined,
    })
  }

  @Post('invite/reset')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '重置邀请码，旧码立即失效（需 invite.reset）（F2-06）' })
  async resetInvite(@CurrentUserId() userId: string): Promise<FamilyView> {
    return this.family.resetInviteCode(userId)
  }

  @Patch('members/:userId')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '改成员角色；设为掌勺人即转让（需 member.manage）（F2-05）' })
  async updateMember(
    @CurrentUserId() userId: string,
    @Param('userId') targetUserId: string,
    @Body() body: RoleBody,
  ): Promise<FamilyView> {
    return this.family.updateMemberRole(userId, targetUserId, requireString(body?.role, '角色'))
  }

  @Delete('members/:userId')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '把成员移出家庭（需 member.manage）（F2-05）' })
  async removeMember(@CurrentUserId() userId: string, @Param('userId') targetUserId: string): Promise<FamilyView> {
    return this.family.removeMember(userId, targetUserId)
  }

  @Post('leave')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '退出家庭；掌勺人只剩自己时即解散（F2-05）' })
  async leave(@CurrentUserId() userId: string): Promise<{ left: true; disbanded: boolean }> {
    return this.family.leave(userId)
  }

  // 这个必须**免登录**（与 /auth/options 同理）：前端要能在没登录/没加入家庭时就知道角色与能力口径
  @Get('options')
  @ApiOperation({ summary: '角色与能力口径（前端不硬编码权限，F2-09）' })
  async options(): Promise<{ roles: { value: string; label: string; capabilities: string[] }[]; memberLimit: number }> {
    return {
      roles: FAMILY_ROLES.map(role => ({ value: role, label: ROLE_LABELS[role], capabilities: ROLE_CAPABILITIES[role] })),
      memberLimit: FAMILY_MEMBER_LIMIT,
    }
  }
}
