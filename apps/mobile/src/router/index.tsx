import { Navigate, createBrowserRouter } from 'react-router-dom'
import TabLayout from '@/layouts/TabLayout'
import DiscoverPage from '@/pages/discover/DiscoverPage'
import FridgePage from '@/pages/fridge/FridgePage'
import KitchenPage from '@/pages/kitchen/KitchenPage'
import MinePage from '@/pages/mine/MinePage'
import OrderPage from '@/pages/order/OrderPage'

/**
 * 路由表：5 个 Tab 挂在同一个 TabLayout 下。
 * 二级页面（菜谱详情、点菜单详情等）在 M1/M3 追加到 /kitchen、/order 之下。
 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <TabLayout />,
    children: [
      { index: true, element: <Navigate to="/kitchen" replace /> },
      { path: 'kitchen', element: <KitchenPage /> },
      { path: 'order', element: <OrderPage /> },
      { path: 'discover', element: <DiscoverPage /> },
      { path: 'fridge', element: <FridgePage /> },
      { path: 'mine', element: <MinePage /> },
    ],
  },
  { path: '*', element: <Navigate to="/kitchen" replace /> },
])
