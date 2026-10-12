import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useFavoriteStatus, useToggleFavorite } from '@/api/favorites'
import { fetchRecipes, recipeErrorMessage, recipeListUrl, useRecipeFilters } from '@/api/recipes'
import BottomSheet from '@/components/ui/BottomSheet'
import Page from '@/components/ui/Page'
import SectionTitle from '@/components/ui/SectionTitle'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import CategoryRow from './components/CategoryRow'
import DishCard from './components/DishCard'
import HeroBanner from './components/HeroBanner'
import SearchBar from './components/SearchBar'
import SeasonalBanner from './components/SeasonalBanner'
import TodayMeals from './components/TodayMeals'
import './kitchen.scss'
import '../recipes/recipes.scss'

/** 厨房：真实菜谱入口与浏览推荐；菜单安排仍待后续里程碑接入。 */
export default function KitchenPage() {
  const navigate = useNavigate()
  const [photoSheet, setPhotoSheet] = useState(false)
  const [familySheet, setFamilySheet] = useState(false)
  const filters = useRecipeFilters()
  const recommendations = useQuery({
    queryKey: ['recipes', 'recommendations'],
    queryFn: ({ signal }) => fetchRecipes({}, 1, signal),
    staleTime: 60_000,
    retry: 1,
  })

  // 收藏（F1-09）：与菜谱小书同一套——**一屏一次问清**（这里只有 6 张，但口径一致，
  // 免得以后推荐位变多时又要回来改）。没登录时 hook 不发请求、卡片不画心。
  const favoriteStatus = useFavoriteStatus((recommendations.data?.items ?? []).slice(0, 6).map((dish) => dish.id))
  const toggleFavorite = useToggleFavorite()

  return (
    <Page>
      <HeroBanner />
      <SearchBar onSearch={(q) => navigate(recipeListUrl({ q }))} onFilterClick={() => navigate('/recipes')} />
      {filters.data && <CategoryRow categories={filters.data.categories} onSelect={(category) => navigate(recipeListUrl({ category }))} />}
      {filters.isPending && <div className="kitchen-api-status"><RecipeStatus title="分类加载中…" loading /></div>}
      {filters.isError && <div className="kitchen-api-status"><RecipeStatus title="分类暂时加载失败" onRetry={() => { void filters.refetch() }}>{recipeErrorMessage(filters.error)}</RecipeStatus></div>}

      <div className="quick">
        <button type="button" className="quick__item quick__item--primary" onClick={() => navigate('/recipes')}>翻翻菜谱</button>
        <button type="button" className="quick__item" onClick={() => setFamilySheet(true)}>邀请家人一起</button>
        <button type="button" className="quick__item" onClick={() => setPhotoSheet(true)}>拍照识菜</button>
      </div>

      <TodayMeals />
      <SectionTitle title="菜谱推荐" more="全部" onMoreClick={() => navigate('/recipes')} />
      {recommendations.isPending && <div className="kitchen-api-status"><RecipeStatus title="菜谱推荐加载中…" loading /></div>}
      {recommendations.isError && <div className="kitchen-api-status"><RecipeStatus title="推荐加载失败" onRetry={() => { void recommendations.refetch() }}>{recipeErrorMessage(recommendations.error)}</RecipeStatus></div>}
      {recommendations.data && recommendations.data.items.length === 0 && <div className="kitchen-api-status"><RecipeStatus title="菜谱库里还没有菜谱">有菜谱后，会在这里和你见面。</RecipeStatus></div>}
      <div className="dish-row">
        {recommendations.data?.items.slice(0, 6).map((dish) => (
          <DishCard
            key={dish.id}
            dish={dish}
            favorited={Boolean(favoriteStatus.data?.[dish.id])}
            onToggleFavorite={favoriteStatus.signedIn ? () => toggleFavorite.mutate(dish.id) : undefined}
          />
        ))}
      </div>
      <SeasonalBanner />

      <BottomSheet visible={photoSheet} title="拍照识菜" onClose={() => setPhotoSheet(false)}>
        <p>拍照识菜正在筹备。现在可以搜索菜名、食材或口味，看看菜谱里的做法。</p>
        <button className="recipe-button" type="button" onClick={() => navigate('/recipes')}>去看菜谱</button>
      </BottomSheet>
      <BottomSheet visible={familySheet} title="一家人的厨房" onClose={() => setFamilySheet(false)}>
        <p>家里人用同一个家庭才看得到彼此的菜单与点单。建个家，把邀请码发给他们就行。</p>
        <button className="recipe-button" type="button" onClick={() => navigate('/family', { state: { from: '/kitchen' } })}>去建家 / 加入家庭</button>
      </BottomSheet>
    </Page>
  )
}
