import { Navigate, createBrowserRouter } from 'react-router-dom'
import TabLayout from '@/layouts/TabLayout'
import DiscoverPage from '@/pages/discover/DiscoverPage'
import FridgePage from '@/pages/fridge/FridgePage'
import KitchenPage from '@/pages/kitchen/KitchenPage'
import MinePage from '@/pages/mine/MinePage'
import RecipeListPage from '@/pages/recipes/RecipeListPage'
import RecipeDetailPage from '@/pages/recipes/RecipeDetailPage'
import OrderPage from '@/pages/order/OrderPage'

/**
 * 路由表：5 个 Tab 挂在同一个 TabLayout 下。
 * 菜谱列表与详情在同一外壳下，归属厨房入口。
 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <TabLayout />,
    children: [
      { index: true, element: <Navigate to="/kitchen" replace /> },
      { path: 'kitchen', element: <KitchenPage /> },
      { path: 'recipes', element: <RecipeListPage /> },
      { path: 'recipes/:id', element: <RecipeDetailPage /> },
      { path: 'order', element: <OrderPage /> },
      { path: 'discover', element: <DiscoverPage /> },
      { path: 'fridge', element: <FridgePage /> },
      { path: 'mine', element: <MinePage /> },
    ],
  },
  { path: '*', element: <Navigate to="/kitchen" replace /> },
])
