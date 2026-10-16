import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import {
  useTasteFamily,
  useTasteOptions,
  useUpdateTaste,
  type TasteProfile,
} from '@/api/taste'
import BackLink from '@/components/ui/BackLink'
import { useBackLink } from '@/lib/back-target'
import BottomSheet from '@/components/ui/BottomSheet'
import Page from '@/components/ui/Page'
import PageHeader from '@/components/ui/PageHeader'
import SectionTitle from '@/components/ui/SectionTitle'
import { toast } from '@/components/ui/toast'
import '../shared.scss'
import './taste.scss'

/**
 * 口味与忌口（M8 / F8-01、F8-02）。
 *
 * 这一页只做一件事：**把"谁能吃什么"说清楚**。它下面挂着三个功能——
 * 推荐过滤（F5-03）、点菜提醒（F3-08）、AI 每轮对话的上下文（F8-02 的批注）——
 * 所以这里写下的每一个词都会真的改变别处的行为。四处刻意的设计：
 *
 * ① **过敏与忌口分开，且反复说清后果**：过敏是"绝对不能吃"（推荐里排掉、点菜时警告），
 *    忌口是"不爱吃"（只是提示）。两者混在一起的话，用户会按"我不爱吃芹菜"的随意程度
 *    去填过敏栏，而那一栏是硬判据。所以过敏那一块带一句"推荐里会自动排掉含这些的菜"。
 *
 * ② **没写就说没写，不假装护上了**：页头明说"还有 X 人没写"并点名。这是整块最危险的地方——
 *    用户看到"口味已设置"会以为全家都被护上了，而实际上可能只有他自己填了，
 *    家里对花生过敏的那位一片空白，推荐照常推花生。
 *
 * ③ **不硬拦荤素**：荤素倾向只作为给 AI 的偏好（"多吃素"不是禁忌）。
 *    界面上也这么写，免得用户以为设了它肉菜就看不见了。
 *
 * ④ **改一改是抽屉弹上来的，不是页面下面铺开一段**（2026-10-13 用户当场提的）：
 *    原先编辑面板挂在页尾，点「改一改」时它在**首屏之外**（实测 top≈803，可视区 768）——
 *    点了屏幕上没有任何变化，用户以为"这块没法点击"（他的原话）。
 *    现在用与冰箱录入同一个 `BottomSheet`（自下而上滑出、带遮罩、可下拖关掉），
 *    点下去立刻看得见；页面本身也只留下"读"的内容，不再往下堆一长串词。
 */
export default function TastePage() {
  const location = useLocation()
  const backLink = useBackLink(location.state, '/mine')
  const family = useTasteFamily()
  const options = useTasteOptions()
  const update = useUpdateTaste()

  const me = family.data?.me ?? null
  const [editing, setEditing] = useState(false)

  const save = (patch: Partial<Pick<TasteProfile, 'spicyLevel' | 'flavors' | 'diet' | 'allergies' | 'dislikes' | 'note'>>) => {
    update.mutate(patch, {
      onSuccess: () => {
        setEditing(false)
        toast.success('记下了')
      },
      onError: (error) => toast.error(apiErrorMessage(error)),
    })
  }

  return (
    <Page>
      {/*
        `.pscreen` 是页头与角落插画的共同锚点（`position: relative` + 顶部 18px 呼吸），
        全站每个二级页都包着它——这一页原来**漏了**（当时用裸 `<Page>`），
        于是返回键贴到屏幕最顶上（top=0，别的页是 18），页头下面的间距也少了一截。
        用户当场看出「顶部返回和下面 tip 的间距和其他页都不一致」，就是这一处。
      */}
      <div className="pscreen">
        <BackLink to={backLink.to} label={backLink.label} />

        <PageHeader
          title="口味与忌口"
          subtitle="写下来的会用在推荐、点菜提醒和 AI 对话里"
          art="mine"
        />

        {family.isPending && <p className="taste__hint">正在看家里人的口味…</p>}

        {family.isError && (
          <p className="taste__hint">读不到档案，下拉刷新试试。</p>
        )}

        {family.data && (
          <>
            {/*
              「还没写的人」要在最上面：它是"这套设置现在有多大保护"的答案。
              不显示的话，用户会默认全家都写过了。
            */}
            {family.data.missing.length > 0 && (
              <p className="taste__missing">
                还有 {family.data.missing.join('、')} 没写。写了才会按他的忌口提醒——
                没写的人，推荐里不会替他避开任何东西。
              </p>
            )}

            <SectionTitle title="我" />
            <div className="taste__card">
              <Field
                label="辣"
                value={me?.spicyLevel === null || me?.spicyLevel === undefined ? '不限' : (options.data?.spicyLevels[me.spicyLevel] ?? '不限')}
                onEdit={() => setEditing(true)}
              />
              <Field label="过敏" value={listText(me?.allergies)} tone="danger" onEdit={() => setEditing(true)} hint="推荐里会排掉含这些的菜，点菜时也会提醒" />
              <Field label="不吃" value={listText(me?.dislikes)} onEdit={() => setEditing(true)} hint="只是提醒，不会拦着你点" />
              <Field label="口味" value={listText(me?.flavors)} onEdit={() => setEditing(true)} />
              <Field label="荤素" value={me?.diet ?? '无偏好'} onEdit={() => setEditing(true)} hint="只影响推荐倾向，不会把肉菜藏起来" />
              {me?.note && <Field label="备注" value={me.note} onEdit={() => setEditing(true)} />}
              {!me?.filled && (
                <p className="taste__empty">还没写过。填了之后，推荐会排掉你不能吃的，点菜时也会提醒。</p>
              )}
            </div>

            <button type="button" className="recipe-button taste__edit" onClick={() => setEditing(true)}>
              {me?.filled ? '改一改' : '开始写'}
            </button>

            {/* 全家：只读。谁的档案谁能改——"我对花生过敏"这件事只有本人说得准 */}
            <SectionTitle title="全家" />
            <ul className="taste__family">
              {family.data.members.map((member) => (
                <li className="taste__member" key={member.userId}>
                  <span className="taste__avatar">{member.avatar}</span>
                  <span className="taste__who">
                    {member.nickname}
                    <small>{member.filled ? summaryOf(member) : '还没写'}</small>
                  </span>
                  {member.userId === me?.userId && <span className="taste__mine">我</span>}
                </li>
              ))}
            </ul>
            <p className="taste__foot">只能改自己那一份；家里人的自己写。</p>
          </>
        )}
      </div>

      {/*
        编辑抽屉：`{editing && …}` 是既有做法（FridgeStock 那两处一样）——
        打开时才挂载，`visible` 直接写 true；BottomSheet 内部会先渲染成关着的再翻成开着，
        让入场动画有起始值。
      */}
      {editing && (
        <TasteEditor
          visible
          profile={me}
          options={options.data}
          pending={update.isPending}
          onClose={() => setEditing(false)}
          onSave={save}
        />
      )}
    </Page>
  )
}

/** 一行只读展示（点它就进编辑） */
function Field({
  label,
  value,
  hint,
  tone,
  onEdit,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'danger'
  onEdit: () => void
}) {
  return (
    <button type="button" className={`taste__field${tone === 'danger' ? ' taste__field--danger' : ''}`} onClick={onEdit}>
      <span className="taste__label">{label}</span>
      <span className="taste__value">
        {value}
        {hint && <small>{hint}</small>}
      </span>
    </button>
  )
}

/**
 * 编辑抽屉（M8）。用**点选 + 可自己写**而不是纯输入框：忌口与过敏的词高度重复
 * （香菜、花生、虾），让人从零打字既慢又容易打出"香莱"这种错词——而错词会让判据悄悄失效
 * （"香莱"匹配不到任何配料，于是这个人看起来"没有忌口"）。点一下就把标准词填进去；
 * 真有不常见的（折耳根、苋菜）也能自己写。
 *
 * 三件事刻意的：
 * - **存下来是主动动作，关掉就是不改**（`onClose` 只收起抽屉，一个字都不发）：
 *   点选立刻生效会让人不敢随便点（每点一下都在改全家看到的推荐）；
 * - **下拖关闭等同"先不改"**（BottomSheet 自带的手势）：与"点遮罩"同一条语义；
 * - **按钮在抽屉内容最后**：内容长时它跟着滚（`sheet__body` 自滚，见 BottomSheet 的说明），
 *   不会浮在屏幕中间挡着那几个词。
 */
function TasteEditor({
  visible,
  profile,
  options,
  pending,
  onClose,
  onSave,
}: {
  visible: boolean
  profile: TasteProfile | null
  options: { spicyLevels: string[]; diets: string[]; allergies: string[]; dislikes: string[]; flavors: string[] } | undefined
  pending: boolean
  onClose: () => void
  onSave: (patch: Partial<Pick<TasteProfile, 'spicyLevel' | 'flavors' | 'diet' | 'allergies' | 'dislikes' | 'note'>>) => void
}) {
  const [spicy, setSpicy] = useState<number | null>(profile?.spicyLevel ?? null)
  const [allergies, setAllergies] = useState<string[]>(profile?.allergies ?? [])
  const [dislikes, setDislikes] = useState<string[]>(profile?.dislikes ?? [])
  const [flavors, setFlavors] = useState<string[]>(profile?.flavors ?? [])
  const [diet, setDiet] = useState<string | null>(profile?.diet ?? null)
  const [note, setNote] = useState(profile?.note ?? '')
  const [draft, setDraft] = useState<{ field: 'allergies' | 'dislikes'; text: string } | null>(null)

  const toggle = (list: string[], set: (next: string[]) => void, word: string) => {
    set(list.includes(word) ? list.filter((item) => item !== word) : [...list, word])
  }

  return (
    <BottomSheet visible={visible} title={profile?.filled ? '改一改' : '写口味与忌口'} onClose={onClose}>
      <SectionTitle title="辣度" />
      <div className="taste-editor__chips">
        <Chip active={spicy === null} onClick={() => setSpicy(null)}>不限</Chip>
        {(options?.spicyLevels ?? ['不吃辣', '微辣', '中辣', '重辣']).map((label, index) => (
          <Chip key={label} active={spicy === index} onClick={() => setSpicy(index)}>{label}</Chip>
        ))}
      </div>

      <SectionTitle title="过敏（会真的排掉这些菜）" />
      <p className="taste-editor__warn">写进来的词会用在配料表上——推荐里排掉含它的菜，点菜时也会提醒。只写真的不能吃的。</p>
      <TagBlock
        list={allergies}
        suggestions={options?.allergies ?? []}
        draft={draft?.field === 'allergies' ? draft.text : null}
        onToggle={(word) => toggle(allergies, setAllergies, word)}
        onDraft={(text) => setDraft(text === null ? null : { field: 'allergies', text })}
        onAdd={(word) => { if (!allergies.includes(word)) setAllergies([...allergies, word]); setDraft(null) }}
      />

      <SectionTitle title="不爱吃（只提醒，不拦）" />
      <TagBlock
        list={dislikes}
        suggestions={options?.dislikes ?? []}
        draft={draft?.field === 'dislikes' ? draft.text : null}
        onToggle={(word) => toggle(dislikes, setDislikes, word)}
        onDraft={(text) => setDraft(text === null ? null : { field: 'dislikes', text })}
        onAdd={(word) => { if (!dislikes.includes(word)) setDislikes([...dislikes, word]); setDraft(null) }}
      />

      <SectionTitle title="口味偏好" />
      <div className="taste-editor__chips">
        {(options?.flavors ?? []).map((word) => (
          <Chip key={word} active={flavors.includes(word)} onClick={() => toggle(flavors, setFlavors, word)}>{word}</Chip>
        ))}
      </div>

      <SectionTitle title="荤素" />
      <div className="taste-editor__chips">
        <Chip active={diet === null} onClick={() => setDiet(null)}>无偏好</Chip>
        {(options?.diets ?? []).filter((word) => word !== '无偏好').map((word) => (
          <Chip key={word} active={diet === word} onClick={() => setDiet(word)}>{word}</Chip>
        ))}
      </div>
      <p className="taste-editor__warn">荤素只是推荐时的倾向，不会把肉菜从你眼前藏起来。</p>

      <SectionTitle title="备注" />
      <input
        className="taste-editor__note"
        value={note}
        maxLength={60}
        placeholder="还有别的要求？如：医生说要少盐"
        onChange={(event) => setNote(event.target.value)}
      />

      <div className="taste-editor__actions">
        <button type="button" className="recipe-button" disabled={pending} onClick={onClose}>先不改</button>
        <button
          type="button"
          className="recipe-button taste-editor__save"
          disabled={pending}
          onClick={() => onSave({
            spicyLevel: spicy,
            allergies,
            dislikes,
            flavors,
            diet,
            note: note.trim() || null,
          })}
        >
          {pending ? '正在存…' : '存下来'}
        </button>
      </div>
    </BottomSheet>
  )
}

/** 一排可点/可自己写的词（过敏与忌口共用） */
function TagBlock({
  list,
  suggestions,
  draft,
  onToggle,
  onDraft,
  onAdd,
}: {
  list: string[]
  suggestions: string[]
  draft: string | null
  onToggle: (word: string) => void
  onDraft: (text: string | null) => void
  onAdd: (word: string) => void
}) {
  // 用户自己写进来的词（不在建议里）也要显示出来，否则他看不出自己写过什么
  const extra = list.filter((word) => !suggestions.includes(word))
  return (
    <>
      <div className="taste-editor__chips">
        {[...suggestions, ...extra].map((word) => (
          <Chip key={word} active={list.includes(word)} onClick={() => onToggle(word)}>{word}</Chip>
        ))}
        <Chip active={draft !== null} onClick={() => onDraft(draft === null ? '' : null)}>自己写…</Chip>
      </div>
      {draft !== null && (
        <div className="taste-editor__custom">
          <input
            className="taste-editor__input"
            value={draft}
            maxLength={12}
            placeholder="打一个词，如：折耳根"
            autoFocus
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && draft.trim()) onAdd(draft.trim()) }}
          />
          <button type="button" className="taste-editor__confirm" disabled={!draft.trim()} onClick={() => onAdd(draft.trim())}>
            加上
          </button>
        </div>
      )}
    </>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={`taste-chip${active ? ' is-active' : ''}`} onClick={onClick}>
      {children}
    </button>
  )
}

/** 空列表说"没写"而不是留一片空白（空白看不出是"没有"还是"没加载出来"） */
function listText(list: string[] | undefined): string {
  return list && list.length > 0 ? list.join('、') : '没写'
}

/** 全家里一个人的一行摘要 */
function summaryOf(member: TasteProfile): string {
  const parts: string[] = []
  if (member.allergies.length) parts.push(`过敏：${member.allergies.join('、')}`)
  if (member.dislikes.length) parts.push(`不吃：${member.dislikes.join('、')}`)
  if (member.spicyLevel === 0) parts.push('不吃辣')
  if (member.diet) parts.push(member.diet)
  return parts.join(' · ') || '写过（不限）'
}
