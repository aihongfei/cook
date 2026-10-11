import { useState } from 'react'
import BottomSheet from '@/components/ui/BottomSheet'
import Page from '@/components/ui/Page'
import SectionTitle from '@/components/ui/SectionTitle'
import { toastSuccess } from '@/components/ui/feedback'
import { recommendedDishes } from '@/data/demo'
import CategoryRow from './components/CategoryRow'
import DishCard from './components/DishCard'
import HeroBanner from './components/HeroBanner'
import SearchBar from './components/SearchBar'
import SeasonalBanner from './components/SeasonalBanner'
import TodayMeals from './components/TodayMeals'
import './kitchen.scss'

/** 厨房（首屏）：今日安排 + 分类 + 今日推荐 */
export default function KitchenPage() {
  const [category, setCategory] = useState<string>()
  const [photoSheet, setPhotoSheet] = useState(false)

  return (
    <Page>
      <HeroBanner />
      <SearchBar onFilterClick={() => setCategory(undefined)} />
      <CategoryRow activeId={category} onSelect={setCategory} />

      <div className="quick">
        <button type="button" className="quick__item quick__item--primary">
          🎲 今天吃什么
        </button>
        <button type="button" className="quick__item">
          👤 邀请家人一起
        </button>
        <button
          type="button"
          className="quick__item"
          onClick={() => setPhotoSheet(true)}
        >
          📷 拍照识菜
        </button>
      </div>

      <TodayMeals />

      <SectionTitle title="今日推荐" more="全部" />

      <div className="dish-row">
        {recommendedDishes.map((dish) => (
          <DishCard
            key={dish.id}
            dish={dish}
            onAdd={(name) => toastSuccess(`已把「${name}」加入今晚菜单`)}
          />
        ))}
      </div>

      <SeasonalBanner />

      <BottomSheet
        visible={photoSheet}
        title="拍照识菜"
        onClose={() => setPhotoSheet(false)}
      >
        <p>
          对着一盘菜拍一张，识别菜名、配料与营养（热量 / 蛋白 / 脂肪 / 碳水），必要时还可以直接生成一份菜谱草稿。
        </p>
        <p>
          这个能力排在 <b>M16（AI 能力）</b>，模型由你在设置里自行配置（见「我的 → AI 模型配置」）。
        </p>
      </BottomSheet>
    </Page>
  )
}
