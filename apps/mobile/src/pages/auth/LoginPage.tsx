import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { useLogin } from '@/api/auth'
import { useAuth } from '@/stores/auth'
import './auth.scss'

interface LocationState { from?: string }

/** 登录（F2-01）：账号 + 密码，未登录不可使用（D-008） */
export default function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const login = useLogin()
  const token = useAuth((state) => state.token)
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  // 已登录还来登录页就直接送进厨房（例如手动输地址）
  if (token) return <Navigate to="/kitchen" replace />

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    setError('')
    login.mutate(
      { account: account.trim(), password },
      {
        onSuccess: () => {
          const from = (location.state as LocationState | null)?.from
          navigate(from && from !== '/login' ? from : '/kitchen', { replace: true })
        },
        onError: (err) => setError(apiErrorMessage(err)),
      },
    )
  }

  return (
    <div className="auth">
      <div className="auth__hero">
        <div className="auth__mark">御膳</div>
        <h1 className="auth__title">回来啦</h1>
        <p className="auth__sub">登录后才能点菜、记菜谱，家里的菜单大家才看得到</p>
      </div>

      <form className="auth__card" onSubmit={onSubmit}>
        <label className="auth__field">
          <span>账号</span>
          <input
            name="account"
            autoComplete="username"
            placeholder="手机号 / 邮箱 / 自定账号"
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
            autoComplete="current-password"
            placeholder="至少 8 位，含字母与数字"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>

        {error && <p className="auth__error" role="alert">{error}</p>}

        <button type="submit" className="auth__submit" disabled={login.isPending}>
          {login.isPending ? '正在登录…' : '登录'}
        </button>

        <p className="auth__switch">
          还没有账号？<Link to="/register">注册一个</Link>
        </p>
        <p className="auth__hint">首版不做短信与第三方登录，只有账号 + 密码（D-008）</p>
      </form>
    </div>
  )
}
