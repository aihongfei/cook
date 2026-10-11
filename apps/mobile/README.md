# 御膳 · 家庭小厨房 —— 前端（`apps/mobile`）

React 18 + TypeScript + Vite + Tailwind v4 + Sass 的移动端应用（仅 Android，后续用 Capacitor 打包）。

## 常用命令

```bat
pnpm install            :: 依赖（本项目统一用 pnpm，禁止 npm install）
pnpm run dev            :: 开发服务器 http://127.0.0.1:5173
pnpm run build          :: tsc -b && vite build
pnpm run test           :: vitest run
pnpm run typecheck      :: tsc -b
pnpm run lint           :: oxlint
pnpm run format         :: prettier
```

- 后端接口地址由 `VITE_API_BASE_URL` 决定，默认 `http://127.0.0.1:3000/api`（见 `.env.example`）。
- **换端口起前端会被浏览器拦**：后端 CORS 只放行 `services/api/.env` 的 `CORS_ORIGIN`（默认 `http://127.0.0.1:5173`）。

## 目录要点

- `src/pages/`：`kitchen`（首页）、`recipes`（菜谱列表 + 详情）、`order` / `discover` / `fridge` / `mine`。
- `src/api/`：`client.ts`（axios 实例 + token/401 处理）、`recipes.ts`（菜谱接口与查询 hooks）。
- `src/components/ui/`：Page / SectionTitle / Chips / Pill / EmptyState / FilterTabs / BottomSheet / Toast / Skeleton。
- `src/stores/`：zustand，仅持久化品类/菜系筛选偏好（不缓存菜谱内容）。
- `src/styles/`：`tailwind.css`（`@theme static` 设计 token，唯一来源）、`index.scss`（字体、基础、聚焦态）。

## 约定

- 样式分工：Tailwind 负责布局/间距/排版，页面级 SCSS 负责手绘视觉细节（组件不各自引样式）。
- 设计 token 只在 `src/styles/tailwind.css` 定义；用 `@theme static`（Tailwind v4 默认只输出被引用的 token，SCSS 里 `var(--color-*)` 会取不到值）。
- 视觉规范与探索过程见 `../../docs/ui-preview/README.md`；开发步骤与环境排查见 `../../RUNBOOK.md`。
