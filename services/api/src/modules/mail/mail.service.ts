import { Injectable, Logger } from '@nestjs/common'

export type MailTransport = 'console' | 'smtp'

export interface MailMessage {
  to: string
  subject: string
  text: string
}

/**
 * 发信通道（D-021）：开发期用 console，配好 SMTP 后改环境变量即可真发信，**业务代码不用动**。
 *
 * - `MAIL_TRANSPORT=console`（默认）：邮件内容写进服务端日志。**仅供开发**——
 *   重置链接会出现在日志里，也因此 `forgot` 接口在 console 模式下会直接把链接回给调用方（方便本地测）。
 * - `MAIL_TRANSPORT=smtp`：用 `MAIL_SMTP_*` 配置真发信。
 *
 * 部署前必须切到 smtp，否则等于把"重置任何账号"的能力放在日志里（见 RISKS R-16）。
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name)
  private readonly transport: MailTransport = (process.env.MAIL_TRANSPORT ?? 'console') === 'smtp' ? 'smtp' : 'console'

  get mode(): MailTransport {
    return this.transport
  }

  /** console 模式下允许把链接回给调用方（仅开发便利），smtp 模式下绝不允许 */
  get exposesDevLink(): boolean {
    return this.transport === 'console'
  }

  async send(message: MailMessage): Promise<void> {
    if (this.transport === 'console') {
      // 用 warn 级别：这类日志在生产是"不该出现"的，方便被日志告警抓到
      this.logger.warn(`[console 邮件] 收件人=${message.to} 主题=${message.subject}\n${message.text}`)
      return
    }
    await this.sendViaSmtp(message)
  }

  /**
   * SMTP 发送：用 nodemailer 动态 require。
   * 动态引入的原因：没配邮件服务时不装这个依赖也能跑（本地/测试环境不浪费）。
   */
  private async sendViaSmtp(message: MailMessage): Promise<void> {
    const host = process.env.MAIL_SMTP_HOST
    const port = Number(process.env.MAIL_SMTP_PORT ?? 465)
    const user = process.env.MAIL_SMTP_USER
    const pass = process.env.MAIL_SMTP_PASSWORD
    const from = process.env.MAIL_FROM ?? user
    if (!host || !user || !pass) {
      throw new Error('MAIL_TRANSPORT=smtp 但缺少 MAIL_SMTP_HOST / MAIL_SMTP_USER / MAIL_SMTP_PASSWORD')
    }

    let nodemailer: { createTransport: (options: unknown) => { sendMail: (options: unknown) => Promise<unknown> } }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      nodemailer = require('nodemailer') as typeof nodemailer
    } catch {
      throw new Error('缺少 nodemailer 依赖：pnpm --dir services/api add nodemailer')
    }

    const transporter = nodemailer.createTransport({
      host,
      port,
      // 465 用隐式 TLS，587 用 STARTTLS；这里按端口判断，省得再配一个开关
      secure: port === 465,
      auth: { user, pass },
    })
    await transporter.sendMail({ from, to: message.to, subject: message.subject, text: message.text })
    this.logger.log(`已发送邮件到 ${message.to}`)
  }
}
