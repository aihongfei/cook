import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  NOTIFICATION_KINDS, useMarkAllRead, useMarkRead, useNotifications, useUpdateNotificationPrefs,
  type AppNotification, type NotificationKind,
} from '@/api/notifications'
import { apiErrorMessage } from '@/api/client'
import EmptyState from '@/components/ui/EmptyState'
import Page from '@/components/ui/Page'
import PageHeader from '@/components/ui/PageHeader'
import { toast } from '@/components/ui/toast'
import { permissionState, type NotifyPermission } from '@/lib/local-notify'
import { readBackLink } from '@/pages/back-link'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import '../shared.scss'
import './notifications.scss'

/**
 * 通知中心（M10 / F10-01~04）。口径见 D-078。
 *
 * ## 这里显示的**不是"消息"，是"家里现在有什么值得知道的事"**
 *
 * 四条提醒全部由后端从已有事实现算（菜单定下来了 / 饭做好了 / 快过期 / 该备菜了），
 * 所以这个列表会**自己变**：把那一餐取消掉，"饭已做好"那条就没了。
 * 这与"收到过一条消息就永远躺在收件箱里"是两回事，也是刻意选的——
 * 存一份通知表就是给同一个事实存第二份副本，必然会与事实漂移（见 D-078）。
 *
 * ## 三个刻意的做法
 *
 * - **点开才已读**（`POST /notifications/read`）：用户 2026-10-15 的原话是
 *   「需要**真的已读**时才清」「通知那边点进去才清除通知」。所以**不是**"打开这一页就全清"，
 *   而是点开**那一条**（并跳到它指的地方）才算读了它。要清一批就按「全部已读」；
 * - **红点由后端算**，前端不自己减 1：自己改的话"同一件事在两台设备上"这类边界必错
 *   ——标完已读重新取一次，数字以后端为准；
 * - **去处由后端给**（`item.to`）：前端不按 `kind` 写一张跳转表。写第二份的代价是
 *   后端改了去处而前端不知道——那正是"状态机不硬编码"（D-058/D-059 那一族）的同一条理由。
 *
 * ## 权限只到这里为止
 *
 * 开关**按账号**（用户 2026-10-15 选定）：提醒是"打扰我"这件事，别人不能替我决定
 * （与口味档案 F8-01 同一条）。所以这一页任何人都能改自己的，不需要家庭角色。
 */
const KIND_STYLE: Record<NotificationKind, { icon: string; tone: string }> = {
  plan: { icon: '📋', tone: 'is-plan' },
  done: { icon: '🍲', tone: 'is-done' },
  expiry: { icon: '⏳', tone: 'is-expiry' },
  prep: { icon: '🧺', tone: 'is-prep' },
}

export default function NotificationsPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const back = readBackLink(location.state, '/mine')
  const board = useNotifications()
  const prefs = useUpdateNotificationPrefs()
  const markRead = useMarkRead()
  const markAllRead = useMarkAllRead()

  const items = board.data?.items ?? []
  const unreadItems = items.filter((item) => item.unread)
  const myPrefs = board.data?.prefs

  /*
   * 系统通知权限状态：只用来**如实说明**（比如"被系统关掉了、去设置里打开"），
   * 不是开关——手机弹窗提醒默认开着（用户 2026-10-14 定的）。
   * 浏览器里是 'unsupported'，那段话自然不出现。
   */
  const [notifyState, setNotifyState] = useState<NotifyPermission | null>(null)
  useEffect(() => {
    void permissionState().then(setNotifyState)
  }, [])


  /**
   * 点开一条：**先标已读，再跳走**。
   *
   * 顺序不能反——先跳走的话这一页会被卸载，标记请求发不发得出去全看运气
   * （用户会看到"我点过了，红点还在"）。所以先发请求、再 `navigate`；
   * 而 `navigate` 不等待它（标记失败也不该挡着用户去看那一件事，那才是他真正要做的）。
   */
  const openItem = (item: AppNotification) => {
    if (item.unread) markRead.mutate(item.id)
    navigate(item.to, { state: { from: '/notifications' } })
  }

  const toggle = (key: (typeof NOTIFICATION_KINDS)[number]['key'], next: boolean) => {
    prefs.mutate({ [key]: next }, {
      onError: (error) => toast.error(apiErrorMessage(error)),
      onSuccess: () => toast.success(next ? `已打开「${labelOf(key)}」` : `已关掉「${labelOf(key)}」`),
    })
  }

  const readAll = () => {
    markAllRead.mutate(unreadItems.map((item) => item.id), {
      onError: (error) => toast.error(apiErrorMessage(error)),
      onSuccess: () => toast.success('都标成已读了'),
    })
  }

  return (
    <Page>
      <div className="pscreen notifications">
        <Link className="page-back" to={back.to}>← {back.label}</Link>
        <PageHeader title="家里的消息" subtitle="菜单、饭好了、快过期、该备菜" art="recipes" />

        {board.isPending && <RecipeStatus title="正在看看家里有什么事…" loading />}
        {board.isError && (
          <RecipeStatus title="消息暂时打不开" onRetry={() => { void board.refetch() }}>
            {apiErrorMessage(board.error)}
          </RecipeStatus>
        )}

        {board.data && items.length === 0 && (
          <div className="notifications__empty">
            <EmptyState
              emoji="✅"
              title="眼下没什么要处理的"
              desc="菜单定了、饭做好了、有东西快过期、或者哪一餐还空着，都会在这儿告诉你。"
            />
            <Link className="recipe-button notifications__go" to="/order" state={{ from: '/notifications' }}>
              去看看今天的菜单
            </Link>
          </div>
        )}

        {items.length > 0 && (
          <>
            <div className="notifications__head">
              <p className="notifications__summary">
                眼下 {items.length} 件事{unreadItems.length > 0 && ` · ${unreadItems.length} 条没看过`}
              </p>
              {/*
                一键已读（用户 2026-10-15 要的）。只在真有未读时出现——
                没有未读时摆一个点了没反应的按钮，那是"假入口"（D-066 定的规矩）。
              */}
              {unreadItems.length > 0 && (
                <button type="button" className="notifications__read-all" disabled={markAllRead.isPending} onClick={readAll}>
                  全部已读
                </button>
              )}
            </div>
            <div className="rows notifications__list">
              {items.map((item) => (
                <NotificationRow key={item.id} item={item} onGo={() => openItem(item)} />
              ))}
            </div>
          </>
        )}

        {/*
          四个开关（F10-04）。放在列表**下面**：用户是来看有什么事的，
          不是来配置的；配置完还能顺手往上看一眼。
        */}
        {myPrefs && (
          <>
            <p className="notifications__summary">要提醒我什么</p>
            <div className="rows notifications__prefs">
              {NOTIFICATION_KINDS.map((kind) => (
                <label className="row notifications__pref" key={kind.key}>
                  <div className="row__main">
                    {kind.title}
                    <div className="row__sub">{kind.desc}</div>
                  </div>
                  {/*
                    原生 checkbox 而不是 antd-mobile 的 Switch：这一页的开关是**即时生效**的，
                    而 Switch 的动画在移动端的连点下会出现"看着关了其实开着"（本项目在
                    抽屉拖拽上踩过同类：状态跟手但提交慢）。原生控件的行为是确定的。
                  */}
                  <input
                    type="checkbox"
                    className="notifications__switch"
                    checked={myPrefs[kind.key]}
                    disabled={prefs.isPending}
                    onChange={(event) => toggle(kind.key, event.target.checked)}
                    aria-label={kind.title}
                    role="switch"
                    aria-checked={myPrefs[kind.key]}
                  />
                </label>
              ))}
            </div>
            {/*
              一条说明（不是开关）：手机弹窗提醒**默认开着**（用户 2026-10-14：
              「这个是默认的，不用设置」「删掉这块配置」），所以这里不再放任何可配的东西——
              但必须留一句话说清**哪些会弹、哪些只在应用里看得到**：
              本机能算的那两类（到点做饭、有东西到期）关掉 App 也会弹；
              "别人点了菜"这类远端事件没有推送通道就送不到（RISKS R-63），不说用户会以为坏了。
              被系统拒了的情形换成"去设置里打开"那条路——**不给按钮**（系统不会再弹框，
              点了没反应就是假入口，D-066）。
            */}
            {notifyState === 'denied' ? (
              <p className="notifications__hint">
                这台手机把系统通知关掉了，提醒弹不出来。到手机的「设置 → 应用 → 御膳 → 通知」里打开就会响。
                别人点了菜这类「家里刚发生的事」仍然只在应用内看得到，打开就看到。
              </p>
            ) : (
              <p className="notifications__note">
                手机上也会提醒：定了菜单的那一餐到饭点前一小时、冰箱里有东西到期那天早上，会弹一下——关掉这个应用也会响。
                别人点了菜这类「家里刚发生的事」仍然只在应用内看得到，打开就看到。
              </p>
            )}
          </>
        )}
      </div>
    </Page>
  )
}

/** 一条提醒。整行可点（去处由后端给，见文件头） */
function NotificationRow({ item, onGo }: { item: AppNotification; onGo: () => void }) {
  const style = KIND_STYLE[item.kind]
  return (
    <button type="button" className={`row notifications__row${item.unread ? ' is-unread' : ''}`} onClick={onGo}>
      <div className={`row__icon ${style.tone}`.trim()}>{style.icon}</div>
      <div className="row__main">
        {item.title}
        {item.body && <div className="row__sub">{item.body}</div>}
      </div>
      {/* 小标（"菜单""做好了"）——**后端给**，前端不按 kind 拼第二份文案 */}
      <span className="notifications__tag">{item.tag}</span>
    </button>
  )
}

/** 提示语里用的名字：从同一份 `NOTIFICATION_KINDS` 取，不另写一张表 */
function labelOf(key: string): string {
  return NOTIFICATION_KINDS.find((kind) => kind.key === key)?.title ?? key
}
