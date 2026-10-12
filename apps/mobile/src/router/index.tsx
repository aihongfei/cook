import { Navigate, createBrowserRouter } from 'react-router-dom'
import TabLayout from '@/layouts/TabLayout'
import LoginPage from '@/pages/auth/LoginPage'
import RegisterPage from '@/pages/auth/RegisterPage'
import DiscoverPage from '@/pages/discover/DiscoverPage'
import FridgePage from '@/pages/fridge/FridgePage'
import KitchenPage from '@/pages/kitchen/KitchenPage'
import MinePage from '@/pages/mine/MinePage'
import RecipeListPage from '@/pages/recipes/RecipeListPage'
import RecipeDetailPage from '@/pages/recipes/RecipeDetailPage'
import OrderPage from '@/pages/order/OrderPage'
import RequireAuth from './RequireAuth'

/**
 * 路由表：5 个 Tab 挂在同一个 TabLayout 下，整体需要登录（RequireAuth，D-008）。
 * 菜谱列表与详情在同一外壳下，归属厨房入口。
 * 登录/注册放在守卫之外，否则会出现"要登录才能进登录页"的死循环。
 */
export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  {
    path: '/',
    element: <RequireAuth><TabLayout /></RequireAuth>,
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
