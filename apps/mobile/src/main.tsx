import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router-dom'
import { Toaster } from '@/components/ui/toast'
import { installAndroidBack } from '@/lib/android-back'
import { router } from '@/router'
import '@/styles/tailwind.css'
import '@/styles/index.scss'

/*
 * 安卓系统返回键（F14-01 / R-13 ①）：WebView 不接管的话，返回键在二级页上毫无反应
 * （模拟器实测：在 /taste 按返回，页面纹丝不动）。装一次、全局生效——
 * 弹层优先关、再回退、到根才退出 App。浏览器里这个函数直接返回空卸载器，没有副作用。
 */
installAndroidBack()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      {/* 全局提示层：放在 Router 外面，换页时不会被卸载 */}
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
)
