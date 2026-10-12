import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { logout, useAuthOptions, useMe, useUpdateProfile } from '@/api/auth'
import { useFamily } from '@/api/family'
import Page from '@/components/ui/Page'
import { toast } from '@/components/ui/toast'
import SectionTitle from '@/components/ui/SectionTitle'
import { useAuth } from '@/stores/auth'
import '../shared.scss'
import './mine.scss'

const preferenceRows = [
  { icon: '🌶️', title: '口味、忌口与过敏', sub: '归属于这个账号（M8 接入）' },
  { icon: '🔔', title: '家庭消息提醒', sub: '菜单安排与饭已做好通知' },
]

const aiRows = [
  { icon: '🤖', title: 'AI 模型配置', sub: 'pi-agent · 自定义 provider 与模型' },
  { icon: '💬', title: '提示词模板', sub: '冰箱识别 / 菜品识别 / 营养分析' },
]

/** 我的：账号与设置（F2-03 资料绑定；退出登录属 F2-02） */
export default function MinePage() {
  const navigate = useNavigate()
  const storedUser = useAuth((state) => state.user)
  const me = useMe()
  const options = useAuthOptions()
  const updateProfile = useUpdateProfile()
  const family = useFamily()

  // 先用本地缓存的账号信息渲染，接口回来后自动替换（避免进页面就闪一下"读取中"）
  const user = me.data ?? storedUser
  const [editing, setEditing] = useState(false)
  const [nickname, setNickname] = useState('')
  const [avatar, setAvatar] = useState('🐰')
  const [email, setEmail] = useState('')
  const [signingOut, setSigningOut] = useState(false)

  // 只在打开编辑时用当前值填充，避免保存失败后把用户正在输入的内容覆盖掉
  useEffect(() => {
    if (editing && user) {
      setNickname(user.nickname)
      setAvatar(user.avatar)
      setEmail(user.email ?? '')
    }
  }, [editing, user])

  const avatars = options.data?.avatars?.length ? options.data.avatars : [user?.avatar ?? '🐰']
  const familySub = family.isPending
    ? '正在读取…'
    : family.data
      ? `${family.data.name} · ${family.data.memberCount} 位成员`
      : '还没建家：创建或用邀请码加入'

  const save = () => {
    updateProfile.mutate(
      // 邮箱留空 = 解绑（传 null），填了就走后端的格式与查重校验
      { nickname: nickname.trim(), avatar, email: email.trim() ? email.trim() : null },
      {
        onSuccess: () => {
          setEditing(false)
          toast.success('资料已更新')
        },
        onError: (error) => toast.error(apiErrorMessage(error)),
      },
    )
  }

  const signOut = async () => {
    setSigningOut(true)
    await logout()
    setSigningOut(false)
    navigate('/login', { replace: true })
  }

  return (
    <Page>
      <div className="pscreen">
        <div className="ptitle">我的</div>

        <div className="me">
          <div className="me__avatar">{user?.avatar ?? '🐰'}</div>
          <div className="me__main">
            <div className="me__name">{user?.nickname ?? '正在读取…'}</div>
            <div className="me__id">账号：{user?.account ?? '—'}</div>
            <div className="me__id" title={user?.email ? `邮箱：${user.email}` : undefined}>
              {user?.email ? `邮箱：${user.email}` : '未绑邮箱（忘记密码时用）'}
            </div>
          </div>
          <button type="button" className="btn-ghost" onClick={() => setEditing((value) => !value)}>
            {editing ? '取消' : '编辑资料'}
          </button>
        </div>

        {editing && (
          <div className="mine-edit">
            <label className="mine-edit__field">
              <span>昵称</span>
              <input
                value={nickname}
                maxLength={16}
                onChange={(event) => setNickname(event.target.value)}
              />
            </label>
            <fieldset className="mine-edit__avatars">
              <legend>头像</legend>
              <div className="mine-edit__row">
                {avatars.map((item) => (
                  <button
                    type="button"
                    key={item}
                    className={['mine-edit__avatar', item === avatar && 'is-active']
                      .filter(Boolean)
                      .join(' ')}
                    aria-pressed={item === avatar}
                    aria-label={`选择头像 ${item}`}
                    onClick={() => setAvatar(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </fieldset>
            <label className="mine-edit__field">
              <span>邮箱（忘了密码时用；不填也行）</span>
              <input
                name="email"
                type="email"
                placeholder="mama@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="mine-edit__save"
              disabled={updateProfile.isPending}
              onClick={save}
            >
              {updateProfile.isPending ? '保存中…' : '保存'}
            </button>
          </div>
        )}

        <SectionTitle title="我的设置" />

        <div className="rows" style={{ marginTop: 0 }}>
          <div
            className="row"
            role="button"
            tabIndex={0}
            onClick={() => navigate('/family', { state: { from: '/mine' } })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') navigate('/family', { state: { from: '/mine' } })
            }}
          >
            <div className="row__icon">👨‍👩‍👧</div>
            <div className="row__main">
              家庭共享与成员
              <div className="row__sub">{familySub}</div>
            </div>
            <span className="row__arrow">›</span>
          </div>
          {preferenceRows.map((row) => (
            <div className="row" key={row.title}>
              <div className="row__icon">{row.icon}</div>
              <div className="row__main">
                {row.title}
                <div className="row__sub">{row.sub}</div>
              </div>
              <span className="row__arrow">›</span>
            </div>
          ))}
        </div>

        <SectionTitle title="AI 设置" />

        <div className="rows" style={{ marginTop: 0 }}>
          {aiRows.map((row) => (
            <div className="row" key={row.title}>
              <div className="row__icon">{row.icon}</div>
              <div className="row__main">
                {row.title}
                <div className="row__sub">{row.sub}</div>
              </div>
              <span className="row__arrow">›</span>
            </div>
          ))}
        </div>

        <button
          type="button"
          className="mine-signout"
          disabled={signingOut}
          onClick={() => {
            void signOut()
          }}
        >
          {signingOut ? '正在退出…' : '退出登录'}
        </button>
      </div>
    </Page>
  )
}
