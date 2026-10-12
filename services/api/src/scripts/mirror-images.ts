import { ConfigModule } from '@nestjs/config'
import { PrismaClient } from '@prisma/client'
import { HeadObjectCommand } from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import {
  ensureBucket,
  extensionForContentType,
  mediaKey,
  mediaS3Config,
  putImage,
  s3Client,
} from '../modules/media/media.storage'

/**
 * 把菜谱图片从第三方图床**备份进自己的 MinIO**，并把 `imageKey/imageHash` 回写到 DB。
 *
 * 用法：
 *   pnpm run mirror:images             # 只补没备份过的（可反复执行）
 *   pnpm run mirror:images -- --force  # 强制重新下载（换了图源或怀疑图坏了时用）
 *
 * 设计要点：
 * - **只下载图片文件，不调用数据源业务接口**，所以不消耗第三方 API 调用次数。
 * - 文件名 = 图片内容的 sha256 → 同一张图被多道菜引用时只存一份，重复执行也不会重传。
 * - 相同的源地址只下载一次（同一批里先按 URL 去重）。
 * - 与业务接口解耦：备份完接口自动改用自托管地址（见 media.storage.ts 的 publicImageUrl）。
 */

const TIMEOUT_MS = 30_000
/** 对第三方图床客气一点，别并发打 */
const THROTTLE_MS = 120
const UA = 'Mozilla/5.0 (compatible; yushan-cook/0.1; +recipe-image-backup)'
/** 过小的文件多半是错误页而不是图片 */
const MIN_BYTES = 512
const MAX_BYTES = 8 * 1024 * 1024

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function download(url: string): Promise<{ buffer: Buffer; ext: string } | { error: string }> {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'image/*' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return { error: `HTTP ${response.status}` }
    const ext = extensionForContentType(response.headers.get('content-type'))
    if (!ext) return { error: `非图片类型：${response.headers.get('content-type') ?? '未知'}` }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length < MIN_BYTES) return { error: `文件过小（${buffer.length} 字节），疑似错误页` }
    if (buffer.length > MAX_BYTES) return { error: `文件过大（${buffer.length} 字节）` }
    return { buffer, ext }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

async function main() {
  await ConfigModule.forRoot({ envFilePath: ['.env'] })
  const force = process.argv.includes('--force')
  const config = mediaS3Config()
  if (!config.accessKeyId || !config.secretAccessKey) {
    throw new Error('缺少 MEDIA_S3_ACCESS_KEY / MEDIA_S3_SECRET_KEY —— 请写进 services/api/.env（不要提交、不要贴进对话）')
  }
  console.log(`对象存储：${config.endpoint}  桶：${config.bucket}${force ? '（--force：强制重新下载）' : ''}`)

  const s3 = s3Client(config)
  const { created } = await ensureBucket(s3, config)
  console.log(created ? '桶不存在，已创建并设为公开只读' : '桶已存在，读取权限已确认为公开只读')

  const client = new PrismaClient()
  let stored = 0
  let failed = 0
  try {
    const rows = await client.recipe.findMany({
      where: { image: { not: null } },
      select: { id: true, name: true, image: true, imageKey: true },
    })
    if (!rows.length) {
      console.log('没有需要处理的图片（库内没有带 image 的菜谱）')
      return
    }

    // 同一个源地址可能被多道菜引用：按 URL 去重，只下载一次
    const byUrl = new Map<string, typeof rows>()
    for (const row of rows) {
      const list = byUrl.get(row.image!) ?? []
      list.push(row)
      byUrl.set(row.image!, list)
    }

    // 跳过条件是「**对象确实在桶里**」，而不是"DB 里有 imageKey"——
    // 两者会不一致（例如中途换过存储/中断过上传），只看 DB 就会让页面上大批图片 404。
    const pending: [string, typeof rows][] = []
    let missingObjects = 0
    for (const [url, group] of byUrl) {
      if (force) { pending.push([url, group]); continue }
      const keys = [...new Set(group.map(row => row.imageKey).filter((key): key is string => Boolean(key)))]
      if (!keys.length || keys.length !== group.length) { pending.push([url, group]); continue }
      let allPresent = true
      for (const key of keys) {
        try {
          await s3.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }))
        } catch { allPresent = false; missingObjects++; break }
      }
      if (!allPresent) pending.push([url, group])
    }
    const alreadyLocal = rows.length - pending.reduce((total, [, group]) => total + group.length, 0)
    console.log(`带图菜谱 ${rows.length} 道，去重后源地址 ${byUrl.size} 个，待处理 ${pending.length} 个` +
      (missingObjects ? `（其中 ${missingObjects} 个是 DB 有记录但桶里没对象，属于要补传）` : '') + '\n')

    const failures: string[] = []
    let index = 0
    for (const [url, group] of pending) {
      index++
      if (index > 1) await sleep(THROTTLE_MS)
      const result = await download(url)
      if ('error' in result) {
        failed += group.length
        failures.push(`${url} → ${result.error}（影响 ${group.length} 道，如：${group[0].name}）`)
        console.log(`  ✗ [${index}/${pending.length}] ${url} → ${result.error}`)
        continue
      }
      const hash = createHash('sha256').update(result.buffer).digest('hex')
      const key = mediaKey(hash.slice(0, 32), result.ext)
      await putImage(s3, config, key, result.buffer)
      const updated = await client.recipe.updateMany({
        where: { id: { in: group.map(row => row.id) } },
        data: { imageKey: key, imageHash: hash, imageStoredAt: new Date() },
      })
      stored += updated.count
      if (index % 25 === 0 || index === pending.length) {
        console.log(`  … [${index}/${pending.length}] 已备份 ${stored} 道（最近：${group[0].name}）`)
      }
    }

    const withKey = await client.recipe.count({ where: { imageKey: { not: null } } })
    const total = await client.recipe.count()
    console.log(`\n本次备份 ${stored} 道（跳过已备份 ${alreadyLocal} 道），失败 ${failed} 道`)
    console.log(`库内自托管覆盖率：${withKey}/${total} 道`)
    if (failures.length) {
      console.log('\n失败清单（可重跑脚本重试，已成功的会跳过）：')
      for (const line of failures) console.log(`  - ${line}`)
      process.exitCode = 1
    }
  } finally {
    await client.$disconnect()
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
