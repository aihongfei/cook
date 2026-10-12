import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useLocation, useParams } from 'react-router-dom'
import { caloriesLabel, fetchRecipe, recipeErrorMessage } from '@/api/recipes'
import Page from '@/components/ui/Page'
import OrderDishSheet from '@/pages/order/components/OrderDishSheet'
import RecipeImage from './components/RecipeImage'
import RecipeStatus from './components/RecipeStatus'
import './recipes.scss'

export default function RecipeDetailPage() {
  const { id = '' } = useParams()
  const location = useLocation()
  const [ordering, setOrdering] = useState(false)
  // 每次点「想吃这道」都 +1，用来给抽屉换 key（见下方 OrderDishSheet）
  const [orderSheetSeq, setOrderSheetSeq] = useState(0)
  const openOrderSheet = () => {
    setOrderSheetSeq((value) => value + 1)
    setOrdering(true)
  }
  const requestedFrom = location.state?.from
  const from =
    typeof requestedFrom === 'string' &&
    (requestedFrom === '/kitchen' ||
      requestedFrom === '/recipes' ||
      requestedFrom.startsWith('/recipes?'))
      ? requestedFrom
      : '/recipes'
  const query = useQuery({
    queryKey: ['recipes', 'detail', id],
    queryFn: ({ signal }) => fetchRecipe(id, signal),
    enabled: Boolean(id),
    staleTime: 60_000,
    retry: 1,
  })
  const recipe = query.data
  return (
    <Page>
      <div className="recipes-page recipe-detail">
        <Link className="page-back" to={from}>
          ← {from === '/kitchen' ? '返回厨房' : '返回菜谱小书'}
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
              <button
                type="button"
                className="recipe-button recipe-detail__order"
                onClick={openOrderSheet}
              >
                想吃这道
              </button>
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
            onClose={() => setOrdering(false)}
          />
        )}
      </div>
    </Page>
  )
}
