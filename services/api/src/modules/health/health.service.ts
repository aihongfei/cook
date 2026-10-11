import { Injectable } from '@nestjs/common'

export interface HealthStatus {
  status: 'ok'
  name: string
  version: string
  /** 服务已运行秒数 */
  uptime: number
  timestamp: string
  node: string
}

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now()

  check(): HealthStatus {
    return {
      status: 'ok',
      name: 'yushan-api',
      version: process.env.npm_package_version ?? '0.1.0',
      uptime: Math.round((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
      node: process.version,
    }
  }
}
