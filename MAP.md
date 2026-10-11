# MAP

> 目录、端口、配置与部署位置的关系。映射变化时更新；**不虚构尚未创建的环境**。

## 目录结构（⬜ = 尚未创建）

```
cook/
├─ AGENTS.md / PROJECT_INDEX.md / README.md / NOW.md
├─ MAP.md / RUNBOOK.md / DECISIONS.md / RISKS.md / .gitignore
├─ 参考图片/                  # 13 张原始参考截图
├─ docs/
│  ├─ context/               # RESEARCH.md / PLAN.md / FEATURES.md
│  └─ ui-preview/            # UI 方向探索
│     ├─ directions/         # 第一轮 6 版（已否决）
│     ├─ directions2/        # 第二轮 6 版（用户选定 04 手绘水粉）
│     └─ handpainted/        # ✅ 已确认的设计稿（HTML + assets + README）
├─ apps/
│  └─ mobile/                # ✅ 前端（Vite + React 18 + TS + Tailwind v4 + Sass）
│     ├─ public/
│     │  ├─ fonts/           # 手写字体 ZCOOL KuaiLe（woff2）
│     │  └─ img/             # 笔绘素材：hero / 菜品 / cat-1..5 / banner / logo-t
│     ├─ src/
│     │  ├─ api/             # client.ts（axios 实例 + 拦截器）
│     │  ├─ components/      # icons/（SVG 图标）、ui/（Page/SectionTitle/Chips/Pill/EmptyState）
│     │  ├─ config/          # tabs.ts（底部 5 Tab 定义）
│     │  ├─ data/            # demo.ts（M0 占位数据）
│     │  ├─ layouts/         # TabLayout（外壳 + 底部导航）
│     │  ├─ pages/           # kitchen/ order/ discover/ fridge/ mine/ + shared.scss
│     │  ├─ router/          # index.tsx（路由表）
│     │  ├─ styles/          # tailwind.css（@theme static token）、index.scss（字体 + 基础）
│     │  └─ theme/           # tokens.ts（token 的 TS 视图）
│     └─ .env.example
├─ services/
│  └─ api/                   # ✅ 后端（NestJS 12 + Prisma 6）
│     ├─ prisma/             # schema.prisma + migrations/ + dev.db（不入库）
│     ├─ src/
│     │  ├─ main.ts          # 引导：/api 前缀、CORS、ValidationPipe、Swagger
│     │  ├─ app.module.ts    # 根模块
│     │  └─ modules/health/  # 健康检查（controller + service + module）
│     ├─ .npmrc              # pnpm 构建策略
│     ├─ pnpm-workspace.yaml # 依赖构建白/黑名单（pnpm v10+ 的配置位置）
│     ├─ nest-cli.json / tsconfig.json / .env.example
└─ packages/                 # ⬜ 共享包（暂未引入 workspace）
```

## 端口与运行位置（已实测）

| 对象 | 位置/端口 | 状态 |
| --- | --- | --- |
| 前端 dev server | `apps/mobile` · `http://127.0.0.1:5173` | ✅ 已验证（`npm run dev`，待切 pnpm） |
| 前端构建产物 | `apps/mobile/dist` | ✅ 已验证（`npm run build`） |
| 后端 API | `services/api` · `http://127.0.0.1:3000/api` | ✅ 已验证（`pnpm run start:prod`） |
| 后端接口文档 | `http://127.0.0.1:3000/api/docs` | ✅ Swagger |
| 数据库（开发） | SQLite · `services/api/prisma/dev.db` | ✅ 已建库并应用首个迁移 |

## 配置

- 前端环境变量前缀 `VITE_`；模板见 `apps/mobile/.env.example`。
- 后端环境变量见 `services/api/.env.example`（`DATABASE_URL` / `PORT` / `CORS_ORIGIN`）。
- **包管理器**：后端用 **pnpm**（前端待统一）。**密钥（第三方图片生成、数据库等）一律放 `.env`，不写入文档、不入库、不进对话记录。**

## 部署（尚未确定）

部署目标与方式未定；确定后在此登记实际地址与流程，不提前虚构。
