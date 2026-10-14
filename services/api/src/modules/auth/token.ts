import { createHash, randomBytes } from 'node:crypto'

/**
 * 令牌的**两条共用口径**（F2-02 的刷新令牌、M10 交付三的巡查令牌都走这里）。
 *
 * 放在单独一个文件是因为"令牌怎么生成、怎么存"是**同一个事实**：
 * 第一版 `digest` 写在 auth.service 里，做巡查令牌时如果各写一份，
 * 两处迟早有一处改成 md5 或忘了盐——而"只存摘要"这件事一旦有一处漏掉，
 * 泄漏数据库就等于泄漏可用的凭据。
 */

/** 只存摘要：即使数据库泄漏，也没法拿去换 access token（或冒用巡查令牌） */
export function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 生成一个不可猜的令牌串 */
export function randomToken(): string {
  return randomBytes(32).toString('base64url')
}
