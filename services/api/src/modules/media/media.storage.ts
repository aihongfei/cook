import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

/**
 * 菜谱图片自托管（MinIO 对象存储）。
 *
 * 为什么必须做：数据源的图片是第三方域名直链，官方文档明确写"图片链接会过期"；
 * 一旦对方删图或改路径，页面上的图就全没了。备份进自己的对象存储后，
 * **第三方接口对我们只在"首次导入"时有用，运行时不再依赖**（也就不用反复花调用次数）。
 *
 * 代码按标准 S3 协议写，所以将来把 MinIO 换成阿里云 OSS / 腾讯云 COS / AWS S3，
 * 只需改 `MEDIA_S3_*` 环境变量（endpoint / 密钥 / 桶名），不用动业务代码。
 */

/** 图片按内容哈希命名，同一张图被多道菜引用时只存一份 */
export const MEDIA_FOLDER = 'recipes'

export interface MediaS3Config {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

export function mediaS3Config(): MediaS3Config {
  return {
    endpoint: process.env.MEDIA_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
    region: process.env.MEDIA_S3_REGION ?? 'us-east-1',
    bucket: process.env.MEDIA_S3_BUCKET ?? 'cook-media',
    accessKeyId: process.env.MEDIA_S3_ACCESS_KEY ?? '',
    secretAccessKey: process.env.MEDIA_S3_SECRET_KEY ?? '',
  }
}

export function s3Client(config: MediaS3Config = mediaS3Config()): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // MinIO 要求按路径寻址（不能用 bucket.域名 形式）
    forcePathStyle: true,
  })
}

/** 图片在存储桶里的相对 key，例如 `recipes/9f2c…a1.jpg` */
export function mediaKey(hash: string, ext: string): string {
  return `${MEDIA_FOLDER}/${hash}.${ext.replace(/^\./, '')}`
}

/** 接口对外暴露的图片地址：有自托管副本就用副本，没有才回退源站直链 */
export function publicImageUrl(imageKey: string | null, sourceImage: string | null): string | null {
  const base = process.env.MEDIA_BASE_URL?.replace(/\/+$/, '')
  if (imageKey && base) return `${base}/${imageKey}`
  return sourceImage
}

const CONTENT_TYPE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const EXT_CONTENT_TYPE: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
}

/** 只接受已知的图片类型；返回扩展名，未知类型返回 null（宁可不存，也不把 HTML 错误页当图片存下来） */
export function extensionForContentType(contentType: string | null): string | null {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase()
  return CONTENT_TYPE_EXT[type] ?? null
}

export function contentTypeForKey(key: string): string {
  return EXT_CONTENT_TYPE[key.split('.').pop() ?? ''] ?? 'application/octet-stream'
}

/**
 * 幂等地准备好桶：不存在就建，并设为**公开只读**。
 * 菜谱图是要给所有登录用户看的公开内容，用公开读 + 内容哈希文件名最省事
 * （不需要给每张图签临时 URL）；私有内容（如口味档案头像）应另建私有桶。
 */
export async function ensureBucket(client: S3Client, config: MediaS3Config): Promise<{ created: boolean }> {
  let created = false
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }))
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }))
    created = true
  }
  await client.send(new PutBucketPolicyCommand({
    Bucket: config.bucket,
    Policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: { AWS: ['*'] },
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${config.bucket}/*`],
      }],
    }),
  }))
  return { created }
}

/** 上传一张图片；key 带内容哈希，所以重复上传同一张图是幂等的覆盖写 */
export async function putImage(client: S3Client, config: MediaS3Config, key: string, body: Buffer): Promise<void> {
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: contentTypeForKey(key),
    // 内容按哈希命名 → 内容永不改变，可长期缓存
    CacheControl: 'public, max-age=31536000, immutable',
  }))
}
