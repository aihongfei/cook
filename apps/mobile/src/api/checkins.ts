import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/stores/auth'
import { apiClient } from './client'

/**
 * 打卡照片（M9 / F9-03、F9-07、F9-08，口径见 DECISIONS D-023）。
 *
 * 两个必须知道的约定：
 * 1. **照片不能直接用 `<img src>` 指向接口**：接口要过签名 + 登录令牌两道门（只看签名的话，
 *    链接被转发给谁谁都能看），而 `<img>` 带不上 Authorization 头。所以这里用 `photoBlobUrl()`
 *    取回字节再转成 blob URL 显示。
 * 2. **上传前先缩图**：手机原图 3–10MB，缩到最长边 1600px、JPEG 0.85 之后通常 < 500KB。
 *    缩图在浏览器里做（canvas），后端只兜 8MB 上限与真实图片类型。
 */

export interface CheckInComment {
  id: string
  body: string
  createdAt: string
  /** 改过之后会晚于 createdAt */
  updatedAt: string
  userId: string
  nickname: string
  avatar: string
  isMe: boolean
  /** 我能不能改/删这一条（后端算好，前端只负责显示按钮） */
  canEdit: boolean
  canDelete: boolean
}

export interface CheckIn {
  id: string
  /** 服务端的签名路径（不是可直接放进 img 的地址，见文件头说明） */
  photoUrl: string
  photoExpiresAt: number
  note: string | null
  checkDate: string
  createdAt: string
  userId: string
  nickname: string
  avatar: string
  isMe: boolean
  /** 挂在哪一餐上（成品照）；独立打卡为 null */
  mealKey: string | null
  mealLabel: string | null
  /** 我能不能改/删这一张（只归上传者本人） */
  canEdit: boolean
  canDelete: boolean
  /** 照片底下家里人说的话（时间正序） */
  comments: CheckInComment[]
}

export interface CheckInWall {
  items: CheckIn[]
  total: number
  hasMore: boolean
  scope: 'family' | 'mine'
}

export interface HeatCell {
  date: string
  count: number
  /** 0–4 的热力等级（后端算好，前端只上色） */
  level: number
}

export interface HeatmapGrid {
  weeks: HeatCell[][]
  from: string
  to: string
  totalDays: number
  totalCount: number
  /** 连续打卡天数（今天没打就从昨天算） */
  streak: number
}

export interface CheckInStats {
  mine: HeatmapGrid
  family: HeatmapGrid
  mineTotal: number
  familyTotal: number
  /** 「已做好」还没传成品照的餐（给上传时选"挂到哪一餐"用） */
  attachableMeals: { mealKey: string; label: string }[]
}

/** 缩图参数：最长边 1600px、JPEG 0.85 —— 够看清一盘菜，又远小于手机原图 */
export const PHOTO_MAX_EDGE = 1600
export const PHOTO_QUALITY = 0.85
/** 图片解码超时（见 loadImage 的说明） */
const IMAGE_DECODE_TIMEOUT_MS = 15_000

/**
 * 把选中的图片文件缩到最长边 1600px 并转成 JPEG dataURL。
 * 用 canvas 在本地完成，不经过网络；失败时（极少数浏览器）回退到原图的 dataURL，
 * 让后端的大小/类型校验去决定收不收——总比直接报"上传失败"让人摸不着头脑好。
 */
export async function shrinkImage(file: File): Promise<string> {
  const original = await readAsDataURL(file)
  try {
    const image = await loadImage(original)
    const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(image.width, image.height))
    const width = Math.max(1, Math.round(image.width * scale))
    const height = Math.max(1, Math.round(image.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return original
    context.drawImage(image, 0, 0, width, height)
    return canvas.toDataURL('image/jpeg', PHOTO_QUALITY)
  } catch {
    return original
  }
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('这个文件读不出来'))
    reader.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    // 超时兜底：解码卡住时（损坏的图、极端大的图、某些 WebView）不能让用户一直看着"正在处理照片…"
    const timer = setTimeout(() => reject(new Error('这张图片处理超时了')), IMAGE_DECODE_TIMEOUT_MS)
    image.onload = () => {
      clearTimeout(timer)
      resolve(image)
    }
    image.onerror = () => {
      clearTimeout(timer)
      reject(new Error('这不是一张能显示的图片'))
    }
    image.src = src
  })
}

export async function fetchWall(options: { family: boolean; limit?: number }): Promise<CheckInWall> {
  const { data } = await apiClient.get<CheckInWall>('/checkins', {
    params: { family: String(options.family), ...(options.limit ? { limit: options.limit } : {}) },
  })
  return data
}

export async function fetchStats(): Promise<CheckInStats> {
  const { data } = await apiClient.get<CheckInStats>('/checkins/stats')
  return data
}

export async function uploadCheckIn(input: { image: string; note?: string; mealKey?: string }): Promise<CheckIn> {
  const { data } = await apiClient.post<CheckIn>('/checkins', input)
  return data
}

export function useCheckInWall(scope: 'family' | 'mine', options: { enabled?: boolean } = {}) {
  const token = useAuth((state) => state.token)
  return useQuery({
    queryKey: ['checkins', scope],
    queryFn: () => fetchWall({ family: scope === 'family' }),
    enabled: Boolean(token) && options.enabled !== false,
    staleTime: 30_000,
  })
}

export function useCheckInStats(options: { enabled?: boolean } = {}) {
  const token = useAuth((state) => state.token)
  return useQuery({
    queryKey: ['checkins', 'stats'],
    queryFn: fetchStats,
    // 没加入家庭时后端会 404（打卡是家庭内的），所以要先确认有家庭
    enabled: Boolean(token) && options.enabled !== false,
    staleTime: 60_000,
  })
}

export function useUploadCheckIn() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: uploadCheckIn,
    onSuccess: (created) => {
      // 照片会同时影响墙与统计（热力图 + 连续天数），两个都失效重取
      void queryClient.invalidateQueries({ queryKey: ['checkins'] })
      // 挂在某一餐上的成品照会让点单卡上的张数变化，顺手让点单列表也重新校验
      if (created.mealKey) void queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
  })
}

/**
 * 取一张照片并转成 blob URL（用完记得 `URL.revokeObjectURL` 释放）。
 *
 * 为什么要绕这一圈：接口要求 Authorization 头，`<img src>` 带不上；
 * axios 用 `responseType: 'blob'` 拿回字节后，再交给 `<img>` 显示。
 */
export async function fetchPhotoBlobUrl(signedPath: string): Promise<string> {
  // axios 会把 baseURL(/api) 与这个相对路径拼起来，所以直接传服务端给的路径
  const { data } = await apiClient.get<Blob>(signedPath, { responseType: 'blob' })
  return URL.createObjectURL(data)
}

// ---------------------------------------------------------------------------
// 编辑、删除与评论（用户 2026-10-15：「还要添加打开编辑和删除功能，评论也要」）
//
// 权限判定全在后端（`canEdit` / `canDelete` 随数据一起下发），前端只负责按它显示按钮——
// 与 `nextActions`、`canAdd` 那条口径一致：**判定不抄两遍**，抄了迟早分叉，
// 而分叉的表现是"按钮看得见、点下去 403"。
// ---------------------------------------------------------------------------

export async function fetchCheckIn(id: string): Promise<CheckIn> {
  const { data } = await apiClient.get<CheckIn>(`/checkins/${encodeURIComponent(id)}`)
  return data
}

export async function updateCheckInNote(id: string, note: string): Promise<CheckIn> {
  const { data } = await apiClient.patch<CheckIn>(`/checkins/${encodeURIComponent(id)}`, { note })
  return data
}

export async function deleteCheckIn(id: string): Promise<{ id: string; removedComments: number }> {
  const { data } = await apiClient.delete<{ id: string; removedComments: number }>(`/checkins/${encodeURIComponent(id)}`)
  return data
}

export async function addCheckInComment(checkInId: string, body: string): Promise<CheckInComment> {
  const { data } = await apiClient.post<CheckInComment>(`/checkins/${encodeURIComponent(checkInId)}/comments`, { body })
  return data
}

export async function updateCheckInComment(commentId: string, body: string): Promise<CheckInComment> {
  const { data } = await apiClient.patch<CheckInComment>(`/checkins/comments/${encodeURIComponent(commentId)}`, { body })
  return data
}

export async function deleteCheckInComment(commentId: string): Promise<{ id: string; checkInId: string }> {
  const { data } = await apiClient.delete<{ id: string; checkInId: string }>(`/checkins/comments/${encodeURIComponent(commentId)}`)
  return data
}

/**
 * 单张详情（点开抽屉时取一次）。
 *
 * `staleTime: 0`：每次点开都要拿最新的评论——墙上那张卡里的 `comments` 是列表那一趟的快照，
 * 别人刚说的话不在里面。抽屉是"大家都在看同一个相册"的地方，看到隔夜的状态会很怪。
 */
export function useCheckIn(id: string | null) {
  const token = useAuth((state) => state.token)
  return useQuery({
    queryKey: ['checkins', 'one', id],
    queryFn: () => fetchCheckIn(id as string),
    enabled: Boolean(token) && Boolean(id),
    staleTime: 0,
  })
}

/** 改备注：成功后就地更新详情与墙（不整墙重取，照片字节没必要重下） */
export function useUpdateCheckInNote() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) => updateCheckInNote(id, note),
    onSuccess: (updated) => {
      queryClient.setQueryData(['checkins', 'one', updated.id], updated)
      void queryClient.invalidateQueries({ queryKey: ['checkins'], refetchType: 'active' })
    },
  })
}

/**
 * 删一张打卡。
 *
 * **照片字节不动**（服务端也不动对象存储，见服务端注释）：删的是"这张记录在墙上"，
 * 而不是"这张图从世界上消失"。删完让墙与统计都重取——热力图与连续天数都跟着这张走。
 */
export function useDeleteCheckIn() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteCheckIn(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['checkins'] })
      // 挂在餐上的成品照删掉之后，点单卡上的张数要跟着变（与上传那条对称）
      void queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
  })
}

/** 评论/改评论/删评论：三件事都会改"这一张底下的评论列表"，所以都作废 ['checkins'] 这一支 */
export function useAddCheckInComment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ checkInId, body }: { checkInId: string; body: string }) => addCheckInComment(checkInId, body),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['checkins'] }) },
  })
}

export function useUpdateCheckInComment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ commentId, body }: { commentId: string; body: string }) => updateCheckInComment(commentId, body),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['checkins'] }) },
  })
}

export function useDeleteCheckInComment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (commentId: string) => deleteCheckInComment(commentId),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['checkins'] }) },
  })
}
