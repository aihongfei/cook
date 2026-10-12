import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { Toaster } from '@/components/ui/toast'
import { router } from '@/router'
import '@/styles/tailwind.css'
import '@/styles/index.scss'

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
