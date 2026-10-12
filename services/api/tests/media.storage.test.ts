import assert from 'node:assert/strict'
import test from 'node:test'
import {
  contentTypeForKey,
  extensionForContentType,
  mediaKey,
  mediaS3Config,
  publicImageUrl,
} from '../src/modules/media/media.storage'

// 图片自托管的两个关键口径：
// ① 只把**确定是图片**的响应存进对象存储；② 有自托管副本就用副本、否则回退源站直链。

test('extensionForContentType 只认已知图片类型，绝不把 HTML 错误页当图片存下来', () => {
  assert.equal(extensionForContentType('image/jpeg'), 'jpg')
  assert.equal(extensionForContentType('image/jpeg; charset=binary'), 'jpg')
  assert.equal(extensionForContentType('IMAGE/PNG'), 'png')
  assert.equal(extensionForContentType('image/webp'), 'webp')
  assert.equal(extensionForContentType('image/gif'), 'gif')
  // 图床限流/报错时经常返回 HTML，必须拒绝
  assert.equal(extensionForContentType('text/html'), null)
  assert.equal(extensionForContentType('application/octet-stream'), null)
  assert.equal(extensionForContentType('image/svg+xml'), null)
  assert.equal(extensionForContentType(null), null)
})

test('mediaKey / contentTypeForKey 命名与类型一致', () => {
  assert.equal(mediaKey('abc123', 'jpg'), 'recipes/abc123.jpg')
  assert.equal(mediaKey('abc123', '.png'), 'recipes/abc123.png')
  // 上传时写的 Content-Type 必须跟扩展名对得上，否则浏览器可能不按图片渲染
  assert.equal(contentTypeForKey('recipes/abc.jpg'), 'image/jpeg')
  assert.equal(contentTypeForKey('recipes/abc.png'), 'image/png')
  assert.equal(contentTypeForKey('recipes/abc.webp'), 'image/webp')
  assert.equal(contentTypeForKey('recipes/abc.gif'), 'image/gif')
  assert.equal(contentTypeForKey('recipes/abc.unknown'), 'application/octet-stream')
})

test('publicImageUrl 有副本用副本（拼接不留双斜杠），没副本才回退源站', () => {
  const original = process.env.MEDIA_BASE_URL
  try {
    process.env.MEDIA_BASE_URL = 'http://127.0.0.1:9000/cook-media/'
    assert.equal(
      publicImageUrl('recipes/abc.jpg', 'https://api.jisuapi.com/recipe/upload/x.jpg'),
      'http://127.0.0.1:9000/cook-media/recipes/abc.jpg',
    )
    // 还没备份的（或没配 MEDIA_BASE_URL 的环境）回退源站直链，页面不至于无图
    assert.equal(publicImageUrl(null, 'https://api.jisuapi.com/recipe/upload/x.jpg'), 'https://api.jisuapi.com/recipe/upload/x.jpg')
    assert.equal(publicImageUrl(null, null), null)

    delete process.env.MEDIA_BASE_URL
    assert.equal(publicImageUrl('recipes/abc.jpg', 'https://api.jisuapi.com/x.jpg'), 'https://api.jisuapi.com/x.jpg')
  } finally {
    if (original === undefined) delete process.env.MEDIA_BASE_URL
    else process.env.MEDIA_BASE_URL = original
  }
})

test('mediaS3Config 默认指向本机 MinIO，并能被环境变量覆盖（换 OSS/S3 只改环境变量）', () => {
  const keys = ['MEDIA_S3_ENDPOINT', 'MEDIA_S3_REGION', 'MEDIA_S3_BUCKET', 'MEDIA_S3_ACCESS_KEY', 'MEDIA_S3_SECRET_KEY']
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  try {
    for (const key of keys) delete process.env[key]
    assert.deepEqual(mediaS3Config(), {
      endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', bucket: 'cook-media', accessKeyId: '', secretAccessKey: '',
    })

    process.env.MEDIA_S3_ENDPOINT = 'https://oss-cn-hangzhou.aliyuncs.com'
    process.env.MEDIA_S3_BUCKET = 'yushan-media'
    process.env.MEDIA_S3_ACCESS_KEY = 'k'
    process.env.MEDIA_S3_SECRET_KEY = 's'
    assert.equal(mediaS3Config().endpoint, 'https://oss-cn-hangzhou.aliyuncs.com')
    assert.equal(mediaS3Config().bucket, 'yushan-media')
    assert.equal(mediaS3Config().accessKeyId, 'k')
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
})
