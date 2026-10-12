/**
 * JWT 密钥读取（F2-02）。
 *
 * 刻意**不做默认值兜底**：密钥一旦有默认值，生产环境忘了配置也会照常启动，
 * 等于所有人都能自己签发 token。缺失时直接抛错让服务起不来，逼着配置到位。
 */
export function jwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.length < 32) {
    throw new Error(
      'JWT_SECRET 缺失或过短（至少 32 个字符）：请写进 services/api/.env（不要提交、不要贴进对话）。' +
        '容器部署时由 docker-compose.yml 从根 .env 传入。',
    )
  }
  return secret
}
