import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { useRequestPasswordReset } from '@/api/auth'
import './auth.scss'

/**
 * 忘记密码（F2-04）：填绑定邮箱 → 后端发一次性重置链接。
 *
 * 无论邮箱是否存在都提示同一句话 —— 否则这个页面就成了"查这个邮箱注册过没有"的工具。
 * 开发期后端用 console 邮件（MAIL_TRANSPORT=console），会把链接直接回给页面，省得翻日志。
 */
export default function ForgotPasswordPage() {
  const forgot = useRequestPasswordReset()
  const [email, setEmail] = useState('')
  const [done, setDone] = useState(false)
  const [devUrl, setDevUrl] = useState('')
  const [error, setError] = useState('')

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    setError('')
    forgot.mutate(email.trim(), {
      onSuccess: (result) => {
        setDone(true)
        setDevUrl(result.devResetUrl ?? '')
      },
      onError: (err) => setError(apiErrorMessage(err)),
    })
  }

  return (
    <div className="auth">
      <div className="auth__hero">
        <div className="auth__mark">御膳</div>
        <h1 className="auth__title">忘了密码</h1>
        <p className="auth__sub">填注册时绑的邮箱，我们把重设链接发给你</p>
      </div>

      {done ? (
        <div className="auth__card">
          <p className="auth__note">
            如果这个邮箱绑过账号，重设链接已经发出去了，1 小时内有效、只能用一次。
            <br />
            没收到就看一眼垃圾邮件，或者回来再发一次。
          </p>
          {devUrl && (
            <p className="auth__devurl" role="status">
              开发模式：邮件没有真发出去（MAIL_TRANSPORT=console）。点这里继续：
              <br />
              <a href={devUrl}>{devUrl}</a>
            </p>
          )}
          <p className="auth__switch">
            <Link to="/login">回登录页</Link>
          </p>
        </div>
      ) : (
        <form className="auth__card" onSubmit={onSubmit}>
          <label className="auth__field">
            <span>邮箱</span>
            <input
              name="email"
              type="email"
              autoComplete="email"
              placeholder="mama@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          {error && <p className="auth__error" role="alert">{error}</p>}
          <button type="submit" className="auth__submit" disabled={forgot.isPending}>
            {forgot.isPending ? '正在发送…' : '发送重设链接'}
          </button>
          <p className="auth__switch">
            想起来了？<Link to="/login">回登录页</Link>
          </p>
          <p className="auth__hint">没绑过邮箱的话用不了这个办法——可以让家里的掌勺人帮你联系管理员。</p>
        </form>
      )}
    </div>
  )
}
