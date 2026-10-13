import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import {
  fetchRecipe,
  recipeErrorMessage,
  useCreateRecipe,
  useDeleteRecipe,
  useRecipeFilters,
  useUpdateRecipe,
  type Recipe as RecipeDetail,
  type RecipeDraft,
} from '@/api/recipes'
import ConfirmDialog from '@/components/ui/ConfirmDialog'
import Page from '@/components/ui/Page'
import PageHeader from '@/components/ui/PageHeader'
import { toast } from '@/components/ui/toast'
import { readBackLink } from '@/pages/back-link'
import RecipeStatus from './components/RecipeStatus'
import '../shared.scss'
import './recipes.scss'

/*
 * 上限与后端 `recipe.rules` 逐条对齐。这里**再写一遍**是有意的：
 * 后端那层的校验（400 的中文 message）不能省——它才是唯一权威；
 * 而前端这一层是为了"别让人写完一屏才被打回来"，所以两边必须同一个数。
 * 名字/品类/菜系用 `maxLength` 硬顶，配料与步骤的条数在前面的 validate 里顶。
 */
const NAME_MAX = 40
const CATEGORY_MAX = 12
const CUISINE_MAX = 12
const TAG_MAX = 10
const TAGS_MAX = 8
const INGREDIENT_NAME_MAX = 20
const INGREDIENT_AMOUNT_MAX = 20
const INGREDIENTS_MAX = 30
const STEP_MAX = 200
const STEPS_MAX = 30
const NOTE_MAX = 60
const NOTES_MAX = 5
const CALORIES_MIN = 0
const CALORIES_MAX = 10_000

/** 表单里的一行配料 / 一步做法 */
interface IngredientDraft {
  name: string
  amount: string
}

interface FormState {
  name: string
  category: string
  cuisine: string
  /** 标签用顿号/逗号分隔的一行文本：逐条输入太磨人，家常菜的标签也就三五个 */
  tags: string
  ingredients: IngredientDraft[]
  steps: string[]
  /** 备注按行写（一条一行），提交时拆成列表 */
  notes: string
  calories: string
}

/** 表单能改的那几项（`aliases` 不在表单里，见 `updatable` 的说明） */
type EditableDraft = Omit<RecipeDraft, 'aliases'>

const emptyIngredient = (): IngredientDraft => ({ name: '', amount: '' })

/** 常用品类/菜系：只做**输入建议**，不是枚举——用户自己家的菜想叫什么就叫什么 */
const CATEGORY_SUGGESTIONS = ['家常', '素菜', '荤菜', '汤羹', '主食', '凉菜', '甜品']
const CUISINE_SUGGESTIONS = ['家常', '川菜', '粤菜', '湘菜', '鲁菜', '西餐', '日韩']

/** 新表单：配料与做法各留两行空位（一行太像"只能写一条"，三行又长得吓人） */
function blankForm(): FormState {
  return {
    name: '',
    category: '',
    cuisine: '',
    tags: '',
    ingredients: [emptyIngredient(), emptyIngredient()],
    steps: ['', ''],
    notes: '',
    calories: '',
  }
}

/** 详情 → 回填用的表单值。配料与步骤**至少留一行**：全空的列表上连个能点的地方都没有 */
function formOf(recipe: RecipeDetail): FormState {
  return {
    name: recipe.name,
    category: recipe.category,
    cuisine: recipe.cuisine,
    tags: recipe.tags.join('、'),
    ingredients: recipe.ingredients.length > 0 ? recipe.ingredients.map((row) => ({ ...row })) : [emptyIngredient()],
    steps: recipe.steps.length > 0 ? [...recipe.steps] : [''],
    notes: recipe.notes.join('\n'),
    calories: recipe.calories === null ? '' : String(recipe.calories),
  }
}

/** 一行文本 → 去空、去重、保序的列表（与后端 textList 同一口径：顿号/逗号/换行都是分隔符） */
function splitList(raw: string): string[] {
  const out: string[] = []
  for (const piece of raw.split(/[,，、\n]/)) {
    const value = piece.trim()
    if (value && !out.includes(value)) out.push(value)
  }
  return out
}

/**
 * 热量。它是唯一一个"可空但填了要能算"的字段：空 = 后端记成 null（"不知道"），
 * 界面照 `caloriesLabel` 说"热量暂无"。所以这里不做必填检查，只在填了时看它像不像个数。
 * 返回 `'bad'` 而不是抛错：校验要一次把话说清楚，而不是中断在第一个问题上。
 */
function parseCalories(raw: string): number | null | 'bad' {
  const text = raw.trim()
  if (!text) return null
  const value = Number(text)
  if (!Number.isFinite(value) || value < CALORIES_MIN || value > CALORIES_MAX) return 'bad'
  return Math.round(value)
}

/** 表单 → 可提交的那几项（空行/空串在这里统一变成后端的"没有"） */
function draftOf(form: FormState): EditableDraft {
  const parsed = parseCalories(form.calories)
  return {
    name: form.name.trim(),
    category: form.category.trim(),
    cuisine: form.cuisine.trim(),
    tags: splitList(form.tags),
    ingredients: form.ingredients
      .filter((row) => row.name.trim() || row.amount.trim())
      .map((row) => ({ name: row.name.trim(), amount: row.amount.trim() })),
    steps: form.steps.map((step) => step.trim()).filter(Boolean),
    notes: splitList(form.notes),
    calories: parsed === 'bad' ? null : parsed,
  }
}

/** 服务端那一份的同样形状（编辑时拿它当比较基准） */
function draftOfRecipe(recipe: RecipeDetail): EditableDraft {
  return {
    name: recipe.name,
    category: recipe.category,
    cuisine: recipe.cuisine,
    tags: recipe.tags,
    ingredients: recipe.ingredients,
    steps: recipe.steps,
    notes: recipe.notes,
    calories: recipe.calories,
  }
}

/**
 * 写 / 改一道菜谱（F1-12）。
 *
 * 分两层是有原因的：**回填只发生一次**。
 * 若把 detail 与表单放同一个组件、用 effect 把数据写进 state，那么详情被 react-query
 * 后台重取（换了新对象）时会把用户正在写的内容整片覆盖掉（本项目在"我的"页踩过同一类坑）。
 * 所以这里让表单挂在一个 `key` 上：进页面时初始化一次，之后谁重取都不动它。
 *
 * 编辑时的比较基准是**回填那一刻服务端的那一份**（不是重取后的），
 * 因此"用户没碰过的字段"永远不会被写回去——PATCH 的语义就是只改你提的那些。
 */
export default function RecipeFormPage() {
  const { id = '' } = useParams()
  const location = useLocation()
  const isEdit = Boolean(id)
  const back = readBackLink(location.state, isEdit ? `/recipes/${id}` : '/recipes/mine')

  const detail = useQuery({
    queryKey: ['recipes', 'detail', id],
    queryFn: ({ signal }) => fetchRecipe(id, signal),
    // 新建时不请求：id 是空的，`/recipes/` 会是一个 404
    enabled: isEdit,
    retry: 1,
  })

  return (
    <Page>
      <div className="pscreen recipe-form-page">
        <Link className="page-back" to={back.to}>← {back.label}</Link>
        <PageHeader
          title={isEdit ? '改这道菜谱' : '写一道菜谱'}
          subtitle={isEdit ? '改完还是你们家的菜' : '自己家的味道，记下来就不会丢'}
          art="recipes"
        />

        {isEdit && detail.isPending && <RecipeStatus title="正在取回这道菜谱…" loading />}
        {isEdit && detail.isError && !detail.data && (
          <RecipeStatus title="这道菜谱暂时打不开" onRetry={() => { void detail.refetch() }}>
            {recipeErrorMessage(detail.error)}
          </RecipeStatus>
        )}

        {/*
         * 拿不到详情就**不画表单**：空表单提交出去等于又新建了一道菜，
         * 而那正是用户最不想要的结果（他想改的是一道已有菜）。
         */}
        {(!isEdit || detail.data) && <RecipeForm key={id || 'new'} id={id} recipe={detail.data} />}
      </div>
    </Page>
  )
}

function RecipeForm({ id, recipe }: { id: string; recipe?: RecipeDetail }) {
  const navigate = useNavigate()
  const isEdit = Boolean(id)
  const options = useRecipeFilters()
  const create = useCreateRecipe()
  const update = useUpdateRecipe()
  const remove = useDeleteRecipe()

  const [form, setForm] = useState<FormState>(() => (recipe ? formOf(recipe) : blankForm()))
  // 比较基准：**进页面时服务端那一份**（后台重取不改它，理由见文件头）
  const [baseline] = useState(() => (recipe ? draftOfRecipe(recipe) : null))
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState(false)

  const patch = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
    // 一边改一边把上次的错误擦掉："菜名还没写"在用户开始打字之后就该消失
    if (error) setError('')
  }

  const editIngredient = (index: number, key: keyof IngredientDraft, value: string) => {
    setForm((current) => ({
      ...current,
      ingredients: current.ingredients.map((row, at) => (at === index ? { ...row, [key]: value } : row)),
    }))
    if (error) setError('')
  }

  const editStep = (index: number, value: string) => {
    setForm((current) => ({
      ...current,
      steps: current.steps.map((step, at) => (at === index ? value : step)),
    }))
    if (error) setError('')
  }

  const dropRow = (key: 'ingredients' | 'steps', index: number) => {
    setForm((current) => ({ ...current, [key]: current[key].filter((_, at) => at !== index) }))
    if (error) setError('')
  }

  /** 校验：**只说第一处**（一次列五条会让人不知道该先改哪个），合法则返回空串 */
  const validate = (draft: EditableDraft): string => {
    if (!draft.name) return '菜名还没写'
    if (draft.name.length > NAME_MAX) return `菜名最多 ${NAME_MAX} 个字`
    if (!draft.category) return '还没写这道菜是什么品类（如 家常、素菜）'
    if (draft.category.length > CATEGORY_MAX) return `品类最多 ${CATEGORY_MAX} 个字`
    if (!draft.cuisine) return '还没写这道菜属于哪个菜系（如 家常、川菜）'
    if (draft.cuisine.length > CUISINE_MAX) return `菜系最多 ${CUISINE_MAX} 个字`

    if (draft.tags.length > TAGS_MAX) return `标签最多 ${TAGS_MAX} 个`
    if (draft.tags.some((tag) => tag.length > TAG_MAX)) return `标签里每个最多 ${TAG_MAX} 个字`

    if (draft.ingredients.length > INGREDIENTS_MAX) return `配料最多 ${INGREDIENTS_MAX} 条`
    for (const row of draft.ingredients) {
      // 用量可空（"盐适量"是常态），但既然写了这一行，**名字不能空**——没名字没法买
      if (!row.name) return `有一条配料只写了用量（${row.amount}），没写是什么`
      if (row.name.length > INGREDIENT_NAME_MAX) return `配料名最多 ${INGREDIENT_NAME_MAX} 个字`
      if (row.amount.length > INGREDIENT_AMOUNT_MAX) return `配料用量最多 ${INGREDIENT_AMOUNT_MAX} 个字`
    }

    if (draft.steps.length === 0) return '至少写一步做法'
    if (draft.steps.length > STEPS_MAX) return `步骤最多 ${STEPS_MAX} 步`
    if (draft.steps.some((step) => step.length > STEP_MAX)) return `每一步最多 ${STEP_MAX} 个字`

    if (draft.notes.length > NOTES_MAX) return `备注最多 ${NOTES_MAX} 条`
    if (draft.notes.some((note) => note.length > NOTE_MAX)) return `每条备注最多 ${NOTE_MAX} 个字`

    if (parseCalories(form.calories) === 'bad') return `热量看着不太对（${CALORIES_MIN}～${CALORIES_MAX} 千卡）`
    return ''
  }

  /**
   * 编辑时算出**真正改过的字段**。
   *
   * 为什么不能整份发：PATCH 的语义是"只改传了的字段"，把表单整份发过去就等于
   * 把别处刚写的内容覆盖回去——用户只想改一个用量，没必要连带重写步骤。
   * 基准是回填那一刻的那一份，所以"改回原样"也不会发出去（空 PATCH 会被后端以
   * 400「没有要改的内容」打回）。
   */
  const changedFields = (next: EditableDraft): Partial<EditableDraft> => {
    if (!baseline) return next
    const changed: Partial<EditableDraft> = {}
    if (next.name !== baseline.name) changed.name = next.name
    if (next.category !== baseline.category) changed.category = next.category
    if (next.cuisine !== baseline.cuisine) changed.cuisine = next.cuisine
    if (next.tags.join('\n') !== baseline.tags.join('\n')) changed.tags = next.tags
    // 配料比的是整段的 JSON：数组里的对象逐项比会写成一串 if，而这一处一次比完就够
    if (JSON.stringify(next.ingredients) !== JSON.stringify(baseline.ingredients)) changed.ingredients = next.ingredients
    if (next.steps.join('\n') !== baseline.steps.join('\n')) changed.steps = next.steps
    if (next.notes.join('\n') !== baseline.notes.join('\n')) changed.notes = next.notes
    if (next.calories !== baseline.calories) changed.calories = next.calories
    return changed
  }

  /** 存不成时把后端那句话**同时**放到表单里与 toast 上：前者贴在眼前，后者保证提交后一定看得见 */
  const fail = (failure: unknown) => {
    const message = apiErrorMessage(failure)
    setError(message)
    toast.error(message)
  }

  const submit = () => {
    const draft = draftOf(form)
    const invalid = validate(draft)
    if (invalid) {
      setError(invalid)
      toast.error(invalid)
      return
    }
    if (isEdit) {
      const changed = changedFields(draft)
      if (Object.keys(changed).length === 0) {
        toast.success('没有要改的地方')
        navigate(`/recipes/${encodeURIComponent(id)}`)
        return
      }
      update.mutate(
        { id, patch: changed },
        {
          onSuccess: () => {
            toast.success('改好了')
            navigate(`/recipes/${encodeURIComponent(id)}`)
          },
          onError: fail,
        },
      )
      return
    }
    create.mutate(
      // 别名由导入器/AI 维护、不在表单里：新建时本来就该是空的（编辑时也不碰它，见 changedFields）
      { ...draft, aliases: [] },
      {
        onSuccess: (created) => {
          toast.success('菜谱写好了')
          // 建完进这一道的详情：用户多半想再看一眼自己刚写的东西对不对
          navigate(`/recipes/${encodeURIComponent(created.id)}`)
        },
        // 后端的中文 message（重名那条尤其有用："你们家已经有一道…"）原样显示，不自己编文案
        onError: fail,
      },
    )
  }

  const confirmDelete = () => {
    if (!id) return
    remove.mutate(id, {
      onSuccess: (result) => {
        setDeleting(false)
        toast.success(`已删掉「${result.name}」`)
        navigate('/recipes/mine')
      },
      onError: (failure) => {
        setDeleting(false)
        toast.error(apiErrorMessage(failure))
      },
    })
  }

  const pending = create.isPending || update.isPending
  const busy = pending || remove.isPending

  return (
    <>
      <form
        className="recipe-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy) submit()
        }}
      >
        {/* 校验与后端的报错都落在这儿：常驻在表单上方，提交后必然可见（下面的字段可能已滚出屏幕） */}
        <p className="recipe-form__error" role="alert" aria-live="polite">
          {error}
        </p>

        <label className="recipe-form__field">
          <span>菜名</span>
          <input
            value={form.name}
            maxLength={NAME_MAX}
            placeholder="如：外婆的红烧肉"
            onChange={(event) => patch('name', event.target.value)}
          />
        </label>

        <div className="recipe-form__row">
          {/*
           * 品类/菜系的建议来自**库里实际存在的值**（filters 接口）+ 几个常用词。
           * 后端不收枚举，做成单选会让"我家祖传的糊辣汤算什么菜系"变成一个填不下去的框；
           * 用 datalist 而不是 Chips，正是因为后者是互斥的单选，而这里要的是"可以自己写"。
           */}
          <label className="recipe-form__field">
            <span>品类</span>
            <input
              value={form.category}
              maxLength={CATEGORY_MAX}
              placeholder="如：荤菜"
              list="recipe-categories"
              onChange={(event) => patch('category', event.target.value)}
            />
          </label>
          <label className="recipe-form__field">
            <span>菜系</span>
            <input
              value={form.cuisine}
              maxLength={CUISINE_MAX}
              placeholder="如：家常"
              list="recipe-cuisines"
              onChange={(event) => patch('cuisine', event.target.value)}
            />
          </label>
          <datalist id="recipe-categories">
            {[...new Set([...(options.data?.categories ?? []), ...CATEGORY_SUGGESTIONS])].map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
          <datalist id="recipe-cuisines">
            {[...new Set([...(options.data?.cuisines ?? []), ...CUISINE_SUGGESTIONS])].map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </div>

        <label className="recipe-form__field">
          <span>标签（用顿号或逗号隔开，最多 {TAGS_MAX} 个）</span>
          <input
            value={form.tags}
            placeholder="如：下饭、快手"
            onChange={(event) => patch('tags', event.target.value)}
          />
        </label>

        <div className="recipe-form__field">
          <span>配料（名字必写，用量可以不写）</span>
          {form.ingredients.map((row, index) => (
            <div className="recipe-form__ingredient" key={index}>
              <input
                aria-label={`第 ${index + 1} 条配料名`}
                value={row.name}
                maxLength={INGREDIENT_NAME_MAX}
                placeholder="如：五花肉"
                onChange={(event) => editIngredient(index, 'name', event.target.value)}
              />
              <input
                aria-label={`第 ${index + 1} 条配料用量`}
                value={row.amount}
                maxLength={INGREDIENT_AMOUNT_MAX}
                placeholder="如：500g"
                onChange={(event) => editIngredient(index, 'amount', event.target.value)}
              />
              <button
                type="button"
                className="recipe-form__remove"
                aria-label={`删掉第 ${index + 1} 条配料`}
                // 最后一行不给删：配料表整个空了，用户就只剩"退出去重来"一条路
                disabled={form.ingredients.length <= 1}
                onClick={() => dropRow('ingredients', index)}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="recipe-form__add"
            onClick={() => patch('ingredients', [...form.ingredients, emptyIngredient()])}
          >
            ＋ 加一条配料
          </button>
        </div>

        <div className="recipe-form__field">
          <span>做法（至少一步）</span>
          {form.steps.map((step, index) => (
            <div className="recipe-form__step" key={index}>
              <textarea
                aria-label={`第 ${index + 1} 步做法`}
                value={step}
                maxLength={STEP_MAX}
                rows={2}
                placeholder={index === 0 ? '如：五花肉切块，冷水下锅焯水' : '接着写下一步…'}
                onChange={(event) => editStep(index, event.target.value)}
              />
              <button
                type="button"
                className="recipe-form__remove"
                aria-label={`删掉第 ${index + 1} 步`}
                disabled={form.steps.length <= 1}
                onClick={() => dropRow('steps', index)}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="recipe-form__add"
            onClick={() => patch('steps', [...form.steps, ''])}
          >
            ＋ 加一步
          </button>
        </div>

        <label className="recipe-form__field">
          <span>掌勺小贴士（一行一条，最多 {NOTES_MAX} 条）</span>
          <textarea
            value={form.notes}
            rows={3}
            placeholder="如：糖色别炒糊"
            onChange={(event) => patch('notes', event.target.value)}
          />
        </label>

        <label className="recipe-form__field">
          <span>热量（千卡，可不填）</span>
          <input
            value={form.calories}
            inputMode="numeric"
            placeholder="如：480"
            onChange={(event) => patch('calories', event.target.value)}
          />
        </label>

        <div className="recipe-form__actions">
          {isEdit && (
            <button type="button" className="recipe-form__delete" disabled={busy} onClick={() => setDeleting(true)}>
              删掉这道
            </button>
          )}
          <button type="submit" className="recipe-form__submit" disabled={busy}>
            {pending ? '正在存…' : isEdit ? '存好' : '写好收着'}
          </button>
        </div>
      </form>

      <ConfirmDialog
        open={deleting}
        title="删掉这道菜谱"
        message={`「${form.name.trim() || '这道菜'}」会从你们家的菜谱里删掉，收藏与常用组合里的这道也会一起消失，删了不能恢复。`}
        confirmText="删除"
        tone="danger"
        pending={remove.isPending}
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(false)}
      />
    </>
  )
}
