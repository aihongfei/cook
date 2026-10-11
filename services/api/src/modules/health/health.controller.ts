import { Controller, Get } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import { HealthService, type HealthStatus } from './health.service'

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({ summary: '健康检查（前端自检 / 运维探活）' })
  @ApiOkResponse({ description: '服务正常' })
  check(): HealthStatus {
    return this.healthService.check()
  }
}
