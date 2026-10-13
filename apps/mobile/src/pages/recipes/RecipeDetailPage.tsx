import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { caloriesLabel, fetchRecipe, recipeErrorMessage, useDeleteRecipe } from '@/api/recipes'
import ConfirmDialog from '@/components/ui/ConfirmDialog'
import Page from '@/components/ui/Page'
import { toast } from '@/components/ui/toast'
import OrderDishSheet from '@/pages/order/components/OrderDishSheet'
import { readBackLink } from '@/pages/back-link'
import { readPlanTarget } from '@/pages/order/plan-target'
import RecipeImage from './components/RecipeImage'
import RecipeOriginBadge from './components/RecipeOriginBadge'
import RecipeStatus from './components/RecipeStatus'
import './recipes.scss'

export default function RecipeDetailPage() {
  const { id = '' } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const [ordering, setOrdering] = useState(false)
  // 删除要走二次确认（不可逆），所以先记"弹窗开着没"再发请求
  const [deleting, setDeleting] = useState(false)
  // 每次点「想吃这道」都 +1，用来给抽屉换 key（见下方 OrderDishSheet）
  const [orderSheetSeq, setOrderSheetSeq] = useState(0)
  const openOrderSheet = () => {
    setOrderSheetSeq((value) => value + 1)
    setOrdering(true)
  }
  // 返回目标由共享的 back-link 判定（**别再自己列白名单**：发现页「摇一道」带过来的
  // '/discover' 就曾因为这里只认 /kitchen 与 /recipes 而被静默丢掉，返回按钮指向了菜谱小书）
  const back = readBackLink(location.state, '/recipes')
  // 本周菜单「去安排」带来的目标（F4-02）：只要经过菜谱小书，它就会跟着路由 state 一路到这里。
  // 路由 state 是不可信输入，用 readPlanTarget 读（见该文件）；读不出来就是普通的"想吃这道"。
  const planTarget = readPlanTarget(location.state)
  const query = useQuery({
    queryKey: ['recipes', 'detail', id],
    queryFn: ({ signal }) => fetchRecipe(id, signal),
    enabled: Boolean(id),
    staleTime: 60_000,
    retry: 1,
  })
  const recipe = query.data
  const remove = useDeleteRecipe()

  /*
   * 删完回「我的菜谱」而不是回上一页：那道菜已经不存在了，浏览器后退会撞上详情页的 404，
   * 而用户此刻多半正是从「我的菜谱」过来的。
   */
  const confirmDelete = () => {
    if (!recipe) return
    remove.mutate(recipe.id, {
      onSuccess: (result) => {
        setDeleting(false)
        toast.success(`已删掉「${result.name}」`)
        navigate('/recipes/mine')
      },
      onError: (error) => {
        setDeleting(false)
        toast.error(apiErrorMessage(error))
      },
    })
  }
  return (
    <Page>
      <div className="recipes-page recipe-detail">
        <Link className="page-back" to={back.to}>
          ← {back.label}
        </Link>
        {query.isPending && <RecipeStatus title="正在翻开这道菜谱…" loading />}
        {query.isError && !recipe && (
          <RecipeStatus
            title="这道菜谱暂时打不开"
            onRetry={() => {
              void query.refetch()
            }}
          >
            {recipeErrorMessage(query.error)}
          </RecipeStatus>
        )}
        {query.isRefetchError && recipe && (
          <RecipeStatus
            title="菜谱更新失败，暂时保留上次内容"
            onRetry={() => {
              void query.refetch()
            }}
          >
            {recipeErrorMessage(query.error)}
          </RecipeStatus>
        )}
        {recipe && (
          <>
            <div className="recipe-detail__image">
              <RecipeImage src={recipe.image} name={recipe.name} />
            </div>
            <header className="recipe-detail__heading">
              <h1>{recipe.name}</h1>
              {/*
               * 来源（F1-12）：自建的标出来，"谁传的"跟在后面——一道家传菜署上名字才完整。
               * `mine === false` 的菜没有编辑/删除按钮，这里把原因说出来：不解释的话，
               * 用户只会觉得"为什么这道能改、那道不能"（后端拒绝时的原话也是这个意思）。
               */}
              <p className="recipe-detail__origin">
                <RecipeOriginBadge origin={recipe.origin} sourceLabel={recipe.sourceLabel} />
                {recipe.createdBy && <span>{recipe.createdBy} 上传</span>}
                {recipe.mine === false && <span>公共菜谱不能改，想调整就自己新建一道</span>}
              </p>
              {recipe.aliases.length > 0 && <p>也叫：{recipe.aliases.join('、')}</p>}
              <div className="recipe-detail__tags">
                {/* 源站标签里常带着品类词（如"汤""包子"），与前面的品类/菜系重复，展示时去重 */}
                {[recipe.category, recipe.cuisine, ...recipe.tags]
                  .filter((tag, index, all) => Boolean(tag) && all.indexOf(tag) === index)
                  .map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
              </div>
              <p>
                {caloriesLabel(recipe)} · 辣度 {recipe.spiciness}
              </p>
              {/* 点菜入口（F3-01）：看完就知道怎么做的菜，最想做的事是"让家里做给我吃" */}
              <div className="recipe-detail__actions">
                <button
                  type="button"
                  className="recipe-button recipe-detail__order"
                  onClick={openOrderSheet}
                >
                  想吃这道
                </button>
                {/* 编辑/删除只在**能改**的时候画（mine 由后端算好）：公共菜谱是只读的，
                    给个按钮再拿 403 拒绝，比不给按钮更糟 */}
                {recipe.mine && (
                  <>
                    <Link
                      className="recipe-button recipe-detail__edit"
                      to={`/recipes/${encodeURIComponent(recipe.id)}/edit`}
                    >
                      编辑
                    </Link>
                    <button
                      type="button"
                      className="recipe-button recipe-detail__delete"
                      onClick={() => setDeleting(true)}
                    >
                      删除
                    </button>
                  </>
                )}
              </div>
            </header>
            <section className="recipe-paper" aria-labelledby="ingredients-heading">
              <h2 id="ingredients-heading">准备这些食材</h2>
              {recipe.ingredients.length > 0 ? (
                <ul className="recipe-ingredients">
                  {recipe.ingredients.map((ingredient, index) => (
                    <li key={`${ingredient.name}-${index}`}>
                      <span>{ingredient.name}</span>
                      <span>{ingredient.amount || '用量暂无'}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>食材信息暂无</p>
              )}
            </section>
            <section className="recipe-paper" aria-labelledby="steps-heading">
              <h2 id="steps-heading">跟着步骤慢慢做</h2>
              {recipe.steps.length > 0 ? (
                <ol className="recipe-steps">
                  {recipe.steps.map((step, index) => (
                    <li key={index}>
                      <span className="recipe-steps__number" aria-hidden="true">
                        {index + 1}
                      </span>
                      <p>{step}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>做法步骤暂无</p>
              )}
            </section>
            <section className="recipe-paper" aria-labelledby="notes-heading">
              <h2 id="notes-heading">掌勺小贴士</h2>
              {recipe.notes.length > 0 ? (
                <ul className="recipe-notes">
                  {recipe.notes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              ) : (
                <p>这道菜还没有额外备注</p>
              )}
            </section>
            <section className="recipe-paper" aria-labelledby="video-heading">
              <h2 id="video-heading">视频参考</h2>
              {/^https?:\/\//i.test(recipe.videoUrl || '') ? (
                <a
                  className="recipe-source-link"
                  href={recipe.videoUrl!}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  打开原视频 ↗
                </a>
              ) : (
                <p>暂无视频，先跟着文字步骤做吧</p>
              )}
            </section>
            <section className="recipe-paper recipe-source" aria-labelledby="source-heading">
              <h2 id="source-heading">这份菜谱从哪里来</h2>
              <dl>
                <div>
                  <dt>来源</dt>
                  <dd>{recipe.source.name || '暂无'}</dd>
                </div>
                <div>
                  <dt>许可</dt>
                  <dd>{recipe.source.license || '暂无'}</dd>
                </div>
                <div>
                  <dt>版本</dt>
                  <dd>{recipe.source.commit || '暂无'}</dd>
                </div>
              </dl>
              {/^https?:\/\//i.test(recipe.source.url) && (
                <a
                  className="recipe-source-link"
                  href={recipe.source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  查看原始菜谱 ↗
                </a>
              )}
            </section>
          </>
        )}
        {/* key 每次打开都变（不用卸载组件，保留抽屉的下滑动画）：上次选的餐次与备注不会带过来 */}
        {recipe && (
          <OrderDishSheet
            key={`order-${orderSheetSeq}`}
            visible={ordering}
            recipeId={recipe.id}
            recipeName={recipe.name}
            preset={planTarget}
            onClose={() => setOrdering(false)}
          />
        )}
        {recipe && (
          <ConfirmDialog
            open={deleting}
            title="删掉这道菜谱"
            // 说清后果：删掉之后收藏与组合里的引用也跟着没了，别只问一句"确定吗"
            message={`「${recipe.name}」会从你们家的菜谱里删掉，收藏与常用组合里的这道也会一起消失，删了不能恢复。`}
            confirmText="删除"
            tone="danger"
            pending={remove.isPending}
            onConfirm={confirmDelete}
            onCancel={() => setDeleting(false)}
          />
        )}
      </div>
    </Page>
  )
}
