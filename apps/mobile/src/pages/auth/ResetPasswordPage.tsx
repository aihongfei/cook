import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { useResetPassword } from '@/api/auth'
import './auth.scss'

/** 重设密码（F2-04）：从邮件链接进来，带一次性令牌 */
export default function ResetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const reset = useResetPassword()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    setError('')
    // 两次输入不一致是本地就能判定的错误，不必打扰后端
    if (password !== confirm) {
      setError('两次输入的密码不一样')
      return
    }
    reset.mutate(
      { token, password },
      {
        onSuccess: () => setDone(true),
        onError: (err) => setError(apiErrorMessage(err)),
      },
    )
  }

  if (!token) {
    return (
      <div className="auth">
        <div className="auth__hero">
          <div className="auth__mark">御膳</div>
          <h1 className="auth__title">链接不对</h1>
          <p className="auth__sub">这个页面要从邮件里的链接进来，链接里带着重设用的凭证</p>
        </div>
        <div className="auth__card">
          <p className="auth__switch">
            <Link to="/forgot">重新发一封</Link>
          </p>
        </div>
      </div>
    )
  }

  if (done) {
    return (
      <div className="auth">
        <div className="auth__hero">
          <div className="auth__mark">御膳</div>
          <h1 className="auth__title">改好了</h1>
          <p className="auth__sub">旧密码已经失效，之前登录过的设备也需要重新登录</p>
        </div>
        <div className="auth__card">
          <p className="auth__switch">
            <Link to="/login">去登录</Link>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="auth">
      <div className="auth__hero">
        <div className="auth__mark">御膳</div>
        <h1 className="auth__title">设置新密码</h1>
        <p className="auth__sub">至少 8 位，要有字母也有数字</p>
      </div>

      <form className="auth__card" onSubmit={onSubmit}>
        <label className="auth__field">
          <span>新密码</span>
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            placeholder="至少 8 位，含字母与数字"
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
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            required
          />
        </label>
        {error && <p className="auth__error" role="alert">{error}</p>}
        <button type="submit" className="auth__submit" disabled={reset.isPending}>
          {reset.isPending ? '正在保存…' : '保存新密码'}
        </button>
      </form>
    </div>
  )
}
