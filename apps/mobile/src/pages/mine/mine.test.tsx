// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import type { NotificationBoard } from '@/api/notifications'
import { boardFixture, notificationFixture } from '@/api/notifications.testkit'
import { Toaster, useToasts } from '@/components/ui/toast'
import { useAuth } from '@/stores/auth'
import MinePage from './MinePage'

// 我的页（F2-03 资料）：账号展示、编辑资料、退出登录。
// 头像选择器那段是重点：它的选中态只体现在 class 上（`mine-edit__avatar is-active`），
// 曾经因为少一个空格拼成 `mine-edit__avataris-active`，连基础样式（38×38 圆形）都一起丢了。

const AVATARS = ['🍳', '🐰', '🐻']
const clients: QueryClient[] = []

function renderMine() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  clients.push(client)
  return render(
    <QueryClientProvider client={client}>
      <Toaster />
      <MemoryRouter>
        <MinePage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const ME = {
  id: 'u1',
  account: 'mama',
  nickname: '妈妈',
  avatar: '🍳',
  email: 'mama@example.com',
  createdAt: new Date().toISOString(),
}

/**
 * 装一份 `apiClient.get` 的假实现。
 *
 * `unread` 给"未读几条"（M10 那一行的副标题要它）。
 * **不做第二次 spyOn 去覆盖某一条**：spyOn 叠在已 spy 的方法上时，
 * 里层那份先匹配上，外层的实现根本轮不到（第一次写这条用例就是这么红的）。
 */
/**
 * 装后端。
 *
 * 第二个参数是**一整份通知看板**（不只是一个未读数）：2026-10-16 之后
 * 「我的」页要用它画三行的小红点（打卡/家庭/菜谱），那几行看的是
 * `unreadByKind` 里各自的类——只给一个总数是不够的。
 * 传数字则当"整页未读总数"（老用例这么用的，保持兼容）。
 */
function mockGet(family: unknown = null, notifications: number | NotificationBoard = 0) {
  vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url === '/auth/options') {
      return Promise.resolve({
        data: {
          accountMaxLength: 20,
          passwordMinLength: 6,
          passwordMaxLength: 64,
          avatars: AVATARS,
        },
      } as never)
    }
    if (url === '/auth/me') return Promise.resolve({ data: ME } as never)
    if (url === '/family') return Promise.resolve({ data: family } as never)
    /*
     * 未读数（M10）：那一行的副标题用它。默认**给 0**——这些用例里它是个背景数据，
     * 不是被测行为；要验"有未读时显示几条"就单独给一份（见下面那条）。
     */
    if (url === '/notifications') {
      const board = typeof notifications === 'number'
        ? boardFixture({ unread: notifications })
        : notifications
      return Promise.resolve({ data: board } as never)
    }
    if (url === '/checkins/stats') {
      return Promise.resolve({
        data: {
          mine: {
            weeks: [], from: '2026-06-15', to: '2026-10-12',
            totalDays: 1, totalCount: 4, streak: 1,
          },
          family: { weeks: [], from: '2026-06-15', to: '2026-10-12', totalDays: 2, totalCount: 5, streak: 1 },
          mineTotal: 4,
          familyTotal: 5,
          attachableMeals: [],
        },
      } as never)
    }
    throw new Error(`未预期的请求：${url}`)
  })
}

beforeEach(() => {
  localStorage.clear()
  useToasts.setState({ items: [] })
  useAuth.getState().setSession({ token: 'access-1', refreshToken: 'refresh-1', user: ME })
  mockGet()
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

async function openEditor() {
  renderMine()
  fireEvent.click(await screen.findByRole('button', { name: '编辑资料' }))
}

it('展示账号与邮箱，邮箱为空时给出去绑的说明', async () => {
  renderMine()
  expect(await screen.findByText('账号：mama')).toBeTruthy()
  expect(screen.getByText('邮箱：mama@example.com')).toBeTruthy()
})

it('编辑资料时当前头像标为选中，点头像能换选中态', async () => {
  await openEditor()

  const current = screen.getByRole('button', { name: '选择头像 🍳' })
  // 两个 class 都要在：少一个修饰类只是没高亮，丢了基础类会让 38×38 圆形整个消失
  expect(current.classList.contains('mine-edit__avatar')).toBe(true)
  expect(current.classList.contains('is-active')).toBe(true)
  expect(current.getAttribute('aria-pressed')).toBe('true')

  const next = screen.getByRole('button', { name: '选择头像 🐰' })
  expect(next.classList.contains('is-active')).toBe(false)

  fireEvent.click(next)
  expect(next.classList.contains('is-active')).toBe(true)
  expect(next.getAttribute('aria-pressed')).toBe('true')
  expect(current.classList.contains('is-active')).toBe(false)
})

it('保存把昵称、头像与邮箱发给后端，成功后收起表单并提示', async () => {
  const patch = vi
    .spyOn(apiClient, 'patch')
    .mockResolvedValue({ data: { ...ME, nickname: '小艾', avatar: '🐰' } } as never)
  await openEditor()

  fireEvent.change(screen.getByDisplayValue('妈妈'), { target: { value: '小艾' } })
  fireEvent.click(screen.getByRole('button', { name: '选择头像 🐰' }))
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith('/auth/me', {
      nickname: '小艾',
      avatar: '🐰',
      email: 'mama@example.com',
    }),
  )
  expect(await screen.findByText('资料已更新')).toBeTruthy()
})

/*
 * 「我的菜」这一节（F1-12 + F9-02 / D-076）：从**两行收成一行**——
 * 原先「我收藏的菜」与「我的菜谱」各占一行，加上新做的「我做过」就是三个入口，
 * 而它们回答的是同一个问题（"我自己跟菜有关的那些"）。项目纪律是"一件事一个入口"（D-066），
 * 现在只留这一行，进去是三个 tab。
 */
it('「我的菜」收成一行：指向 /recipes/mine，且没有第二个并列入口', async () => {
  renderMine()

  const link = await screen.findByRole('link', { name: /我的菜谱/ })
  expect(link.getAttribute('href')).toBe('/recipes/mine')
  expect(link.classList.contains('me-entry')).toBe(true)
  // 数量拿不到时给说明文字（有数报数，没有就说这一项是干什么的）
  expect(link.textContent).toContain('做过的、收藏的和自己写的')

  /*
   * 这条是这次改动的重点：**「我收藏的菜」那一行不该再单独出现**。
   * 收藏没有消失（它是「我的菜谱」里的第二个 tab），但入口只能有一个——
   * 哪天有人把它加回「我的」页，用户面对的又是三个并列入口。
   */
  expect(screen.queryByRole('link', { name: /我收藏的菜/ })).toBeNull()

  /*
   * 「我的菜」这一节里**只有一个**入口。
   *
   * ⚠️ 判据不能用"文本里有没有'收藏'两个字"：那一行的副标题本身就把三个 tab 列出来了
   * （"做过的、收藏的和自己写的"），所以它必然含"收藏"——第一版这么写，红了，
   * 而产品是对的、断言是错的。要看的是**入口的个数**，不是词的出现。
   */
  const dishEntries = [...document.querySelectorAll('.me-entry')].filter((node) =>
    /我的菜谱/.test(node.textContent ?? ''),
  )
  expect(dishEntries).toHaveLength(1)
  // 那一行本身把三个视角说清了（用户不用点进去才知道里面有什么）
  expect(dishEntries[0].textContent).toContain('做过的、收藏的和自己写的')
})

it('打卡块的张数只出现一处，且打卡墙入口在"连续打卡"同一行的右侧', async () => {  const FAMILY = {
    id: 'f1', name: '小满一家', shared: true, inviteCode: 'H65WAJ',
    createdAt: new Date().toISOString(), memberCount: 2, memberLimit: 10,
    myRole: 'OWNER', myCapabilities: [], members: [],
  }
  mockGet(FAMILY)
  renderMine()

  // 入口与"连续打卡"同处一行（head 里）
  const head = (await screen.findByText(/连续打卡/)).closest('.me-checkin__head')
  expect(head).toBeTruthy()
  const link = screen.getByRole('link', { name: /去打卡墙看看/ })
  expect(link.getAttribute('href')).toBe('/checkins')
  expect(head!.contains(link)).toBe(true)

  // 张数只留热力图图例里那处（曾经同时挂着「共 N 张」和「全家一起攒了 M 张」，三个数字互相打架）
  const counts = screen.getAllByText(/共 \d+ 张/)
  expect(counts).toHaveLength(1)
  expect(counts[0].textContent).toContain('1 天有打卡')
  expect(screen.queryByText(/全家一起攒了/)).toBeNull()
})

it('邮箱清空时传 null（解绑），不是空字符串', async () => {
  const patch = vi
    .spyOn(apiClient, 'patch')
    .mockResolvedValue({ data: { ...ME, email: null } } as never)
  await openEditor()

  fireEvent.change(screen.getByDisplayValue('mama@example.com'), { target: { value: '  ' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith('/auth/me', expect.objectContaining({ email: null })),
  )
})

/*
 * 「我的设置」这一段的口径（用户 2026-10-13：「口味与忌口和我的设置中的重复了，
 * 保留我的设置中的」「下面又有一堆菜单，太乱了」）。
 *
 * 要盯住两件事：
 * ① **口味与忌口只有一个入口**（原来「我的菜」下面还独立成一节，两个入口说同一件事）；
 * ② **设置行要么能点、要么明说还没做**——改前「AI 设置」那两行带箭头却点了没反应，
 *    而 AI 根本是部署时用 .env 配的（D-009），用户改不了。
 */
it('口味与忌口只有一个入口（在「我的设置」里），且它真的能点', async () => {
  renderMine()

  const links = await screen.findAllByRole('link', { name: /口味/ })
  expect(links).toHaveLength(1)
  expect(links[0].getAttribute('href')).toBe('/taste')
  // 副标题说清现状（几项忌口 / 几位家人还没写），不是一个箭头了事
  expect(links[0].className).toContain('row')
})

it('消息提醒那一行是真入口（M10 落地后不再是「还没做」的占位）', async () => {
  renderMine()
  await screen.findByRole('link', { name: /口味/ })

  /*
   * 这一行原来是"还没做"的占位（不画箭头、标一颗 tag），2026-10-15 M10 落地后变成真入口。
   * 要盯住的是**它真的能点**——占位变入口时最容易忘的就是把它接上，
   * 于是用户看到一个点了没反应的箭头（那正是这个项目在 D-066 定下的规矩要防的事）。
   */
  const link = screen.getByText('家庭消息提醒').closest('a') as HTMLAnchorElement
  expect(link).toBeTruthy()
  expect(link.getAttribute('href')).toBe('/notifications')
  expect(link.querySelector('.row__arrow')).toBeTruthy()
  /*
   * 没有未读时说清这一页管什么（不写"0 条"）。
   *
   * 这段文案 2026-10-16 跟着提醒范围一起扩了（用户：「家庭相关修改的都需要通知」）——
   * 所以断的是**它把那几块列出来了**，不是某个具体措辞：措辞还会变，
   * 而"用户在这一行就能知道这里管哪些事"才是要保住的那条。
   */
  const sub = link.querySelector('.row__sub')?.textContent ?? ''
  for (const topic of ['菜单', '订单', '冰箱', '打卡', '家人', '菜谱']) {
    expect(sub).toContain(topic)
  }

  // AI 是部署时配的（.env / D-009），界面上没有可改的东西 —— 那两行连同整节都下线了
  expect(screen.queryByText('AI 模型配置')).toBeNull()
  expect(screen.queryByText('提示词模板')).toBeNull()
  expect(screen.queryByText('AI 设置')).toBeNull()
})

it('有未读时那一行的副标题报数（那是用户点它的理由）', async () => {
  // beforeEach 已经装了一份 unread=0 的；这里换一份有 3 条未读的
  vi.restoreAllMocks()
  mockGet(null, 3)
  renderMine()

  /*
   * 等**副标题变**，不是等那一行出现：那一行在查询回来之前就渲染了（副标题先落到
   * "这一页管什么"那句默认文案）。第一次写这条用例就是栽在这儿——
   * 拿到的是加载态那一帧，看起来像"未读没生效"。
   */
  await waitFor(() => {
    const link = screen.getByText('家庭消息提醒').closest('a') as HTMLAnchorElement
    expect(link.querySelector('.row__sub')?.textContent).toBe('3 条新消息')
  })
})

it('打卡/家庭/菜谱三行各有自己的小红点（用户 2026-10-16：家里的事也要在这页看得出来）', async () => {
  /*
   * 这三块**不亮底栏**（底栏五个 Tab 里没有打卡墙/家庭页/我的菜谱的入口），
   * 所以红点只能落在这一页对应的那几行上——不给标记的话，家里人传了打卡照、
   * 换了邀请码、改了你家菜谱，用户在这一页完全看不出来。
   *
   * 数从 `unreadByKind` 来（后端按 kind 数好的），三行的分组在这一页做：
   * 打卡 + 评论同属"打卡墙"那一行（它们也是同一个开关）。
   */
  vi.restoreAllMocks()
  mockGet({
    id: 'f1', name: '小满一家', shared: true, inviteCode: 'H65WAJ',
    createdAt: new Date().toISOString(), memberCount: 2, memberLimit: 10,
    myRole: 'OWNER', myCapabilities: [], members: [],
  }, boardFixture({
    items: [
      notificationFixture({ id: 'checkin:1', kind: 'checkin', unread: true }),
      notificationFixture({ id: 'comment:1', kind: 'comment', unread: true }),
      notificationFixture({ id: 'family:1', kind: 'family', unread: true }),
      notificationFixture({ id: 'recipe:1', kind: 'recipe', unread: true }),
      notificationFixture({ id: 'recipe:2', kind: 'recipe', unread: true }),
    ],
  }))
  renderMine()

  /*
   * 打卡那一行：**两个数合成一个**（上传 1 + 评论 1 = 2），写在
   * "去打卡墙看看"那句话里（那颗小圆标在这一行会跟"连续打卡"抢注意力）。
   */
  await waitFor(() => {
    expect(document.querySelector('.me-checkin__count')?.textContent).toBe('2')
  })

  // 家庭那一行与菜谱那一行各挂一颗（菜谱是 2）
  const badges = [...document.querySelectorAll('.me-badge')].map((node) => node.textContent)
  expect(badges.sort()).toEqual(['1', '2'])
})

it('没有未读时这三行**不挂空标记**（0 不画，免得看着像"有 0 件事"）', async () => {
  vi.restoreAllMocks()
  mockGet({
    id: 'f1', name: '小满一家', shared: true, inviteCode: 'H65WAJ',
    createdAt: new Date().toISOString(), memberCount: 2, memberLimit: 10,
    myRole: 'OWNER', myCapabilities: [], members: [],
  }, boardFixture())
  renderMine()

  await screen.findByText('家庭消息提醒')
  expect(document.querySelector('.me-badge')).toBeNull()
  expect(document.querySelector('.me-checkin__count')).toBeNull()
})
