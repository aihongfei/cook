import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { useAuthOptions, useRegister } from '@/api/auth'
import { useAuth } from '@/stores/auth'
import './auth.scss'

/** 内置兜底头像：接口还没回来时也能选，避免注册页闪一下空白 */
const FALLBACK_AVATARS = ['🐰', '🍳', '🐱', '🐻', '🐼', '🦊', '🌸', '🥕']

/** 注册（F2-01）：账号 + 密码 + 昵称 + 头像 */
export default function RegisterPage() {
  const navigate = useNavigate()
  const register = useRegister()
  const token = useAuth((state) => state.token)
  const options = useAuthOptions()
  const avatars = options.data?.avatars?.length ? options.data.avatars : FALLBACK_AVATARS

  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [nickname, setNickname] = useState('')
  const [avatar, setAvatar] = useState(FALLBACK_AVATARS[0])
  const [error, setError] = useState('')

  if (token) return <Navigate to="/kitchen" replace />

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (password !== confirm) {
      setError('两次输入的密码不一样')
      return
    }
    register.mutate(
      { account: account.trim(), password, nickname: nickname.trim() || undefined, avatar },
      {
        onSuccess: () => navigate('/kitchen', { replace: true }),
        onError: (err) => setError(apiErrorMessage(err)),
      },
    )
  }

  return (
    <div className="auth">
      <div className="auth__hero">
        <div className="auth__mark">御膳</div>
        <h1 className="auth__title">先认识一下</h1>
        <p className="auth__sub">家里几个人就注册几个账号，各自点各自想吃的</p>
      </div>

      <form className="auth__card" onSubmit={onSubmit}>
        <label className="auth__field">
          <span>账号</span>
          <input
            name="account"
            autoComplete="username"
            placeholder={`手机号 / 邮箱 / 自定账号（最多 ${options.data?.accountMaxLength ?? 32} 位）`}
            value={account}
            onChange={(event) => setAccount(event.target.value)}
            required
          />
        </label>
        <label className="auth__field">
          <span>密码</span>
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            placeholder={`${options.data?.passwordMinLength ?? 8}–${options.data?.passwordMaxLength ?? 64} 位，含字母与数字`}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <label className="auth__field">
          <span>再输一次</span>
          <input
            name="confirm"
            type="password"
            autoComplete="new-password"
            placeholder="确认密码"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            required
          />
        </label>
        <label className="auth__field">
          <span>怎么称呼你</span>
          <input
            name="nickname"
            placeholder="比如：妈妈 / 老爸 / 小厨"
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
          />
        </label>

        <fieldset className="auth__avatars">
          <legend>挑个头像</legend>
          <div className="auth__avatars-row">
            {avatars.map((item) => (
              <button
                type="button"
                key={item}
                className={`auth__avatar${item === avatar ? ' is-active' : ''}`}
                aria-pressed={item === avatar}
                aria-label={`选择头像 ${item}`}
                onClick={() => setAvatar(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </fieldset>

        {error && <p className="auth__error" role="alert">{error}</p>}

        <button type="submit" className="auth__submit" disabled={register.isPending}>
          {register.isPending ? '正在创建…' : '创建账号'}
        </button>

        <p className="auth__switch">
          已经有账号了？<Link to="/login">去登录</Link>
        </p>
      </form>
    </div>
  )
}
