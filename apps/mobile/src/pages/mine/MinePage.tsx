import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { logout, useAuthOptions, useMe, useUpdateProfile } from '@/api/auth'
import { useCheckInStats } from '@/api/checkins'
import { useFamily } from '@/api/family'
import { useFavorites } from '@/api/favorites'
import { useCooked } from '@/api/cooked'
import { useTasteFamily } from '@/api/taste'
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

/**
 * 我的：账号与设置（F2-03 资料绑定；退出登录属 F2-02）
 *
 * 「我的设置」这一段的口径（2026-10-13 用户提「口味与忌口和我的设置中的重复了」「下面又有一堆菜单，太乱了」之后定的）：
 *
 * - **一件事只有一个入口**：口味与忌口原来既在「我的菜」下面独立成节、又在「我的设置」里占一行（且那一行还点不动）。
 *   现在只留「我的设置」里这一行，**且它真的能点**（带实时状态：几项忌口 / 几位家人还没写）；
 * - **没做的东西不画成能点的样子**：原来「AI 设置」那一整节（AI 模型配置 / 提示词模板）两行都带箭头、点了毫无反应——
 *   而 AI 本来就是**部署时用 `.env` 配的**（D-009），不是用户能在界面上改的东西。
 *   已整节下线；消息提醒（M10）还没开工，保留一行但**没有箭头、标着「还没做」**，不装成入口。
 *   规矩：设置行**要么能点，要么明说还没做**——画一个点不动的箭头，用户只会以为 App 坏了。
 */
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
   * 「做过的」那个数（F9-01）。这里要的是 `total`，但**故意用默认那份查询**（不是 limit=1）：
   * 它和「我的菜谱」的「做过的」tab 是**同一个 query key**，于是用户点进那一行时列表已经在缓存里
   * ——省掉一次转圈。为省几十条数据换一次白等的加载，不划算（家庭场景这个列表本来就不长）。
   */
  const cooked = useCooked()
  const taste = useTasteFamily()
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

  /*
   * 「我的菜」那一行的副标题（F9-02 / D-076）：把"做过的"与"收藏的"两个数并起来说。
   *
   * 两个数据源都**可能还没回来**（或为空），所以不写成固定句式：
   * 只报已经知道的那些；一个都没有时说这一项是干什么的（与原来两行各自的做法一致）。
   * 不做"0 道"那种写法——它看着像"你没有"，而其实可能只是还没加载完。
   */
  const myDishesSub = (() => {
    const parts: string[] = []
    if (cooked.data && cooked.data.total > 0) parts.push(`做过的 ${cooked.data.total} 道`)
    if (favorites.data && favorites.data.total > 0) parts.push(`收藏的 ${favorites.data.total} 道`)
    if (own.data && (own.data.pages[0]?.total ?? 0) > 0) parts.push(`原创的 ${own.data.pages[0]?.total ?? 0} 道`)
    return parts.length > 0 ? parts.join(' · ') : '做过的、收藏的和自己写的，都在这儿'
  })()

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

        {/*
          我的菜（F1-12 + F9-02，三视角见 D-076）：**一行**进「我的菜谱」，
          里面三个 tab（做过的 / 收藏的 / 原创的）。

          原先这里是**两行**（我收藏的菜 / 我的菜谱），加上新做的「我做过」就是三行——
          而它们回答的是同一个问题："我自己跟菜有关的那些"。项目纪律是"一件事一个入口"
          （D-066），所以收成一行。两个数合并成一个副标题："做过的 N 道 · 收藏 M 道"——
          放两个数是因为它们是两个不同的维度（我做过什么 / 我要做什么），
          而**标题只写一个**（"我的菜"），否则又变成两行的味道了。
        */}
        <SectionTitle title="我的菜" />
        <Link className="me-entry" to="/recipes/mine" state={{ from: '/mine' }}>
          <span className="me-entry__icon">🍽️</span>
          <span className="me-entry__text">
            我的菜谱
            <small>{myDishesSub}</small>
          </span>
          <span className="me-entry__arrow">›</span>
        </Link>

        {/*
          口味与忌口（M8 / F8-01、F8-02）**只在「我的设置」里给一个入口**（见文件头那段）。
          原来它在这里独立成节、又在下面「我的设置」里占一行虚位——同一件事两个入口，
          而且那一个还点不动（用户当场问「怎么没法点击」）。
        */}

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
          {/*
            行一律用 `<Link>`（不是 div + onClick）：键盘、读屏、"在新标签打开"这些
            都由浏览器原生语义兜住，不必自己复刻一份 role/tabIndex/keydown。
          */}
          <Link className="row" to="/family" state={{ from: '/mine' }}>
            <div className="row__icon">👨‍👩‍👧</div>
            <div className="row__main">
              家庭共享与成员
              <div className="row__sub">{familySub}</div>
            </div>
            <span className="row__arrow">›</span>
          </Link>
          <Link className="row" to="/taste" state={{ from: '/mine' }}>
            <div className="row__icon">🌶️</div>
            <div className="row__main">
              口味、忌口与过敏
              <div className="row__sub">{tasteText(taste.data)}</div>
            </div>
            <span className="row__arrow">›</span>
          </Link>
          {/*
            消息提醒（M10）还没做：**不画箭头、不装成入口**，但要留一句话——
            "以后会有这个设置"本身是有用的信息，而一个点不动的箭头只会让人以为坏了。
          */}
          <div className="row row--soon">
            <div className="row__icon">🔔</div>
            <div className="row__main">
              家庭消息提醒
              <div className="row__sub">菜单安排与饭已做好通知</div>
            </div>
            <span className="row__tag">还没做</span>
          </div>
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

/**
 * 那一行副标题说什么（M8）。
 *
 * 三态都要说人话，尤其**第二态**：写过但"不限"的人不少（他填了备注或口味偏好），
 * 显示"已设置"会让人以为有忌口保护；显示"还没写"又是假的。所以按"有没有硬判据"分。
 */
function tasteText(data: { me: { filled: boolean; allergies: string[]; dislikes: string[]; spicyLevel: number | null } | null; missing: string[] } | undefined): string {
  if (!data) return '谁能吃什么，写下来才会提醒'
  const me = data.me
  if (!me?.filled) return '还没写 · 写了才会按忌口提醒'
  const hard = me.allergies.length + me.dislikes.length
  const missing = data.missing.length
  const parts: string[] = []
  parts.push(hard > 0 ? `${hard} 项忌口` : '不限')
  if (missing > 0) parts.push(`${missing} 位家人还没写`)
  return parts.join(' · ')
}
