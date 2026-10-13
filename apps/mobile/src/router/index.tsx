import { Navigate, createBrowserRouter } from 'react-router-dom'
import TabLayout from '@/layouts/TabLayout'
import ForgotPasswordPage from '@/pages/auth/ForgotPasswordPage'
import LoginPage from '@/pages/auth/LoginPage'
import RegisterPage from '@/pages/auth/RegisterPage'
import ResetPasswordPage from '@/pages/auth/ResetPasswordPage'
import CheckInPage from '@/pages/checkins/CheckInPage'
import CombosPage from '@/pages/combos/CombosPage'
import FamilyPage from '@/pages/family/FamilyPage'
import TastePage from '@/pages/taste/TastePage'
import DiscoverPage from '@/pages/discover/DiscoverPage'
import FridgePage from '@/pages/fridge/FridgePage'
import KitchenPage from '@/pages/kitchen/KitchenPage'
import MinePage from '@/pages/mine/MinePage'
import PrepPage from '@/pages/prep/PrepPage'
import ShoppingPage from '@/pages/shopping/ShoppingPage'
import FavoritesPage from '@/pages/recipes/favorites/FavoritesPage'
import MyRecipesPage from '@/pages/recipes/MyRecipesPage'
import RecipeFormPage from '@/pages/recipes/RecipeFormPage'
import RecipeListPage from '@/pages/recipes/RecipeListPage'
import RecipeDetailPage from '@/pages/recipes/RecipeDetailPage'
import OrderPage from '@/pages/order/OrderPage'
import HistoryPage from '@/pages/order/history/HistoryPage'
import RequireAuth from './RequireAuth'

/**
 * 路由表：5 个 Tab 挂在同一个 TabLayout 下，整体需要登录（RequireAuth，D-008）。
 * 菜谱列表与详情在同一外壳下，归属厨房入口。
 * 登录/注册/忘记密码/重设密码放在守卫之外 —— 否则会出现"要登录才能进登录页"的死循环
 * （重设密码是从邮件链接进来的，那时用户恰恰是登不上来的状态）。
 */
export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  { path: '/forgot', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  {
    path: '/',
    element: <RequireAuth><TabLayout /></RequireAuth>,
    children: [
      { index: true, element: <Navigate to="/kitchen" replace /> },
      { path: 'kitchen', element: <KitchenPage /> },
      { path: 'recipes', element: <RecipeListPage /> },
      /*
       * 静态路径写在 `:id` 之前：react-router v6 本来就按具体度匹配（`/recipes/mine`
       * 不会被 `:id` 抢走），但把它排在前面，读路由表的人不必先知道这条规则才敢确认。
       */
      { path: 'recipes/mine', element: <MyRecipesPage /> },
      { path: 'recipes/new', element: <RecipeFormPage /> },
      { path: 'recipes/:id', element: <RecipeDetailPage /> },
      { path: 'recipes/:id/edit', element: <RecipeFormPage /> },
      { path: 'favorites', element: <FavoritesPage /> },
      { path: 'order', element: <OrderPage /> },
      { path: 'order/history', element: <HistoryPage /> },
      { path: 'prep', element: <PrepPage /> },
      { path: 'shopping', element: <ShoppingPage /> },
      { path: 'combos', element: <CombosPage /> },
      { path: 'discover', element: <DiscoverPage /> },
      { path: 'fridge', element: <FridgePage /> },
      { path: 'mine', element: <MinePage /> },
      { path: 'checkins', element: <CheckInPage /> },
      { path: 'family', element: <FamilyPage /> },
      { path: 'taste', element: <TastePage /> },
    ],
  },
  { path: '*', element: <Navigate to="/kitchen" replace /> },
])
