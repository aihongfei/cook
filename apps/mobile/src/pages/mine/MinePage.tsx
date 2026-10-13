import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { logout, useAuthOptions, useMe, useUpdateProfile } from '@/api/auth'
import { useCheckInStats } from '@/api/checkins'
import { useFamily } from '@/api/family'
import { useFavorites } from '@/api/favorites'
import { useRecipes } from '@/api/recipes'
import Heatmap from '@/components/ui/Heatmap'
import PageHeader from '@/components/ui/PageHeader'
import Page from '@/components/ui/Page'
import { toast } from '@/components/ui/toast'
import SectionTitle from '@/components/ui/SectionTitle'
import { useAuth } from '@/stores/auth'
import '../shared.scss'
import '../checkins/checkins.scss'
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
  // 打卡统计（M9 / F9-03）：没加入家庭时不请求（后端会 404，打卡是家庭内的）
  const checkins = useCheckInStats({ enabled: Boolean(family.data) })
  // 收藏数只用于入口那一行的副标题（F1-09）；没登录时后端 401，hook 自己不发请求
  const favorites = useFavorites()
  /*
   * 「我的菜谱」那一行的数量（F1-12）：借列表接口的第一页要 `total`，**不另开统计接口**——
   * 一行副标题不值得一个新端点与一套新的失效逻辑。没登录/没家庭时它自然为空。
   * 单独给 `useRecipes` 一份只读第一页的查询：入口只需要一个数，不需要翻页。
   */
  const own = useRecipes({ mine: true })

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
        <PageHeader title="我的" art="mine" />

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

        {/* 我收藏的菜（M1 / F1-09）：放在「我的打卡」上面——收藏是随手的，
            比"回看照片"更常翻；而且它不需要家庭（收藏是私人偏好） */}
        <SectionTitle title="我的菜" />
        <Link className="me-entry" to="/favorites" state={{ from: '/mine' }}>
          <span className="me-entry__icon">❤️</span>
          <span className="me-entry__text">
            我收藏的菜
            <small>{favorites.data ? `${favorites.data.total} 道` : '想做的时候来这儿找'}</small>
          </span>
          <span className="me-entry__arrow">›</span>
        </Link>
        {/* 我的菜谱（F1-12）：与收藏并列放在"我的菜"下——两行都是"翻我自己的菜"，
            数量口径也一样（有数就报数，没有就说这项是干什么的） */}
        <Link className="me-entry" to="/recipes/mine" state={{ from: '/mine' }}>
          <span className="me-entry__icon">📝</span>
          <span className="me-entry__text">
            我的菜谱
            <small>{own.data ? `${own.data.pages[0]?.total ?? 0} 道 · 自己上传的` : '自己上传的菜，随时能改'}</small>
          </span>
          <span className="me-entry__arrow">›</span>
        </Link>

        <SectionTitle title="我的打卡" />

        {family.data && checkins.data ? (
          <div className="me-checkin">
            {/*
              张数只在一处出现（热力图自己的图例里「N 天有打卡 · 共 M 张」）：
              这里原本还挂着「共 N 张」与「全家一起攒了 M 张」，同一页三个数字容易互相打架。
              入口放右上、与"连续打卡"同一行——它俩都是"这一块"的摘要，放一起最省一行高度。
            */}
            <div className="me-checkin__head">
              <span className="me-checkin__streak">
                连续打卡 <b>{checkins.data.mine.streak}</b> 天
              </span>
              <Link className="me-checkin__more" to="/checkins" state={{ from: '/mine' }}>
                去打卡墙看看 →
              </Link>
            </div>
            <Heatmap grid={checkins.data.mine} emptyHint="还没有打卡照片：做了一道好菜就拍一张。" />
          </div>
        ) : (
          <div className="rows" style={{ marginTop: 0 }}>
            <div className="row">
              <div className="row__icon">📷</div>
              <div className="row__main">
                打卡与家庭相册
                <div className="row__sub">
                  {family.isPending ? '正在读取…' : family.data ? '统计加载中…' : '先创建或加入家庭，才能和家人一起打卡'}
                </div>
              </div>
              <span className="row__arrow">›</span>
            </div>
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
