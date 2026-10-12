import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto'

/**
 * Promise 版 scrypt（带 options 的重载）。
 * 不用 util.promisify：它只会取到 3 参数的那个重载，传 options 会判类型错误。
 */
function scrypt(password: string | Buffer, salt: string | Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => (error ? reject(error) : resolve(derivedKey)))
  })
}

/**
 * 密码哈希（R-07 要求：密码绝不落地为明文）。
 *
 * 为什么用 Node 内置的 scrypt 而不是 bcrypt/argon2：
 * - 两者都需要原生模块，在 alpine 容器里要装编译工具链，而本项目已经吃过一次
 *   pnpm 12 依赖构建审批（allowBuilds）的麻烦；scrypt 是 Node 内置、零依赖、跨架构一致。
 * - scrypt 是内存硬的密码派生函数（RFC 7914），OWASP 的密码存储建议里与 bcrypt/argon2 并列可选。
 *
 * 存储格式自描述：`scrypt$N$r$p$<salt hex>$<hash hex>` —— 参数或算法将来升级时，
 * 老哈希仍能按自己记录下来的参数校验通过，不需要强制所有人改密码。
 */

export interface ScryptParams {
  N: number
  r: number
  p: number
}

/** N=2^15、r=8、p=1 → 单次约 32MB 内存、几十毫秒，兼顾抗爆破与服务端开销 */
const PARAMS: ScryptParams = { N: 32768, r: 8, p: 1 }
const KEY_LENGTH = 64
const SALT_LENGTH = 16

export async function hashPassword(password: string, params: ScryptParams = PARAMS): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const derived = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { ...params, maxmem: 256 * 1024 * 1024 })
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('hex')}$${derived.toString('hex')}`
}

/** 校验密码；格式不认识或参数不合法一律返回 false（不抛异常，避免把内部结构泄漏给调用方） */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, rawN, rawR, rawP, saltHex, hashHex] = parts
  const N = Number(rawN)
  const r = Number(rawR)
  const p = Number(rawP)
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N <= 1 || r <= 0 || p <= 0) return false
  let expected: Buffer
  try {
    expected = Buffer.from(hashHex, 'hex')
  } catch {
    return false
  }
  if (expected.length === 0) return false
  try {
    const derived = (await scrypt(password.normalize('NFKC'), Buffer.from(saltHex, 'hex'), expected.length, {
      N, r, p, maxmem: 256 * 1024 * 1024,
    })) as Buffer
    // 定长后再比较，避免长度不同时 timingSafeEqual 抛错并泄漏长度信息
    return derived.length === expected.length && timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}
