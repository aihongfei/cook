# 御膳 · 家庭小厨房

一个面向**家庭场景**的移动端应用：家人点菜、掌勺人回应，配合冰箱库存、备菜计划与菜谱库，解决"今天吃什么、家里有什么、还缺什么"。

## 它解决什么

- 家人想吃什么 → 点菜给掌勺人看（有状态流转，不是留言板）
- 掌勺人纠结做什么 → 按家庭口味/忌口过滤 + 随机配餐 + 常用组合
- 家里有什么 → 冰箱库存（含保质期、快过期提醒）
- 还缺什么 → 按最终菜单自动生成采购清单

## 文档入口

先读 [`PROJECT_INDEX.md`](PROJECT_INDEX.md) 找路由，再按需读取；开发规则见 [`AGENTS.md`](AGENTS.md)。

| 用途 | 文件 |
| --- | --- |
| 项目规则 / 读写纪律 | `AGENTS.md` |
| 任务路由 | `PROJECT_INDEX.md` |
| 立项调研结论 | `docs/context/RESEARCH.md` |
| 需求与开发方案 | `docs/context/PLAN.md` |
| 完整功能清单 | `docs/context/FEATURES.md` |
| 当前进展 | `NOW.md` |
| 决策 / 风险 | `DECISIONS.md` / `RISKS.md` |
| 环境与操作 | `MAP.md` / `RUNBOOK.md` |

## 状态

**M0 工程基建与 M1 菜谱库已交付并通过验收**（2026-10-11）：前端 `apps/mobile`（React 18 + Vite + Tailwind v4，pnpm）、后端 `services/api`（NestJS 12 + Prisma 6 + SQLite），菜谱库已内置 28 道真实菜谱（HowToCook，Unlicense）。当前进展见 [`NOW.md`](NOW.md)。

- 本地跑起来：前端 `pnpm --dir apps/mobile run dev`（http://127.0.0.1:5173），后端 `pnpm --dir services/api run start:prod`（http://127.0.0.1:3000/api，文档 `/api/docs`）。完整步骤见 [`RUNBOOK.md`](RUNBOOK.md)。
- 下一步：M2 注册登录与家庭；功能条目与优先级见 [`docs/context/FEATURES.md`](docs/context/FEATURES.md)。
- 平台：**仅 Android**（Capacitor 打包），iOS 与桌面端暂缓（`DECISIONS.md` D-002）。

