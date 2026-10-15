import { useEffect, useState } from 'react'
import { apiErrorMessage } from '@/api/client'
import {
  fetchPhotoBlobUrl,
  useAddCheckInComment,
  useCheckIn,
  useDeleteCheckIn,
  useDeleteCheckInComment,
  useUpdateCheckInComment,
  useUpdateCheckInNote,
  type CheckIn,
  type CheckInComment,
} from '@/api/checkins'
import BottomSheet from '@/components/ui/BottomSheet'
import ConfirmDialog from '@/components/ui/ConfirmDialog'
import ImageViewer from '@/components/ui/ImageViewer'
import { toast } from '@/components/ui/toast'

/**
 * 打卡详情（用户 2026-10-14：「打卡墙卡片不能点击查看详情」；2026-10-15 追加：
 * 「还要添加打开编辑和删除功能，评论也要」）。
 *
 * 卡片上能放的信息很少：照片、谁、哪一餐、一行被 CSS 截断的备注、日期。
 * 一件真事（"这道菜是谁做的、什么时候拍的、他当时说了什么"）在墙上挤不下，所以点开看。
 *
 * 四件事刻意的：
 * - **权限全看后端给的 `canEdit`/`canDelete`**（照片与每条评论都带）：前端不自己判
 *   "是不是我传的"——判定抄两遍迟早分叉，而分叉的表现是"按钮看得见、点下去 403"。
 *   换来的是：改/删入口**只在该出现的时候出现**（别人打开这一屏看不到它们）。
 * - **点开时重取一次**（`useCheckIn`，`staleTime: 0`）：墙上那张卡里的评论是列表那一趟的快照，
 *   别人刚说的话不在里面。抽屉是"全家一起看这个相册"的地方，看到隔夜的状态会很怪。
 * - **删是本屏唯一不可逆的事**，所以走 `ConfirmDialog` 并把代价说清（记录会没、评论一起没）；
 *   改备注与评论都不弹框（可改回来、也可再删）。
 * - **照片自己取一份**，不复用墙上那张卡的 blob URL：墙上那张由 `CheckInPhoto` 持有、
 *   卸载时 revoke，借过来就会有"抽屉还开着、卡片先卸载了 → URL 被 revoke → 变白"这种
 *   只在快速返回时才复现的错（这也**不走 `useQuery`**：缓存里存一个随时会被释放的 blob
 *   地址，第二次点开就是坏图）。
 */
export default function CheckInDetailSheet({
  entry,
  onClose,
}: {
  entry: CheckIn
  /** 抽屉关掉（删完之后也走它） */
  onClose: () => void
}) {
  const detail = useCheckIn(entry.id)
  /*
   * 先用墙上那张卡把首屏画出来（有照片、有备注，点开不闪白），详情回来之后换成最新的。
   * 这不是"乐观更新"：两边照片与日期本来就一样，只有评论可能多了几条。
   */
  const current = detail.data ?? entry

  const [viewing, setViewing] = useState(false)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const [editingNote, setEditingNote] = useState(false)
  const [noteDraft, setNoteDraft] = useState(current.note ?? '')
  /*
   * **写新的**与**改旧的**各用一份草稿（`commentDraft` / `editDraft`）。
   *
   * 一开始只有一份，结果"点改"会把原句填进底下那个输入框里，于是两个地方同时是编辑态、
   * 两颗键都写「保存」——用户根本分不清哪颗保存的是哪句（实测时我自己按错了）。
   */
  const [editingComment, setEditingComment] = useState<string | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [editDraft, setEditDraft] = useState('')
  const [removing, setRemoving] = useState(false)

  const updateNote = useUpdateCheckInNote()
  const removeCheckIn = useDeleteCheckIn()
  const addComment = useAddCheckInComment()
  const updateComment = useUpdateCheckInComment()
  const removeComment = useDeleteCheckInComment()

  useEffect(() => {
    let released = false
    let created: string | null = null
    setBlobUrl(null)
    setFailed(false)
    fetchPhotoBlobUrl(current.photoUrl)
      .then((url) => {
        created = url
        if (released) {
          URL.revokeObjectURL(url)
          return
        }
        setBlobUrl(url)
      })
      .catch(() => {
        if (!released) setFailed(true)
      })
    return () => {
      released = true
      if (created) URL.revokeObjectURL(created)
    }
  }, [current.photoUrl])

  const takenAt = formatTakenAt(current.createdAt)
  const meta = [current.checkDate, current.mealLabel ? `${current.mealLabel}的成品` : null, takenAt].filter(Boolean)

  const saveNote = () => {
    updateNote.mutate(
      { id: current.id, note: noteDraft.trim() },
      {
        onSuccess: () => {
          setEditingNote(false)
          toast.success(noteDraft.trim() ? '交代改好了' : '交代清掉了')
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  /** 发一条新的（底下那个输入框专用） */
  const submitComment = () => {
    const body = commentDraft.trim()
    if (!body) return
    addComment.mutate(
      { checkInId: current.id, body },
      {
        onSuccess: () => setCommentDraft(''),
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  /** 保存正在改的那一条 */
  const saveCommentEdit = () => {
    const body = editDraft.trim()
    if (!body || !editingComment) return
    updateComment.mutate(
      { commentId: editingComment, body },
      {
        onSuccess: () => {
          setEditingComment(null)
          setEditDraft('')
          toast.success('改好了')
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  const dropComment = (comment: CheckInComment) => {
    removeComment.mutate(comment.id, {
      onSuccess: () => {
        if (editingComment === comment.id) {
          setEditingComment(null)
          setEditDraft('')
        }
        toast.success('删掉了')
      },
      onError: (error) => toast.error(apiErrorMessage(error)),
    })
  }

  const confirmRemove = () => {
    removeCheckIn.mutate(current.id, {
      onSuccess: (result) => {
        toast.success(result.removedComments > 0 ? '删掉了，底下的评论也一起删了' : '这张打卡删掉了')
        setRemoving(false)
        onClose()
      },
      onError: (error) => {
        setRemoving(false)
        toast.error(apiErrorMessage(error))
      },
    })
  }

  return (
    <BottomSheet visible title="这一张" onClose={onClose}>
      <div className="checkin-detail">
        {blobUrl ? (
          <button type="button" className="checkin-detail__photo" onClick={() => setViewing(true)} aria-label="看大图">
            <img src={blobUrl} alt={current.note ?? `${current.nickname}的打卡`} />
          </button>
        ) : (
          <div className="checkin-detail__photo checkin-detail__photo--empty" aria-busy={!failed}>
            {failed ? '照片打不开了' : '照片加载中…'}
          </div>
        )}

        <p className="checkin-detail__who">
          {current.avatar} {current.isMe ? '我' : current.nickname}
        </p>
        <p className="checkin-detail__meta">{meta.join(' · ')}</p>

        {/* 备注**完整显示**：卡片上那两行是 CSS 截断的（line-clamp），
            详情里再截一次就等于这条备注永远读不全 */}
        {editingNote ? (
          <div className="checkin-detail__editor">
            <input
              type="text"
              aria-label="改这句交代"
              maxLength={60}
              placeholder="比如：给小满做的生日面"
              value={noteDraft}
              onChange={(event) => setNoteDraft(event.target.value)}
            />
            <div className="checkin-detail__editor-actions">
              <button type="button" className="checkin-detail__ghost" onClick={() => setEditingNote(false)}>取消</button>
              <button type="button" className="checkin-detail__primary" disabled={updateNote.isPending} onClick={saveNote}>
                {updateNote.isPending ? '保存中…' : '保存'}
              </button>
            </div>
            {/* 上限 60 字是后端定的（`CHECKIN_NOTE_MAX`）：这里也说出来，
                否则用户只看到"保存失败"却不知道为什么 */}
            <p className="checkin-detail__hint">最多 60 个字。照片换不了，想换请删掉重传。</p>
          </div>
        ) : (
          <p className="checkin-detail__note">
            {current.note ?? <span className="checkin-detail__note--empty">这一张没写备注。</span>}
          </p>
        )}

        {/* 改/删入口只在该出现的时候出现（后端算好的 canEdit/canDelete） */}
        {!editingNote && (current.canEdit || current.canDelete) && (
          <div className="checkin-detail__actions">
            {current.canEdit && (
              <button
                type="button"
                className="checkin-detail__ghost"
                onClick={() => {
                  setNoteDraft(current.note ?? '')
                  setEditingNote(true)
                }}
              >
                {current.note ? '改交代' : '写句交代'}
              </button>
            )}
            {current.canDelete && (
              <button type="button" className="checkin-detail__danger" onClick={() => setRemoving(true)}>
                删掉这张
              </button>
            )}
          </div>
        )}

        {/* ---- 评论 ---- */}
        <section className="checkin-comments" aria-label="大家的评论">
          <h4 className="checkin-comments__title">
            大家说 {current.comments.length > 0 && <span>{current.comments.length}</span>}
          </h4>

          {current.comments.length === 0 ? (
            <p className="checkin-comments__empty">还没人说话。看到了就说一句，做饭的人会很高兴。</p>
          ) : (
            <ul className="checkin-comments__list">
              {current.comments.map((comment) => (
                <li key={comment.id} className="checkin-comment">
                  <span className="checkin-comment__who">{comment.avatar} {comment.isMe ? '我' : comment.nickname}</span>
                  {editingComment === comment.id ? (
                    <div className="checkin-comment__editor">
                      <input
                        type="text"
                        aria-label="改这句评论"
                        maxLength={200}
                        value={editDraft}
                        onChange={(event) => setEditDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') saveCommentEdit()
                        }}
                      />
                      <button
                        type="button"
                        className="checkin-detail__ghost"
                        onClick={() => { setEditingComment(null); setEditDraft('') }}
                      >
                        取消
                      </button>
                      <button type="button" className="checkin-detail__primary" disabled={updateComment.isPending || !editDraft.trim()} onClick={saveCommentEdit}>
                        {updateComment.isPending ? '保存中…' : '保存'}
                      </button>
                    </div>
                  ) : (
                    <>
                      <p className="checkin-comment__body">
                        {comment.body}
                        {/* 改过之后说一句：不然"他明明说的是另一句"没法解释 */}
                        {comment.updatedAt !== comment.createdAt && <em className="checkin-comment__edited">（改过）</em>}
                      </p>
                      {comment.canEdit && (
                        <div className="checkin-comment__actions">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingComment(comment.id)
                              setEditDraft(comment.body)
                            }}
                          >
                            改
                          </button>
                          <button type="button" onClick={() => dropComment(comment)} disabled={removeComment.isPending}>删</button>
                        </div>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* 输入框：家里谁都能说（后端只要求"看得到这一张"） */}
          <div className="checkin-comments__compose">
            <input
              type="text"
              aria-label="写一句评论"
              maxLength={200}
              placeholder="说点什么…"
              value={commentDraft}
              onChange={(event) => setCommentDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submitComment()
              }}
            />
            <button
              type="button"
              disabled={!commentDraft.trim() || addComment.isPending}
              onClick={submitComment}
            >
              {addComment.isPending ? '发送中…' : '发送'}
            </button>
          </div>
        </section>
      </div>

      {viewing && blobUrl && (
        <ImageViewer src={blobUrl} alt={current.note ?? `${current.nickname}的打卡`} onClose={() => setViewing(false)} />
      )}

      {/*
        删打卡的确认：**这一屏唯一不可逆的事**，所以把代价说全——照片记录会没、
        底下的评论一起没（当前看到几条就说几条）。
      */}
      <ConfirmDialog
        open={removing}
        title="删掉这张打卡？"
        message={
          current.comments.length > 0
            ? `删了不能恢复。这张照片底下 ${current.comments.length} 条评论也会一起没。`
            : '删了不能恢复，照片会从打卡墙上消失。'
        }
        confirmText="删掉"
        tone="danger"
        pending={removeCheckIn.isPending}
        onCancel={() => setRemoving(false)}
        onConfirm={confirmRemove}
      />
    </BottomSheet>
  )
}

/**
 * 拍下来的时刻（`createdAt` 是上传时间）。
 *
 * 卡片上只有日期（`checkDate`），"几点做的"只有详情里看得到——而它正是打卡记录的东西
 * （一天做两道菜时，中午那道与晚上那道不是一回事）。用**本地时区**显示：
 * 用户在哪儿看的就按哪儿的钟点念，不做时区换算。
 */
function formatTakenAt(iso: string): string | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
