import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import {
  CAPABILITY,
  can,
  useCreateFamily,
  useFamily,
  useFamilyOptions,
  useJoinFamily,
  useLeaveFamily,
  useRemoveMember,
  useResetInviteCode,
  useUpdateFamily,
  useUpdateMemberRole,
  type FamilyRole,
} from '@/api/family'
import { useMe } from '@/api/auth'
import ConfirmDialog from '@/components/ui/ConfirmDialog'
import Page from '@/components/ui/Page'
import { toast } from '@/components/ui/toast'
import SectionTitle from '@/components/ui/SectionTitle'
import { useAuth } from '@/stores/auth'
import '../shared.scss'
import './family.scss'

const ROLE_HINT: Record<FamilyRole, string> = {
  OWNER: '掌勺人 · 家里的事都能管',
  COOK: '帮厨 · 能改菜单、确认做好、点菜',
  EATER: '吃货 · 只能点菜',
}

/** 能跳来家庭页的两个地方；其它来源（含直接输地址）一律回「我的」 */
const FAMILY_ENTRIES: Record<string, string> = {
  '/mine': '返回我的',
  '/kitchen': '返回厨房',
}

/** 家庭与成员（F2-05/06/07/09） */
export default function FamilyPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const token = useAuth((state) => state.token)
  const me = useMe()
  const family = useFamily()
  const options = useFamilyOptions()

  const createFamily = useCreateFamily()
  const joinFamily = useJoinFamily()
  const updateFamily = useUpdateFamily()
  const resetInvite = useResetInviteCode()
  const updateRole = useUpdateMemberRole()
  const removeMember = useRemoveMember()
  const leaveFamily = useLeaveFamily()

  const [name, setName] = useState('')
  const [inviteInput, setInviteInput] = useState('')
  const [editingName, setEditingName] = useState(false)
  /**
   * 需要二次确认的危险操作。一次只可能有一个，所以用一个状态描述"待确认的是什么"：
   * 退出/解散家庭、移出成员、转让掌勺人 —— 都会影响自己或别人，不接受一闪就过的执行。
   */
  const [pending, setPending] = useState<
    | { kind: 'leave' }
    | { kind: 'remove'; userId: string; nickname: string }
    | { kind: 'transfer'; userId: string; nickname: string }
    | null
  >(null)

  const data = family.data
  const memberLimit = options.data?.memberLimit ?? data?.memberLimit ?? 10
  // 家庭页不在底部 Tab 里，没有返回入口用户就只能改地址栏回去，所以按来源给一个
  const requestedFrom = location.state?.from
  const from =
    typeof requestedFrom === 'string' && requestedFrom in FAMILY_ENTRIES ? requestedFrom : '/mine'
  const back = (
    <Link className="page-back" to={from} style={{ paddingInline: 'var(--spacing-page)' }}>
      ← {FAMILY_ENTRIES[from]}
    </Link>
  )

  useEffect(() => {
    if (!token) navigate('/login', { replace: true })
  }, [token, navigate])

  // 桌面端测试时可以直接看到邀请码；移动端交给系统的复制菜单
  const copyInvite = async () => {
    if (!data) return
    try {
      await navigator.clipboard.writeText(data.inviteCode)
      toast.success('邀请码已复制，发给家里人就行')
    } catch {
      // 浏览器不给剪贴板权限时直接把码显示出来，用户还能手抄
      toast.success(`邀请码：${data.inviteCode}（长按可复制）`)
    }
  }

  /**
   * 统一收口：成功/失败都用 toast 提示（不各自 try/catch）。
   * 不在页面里插提示段落——那会把下面的内容顶下去，页脚跟着跳一下。
   */
  const submit = (
    mutate: (handlers: { onSuccess: () => void; onError: (error: unknown) => void }) => void,
    success: string,
  ) => {
    mutate({
      onSuccess: () => toast.success(success),
      onError: (err) => toast.error(apiErrorMessage(err)),
    })
  }

  if (family.isPending) {
    return (
      <Page>
        <div className="pscreen">
          {back}
          <div className="ptitle">家庭</div>
          <p className="family-loading">正在读取家庭信息…</p>
        </div>
      </Page>
    )
  }

  // ---------- 还没加入家庭：创建 / 加入 ----------
  if (!data) {
    return (
      <Page>
        <div className="pscreen">
          {back}
          <div className="ptitle">家庭</div>
          <p className="family-lead">
            建一个家，把家里人拉进来：菜单、点菜、冰箱都跟着这个家庭走。
            <br />
            一个人建，其他人凭邀请码加入。
          </p>

          <div className="family-card">
            <div className="family-card__title">我来建一个家</div>
            <label className="family-field">
              <span>家庭名（不填就用「{me.data?.nickname ?? '我'}的家」）</span>
              <input
                value={name}
                maxLength={32}
                placeholder="小满一家"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="family-primary"
              disabled={createFamily.isPending}
              onClick={() =>
                submit(
                  (cb) => createFamily.mutate({ name: name.trim() || undefined }, cb),
                  '家建好了，把邀请码发给家里人吧',
                )
              }
            >
              {createFamily.isPending ? '正在建家…' : '创建家庭'}
            </button>
          </div>

          <div className="family-card">
            <div className="family-card__title">用邀请码加入</div>
            <label className="family-field">
              <span>家里人的六位邀请码</span>
              <input
                value={inviteInput}
                maxLength={6}
                placeholder="例如 7AQ27R"
                autoCapitalize="characters"
                className="family-field__code"
                onChange={(event) => setInviteInput(event.target.value.toUpperCase())}
              />
            </label>
            <button
              type="button"
              className="family-primary"
              disabled={joinFamily.isPending || inviteInput.trim().length !== 6}
              onClick={() =>
                submit((cb) => joinFamily.mutate(inviteInput.trim(), cb), '加入成功，欢迎回家')
              }
            >
              {joinFamily.isPending ? '正在加入…' : '加入家庭'}
            </button>
          </div>
        </div>
      </Page>
    )
  }

  // ---------- 已加入家庭 ----------
  const mayManageMembers = can(data, CAPABILITY.MEMBER_MANAGE)
  const mayEditFamily = can(data, CAPABILITY.FAMILY_EDIT)
  const mayResetInvite = can(data, CAPABILITY.INVITE_RESET)
  const isOwner = data.myRole === 'OWNER'

  // 弹窗文案：同一个组件，三处调用只是内容不同
  const confirmContent =
    pending === null
      ? { title: '', message: '' }
      : pending.kind === 'leave'
        ? {
            title: isOwner ? '解散家庭' : '退出家庭',
            message: isOwner
              ? '解散后这个家就没了，成员关系也会一起清掉，且不能恢复。'
              : '退出后你自己看不到家里的菜单与点单了，需要重新用邀请码才能回来。',
            confirmText: isOwner ? '解散' : '退出',
          }
        : pending.kind === 'remove'
          ? {
              title: '移出成员',
              message: `把${pending.nickname}移出家庭？他需要重新用邀请码才能回来。`,
              confirmText: '移出',
            }
          : {
              title: '转让掌勺人',
              message: `把掌勺人交给${pending.nickname}？你会变成帮厨，之后管成员、换邀请码这些事只有他能做。`,
              confirmText: '转让',
            }

  return (
    <Page>
      <div className="pscreen">
        {back}
        <div className="ptitle">家庭</div>

        <div className="family-head">
          <div className="family-head__main">
            <div className="family-head__name">{data.name}</div>
            <div className="family-head__meta">
              {data.memberCount}/{memberLimit} 位成员 · 我是
              {options.data?.roles.find((r) => r.value === data.myRole)?.label ?? data.myRole}
            </div>
          </div>
          {mayEditFamily && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setEditingName((value) => !value)}
            >
              {editingName ? '取消' : '改家庭名'}
            </button>
          )}
        </div>

        {editingName && (
          <div className="family-rename">
            <input
              value={name}
              maxLength={32}
              placeholder={data.name}
              onChange={(event) => setName(event.target.value)}
            />
            <button
              type="button"
              className="family-primary"
              disabled={updateFamily.isPending || !name.trim()}
              onClick={() => {
                submit((cb) => updateFamily.mutate({ name: name.trim() }, cb), '家庭名已更新')
                setEditingName(false)
              }}
            >
              保存
            </button>
          </div>
        )}

        <div className="block-with-tip">
          <div className="family-invite">
            <div className="family-invite__main">
              <div className="family-invite__label">邀请码</div>
              <div className="family-invite__code">{data.inviteCode}</div>
            </div>
            <div className="family-invite__actions">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  void copyInvite()
                }}
              >
                复制
              </button>
              {mayResetInvite && (
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={resetInvite.isPending}
                  onClick={() =>
                    submit((cb) => resetInvite.mutate(undefined, cb), '换好了，旧邀请码已经作废')
                  }
                >
                  换一个
                </button>
              )}
            </div>
          </div>
          {!mayResetInvite && <p className="family-hint">邀请码只有掌勺人能换。</p>}
        </div>

        <SectionTitle title="家人" />

        <div className="rows" style={{ marginTop: 0 }}>
          {data.members.map((member) => (
            <div className="row family-member" key={member.userId}>
              <div className="row__icon">{member.avatar}</div>
              <div className="row__main">
                {member.nickname}
                {member.isMe && <span className="family-member__me">我</span>}
                <div className="row__sub">{ROLE_HINT[member.role]}</div>
              </div>

              {/* 有权限才有下拉；没有权限的人连控件都看不到（后端仍会再校验一次） */}
              {mayManageMembers && !member.isMe && (
                <div className="family-member__ops">
                  <select
                    aria-label={`设置 ${member.nickname} 的角色`}
                    value={member.role}
                    disabled={updateRole.isPending}
                    onChange={(event) => {
                      const role = event.target.value as FamilyRole
                      // 转让掌勺人 = 自己马上降为帮厨，必须先问一次；其它角色调整直接生效
                      if (role === 'OWNER' && data.myRole === 'OWNER') {
                        setPending({
                          kind: 'transfer',
                          userId: member.userId,
                          nickname: member.nickname,
                        })
                        return
                      }
                      submit(
                        (cb) => updateRole.mutate({ userId: member.userId, role }, cb),
                        `已把${member.nickname}改为${
                          options.data?.roles.find((item) => item.value === role)?.label ?? role
                        }`,
                      )
                    }}
                  >
                    {(options.data?.roles ?? []).map((role) => (
                      <option key={role.value} value={role.value}>
                        {role.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="family-member__remove"
                    disabled={removeMember.isPending}
                    onClick={() =>
                      setPending({
                        kind: 'remove',
                        userId: member.userId,
                        nickname: member.nickname,
                      })
                    }
                  >
                    移出
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <SectionTitle title="共享设置" />

        <div className="block-with-tip">
          <div className="family-shared">
            <div className="family-shared__main">
              <div className="family-shared__title">家庭共享</div>
              <div className="family-shared__sub">
                {data.shared ? '家里人互相能看到菜单与点单' : '已关闭：各自看各自的'}
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={data.shared}
              aria-label="家庭共享开关"
              className={['family-switch', data.shared && 'is-on'].filter(Boolean).join(' ')}
              disabled={!mayEditFamily || updateFamily.isPending}
              onClick={() =>
                submit(
                  (cb) => updateFamily.mutate({ shared: !data.shared }, cb),
                  data.shared ? '已关闭家庭共享' : '已开启家庭共享',
                )
              }
            >
              <span className="family-switch__dot" />
            </button>
          </div>
          {!mayEditFamily && <p className="family-hint">共享开关只有掌勺人能改。</p>}
        </div>

        {/* 掌勺人家里还有人时不能一走了之（否则这个家没有管理员）——直接说清怎么办，不让点进去撞错误 */}
        {isOwner && data.memberCount > 1 ? (
          <p className="family-hint family-hint--block">
            你是掌勺人：把「掌勺人」交给一位家人后，才能退出这个家。
          </p>
        ) : (
          <button
            type="button"
            className="family-leave"
            onClick={() => setPending({ kind: 'leave' })}
          >
            {isOwner ? '解散家庭' : '退出家庭'}
          </button>
        )}

        <ConfirmDialog
          open={pending !== null}
          pending={leaveFamily.isPending || removeMember.isPending || updateRole.isPending}
          tone="danger"
          {...confirmContent}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const action = pending
            if (!action) return
            setPending(null)
            if (action.kind === 'leave') {
              leaveFamily.mutate(undefined, {
                onSuccess: (result) =>
                  toast.success(result.disbanded ? '家庭已解散' : '已退出家庭'),
                onError: (err) => toast.error(apiErrorMessage(err)),
              })
              return
            }
            if (action.kind === 'remove') {
              submit(
                (cb) => removeMember.mutate(action.userId, cb),
                `已把${action.nickname}移出家庭`,
              )
              return
            }
            submit(
              (cb) => updateRole.mutate({ userId: action.userId, role: 'OWNER' }, cb),
              `已把掌勺人交给${action.nickname}`,
            )
          }}
        />
      </div>
    </Page>
  )
}
