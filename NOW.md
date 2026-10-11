# NOW

> 接续任务先读本文件。状态实质变化时修订，不反复追加。

## 当前目标

**M0 工程基建与 M1 菜谱库均已交付并通过验收**。下一步进入 **M2 注册登录与家庭（P0）**：账号+密码注册登录、路由守卫、个人资料与接口鉴权，让应用具备强制登录入口后再接点菜主干。

## 已完成（长期有效的事实）

- ✅ **立项与建档**：`参考图片/` 13 张截图解析；Phase 0 调研（`docs/context/RESEARCH.md`）、Phase 1 需求对齐（`DECISIONS.md` D-001~D-013）、Phase 2 文档骨架全部完成。
- ✅ **关键决策**：必须注册登录（D-008）；AI 走配置驱动 + pi-agent + 内置提示词（D-009）；**只做 Android**（D-002、D-010）；不用 uni-app，React + Capacitor（D-013）；3D 用 react-three-fiber + 2.5D 降级（D-015）。
- ✅ **UI 方案**：两轮 AI 出图探索后用户选定 **04 手绘水粉**，实现稿 `docs/ui-preview/handpainted/index.html`（5 Tab、透明底品牌字、5 个分类按钮、手写字体 ZCOOL KuaiLe）。
- ✅ **开发环境**：Node v26.7.0（`RUNBOOK.md` R-000）；图片生成 `gpt-image-2` 实测可用。
- ✅ **代码已上 GitHub**：私有仓库 `https://github.com/aihongfei/cook`（默认分支 `main`）。操作与自查命令见 `RUNBOOK.md` R-006；后续提交沿用该仓库。

## M18 范围已定档（2026-10-11）

- ✅ 用户取舍：**保留 9 项**（烹饪模式、AI 对话助手、小票识别、口味画像、天气时令、营养周报、分享卡片、菜谱书页 OCR、家庭排行）；**排除**适老化大字模式、安卓桌面小组件、离线优先。
- ✅ 已落档：`DECISIONS.md` D-016 改写；`FEATURES.md` M18 转为正式条目 F18-01～F18-09，清单总量修订为 **19 个里程碑 / 139 条**；`PLAN.md` M18 行同步。

## M0 收口（已完成）

- ✅ **前端统一到 pnpm**：`pnpm import` 转换锁文件 + `pnpm install` 成功；原 npm 锁文件归档 `history/package-lock.mobile.pre-pnpm.json`（未删除）。
  - 踩坑：pnpm 12 的依赖构建许可改用 `pnpm-workspace.yaml` 的 **`allowBuilds` 映射**（旧 `onlyBuiltDependencies` / `ignoredBuiltDependencies` 在本机实测仍报 `ERR_PNPM_IGNORED_BUILDS`）；前端放行 `esbuild`、`@parcel/watcher`，拒绝 `@scarf/scarf`。
- ✅ **通用组件补 Tabs 封装**：`apps/mobile/src/components/ui/FilterTabs.tsx`（antd-mobile Tabs，合同 `items/activeKey/onChange`）。
- ✅ **客户端缓存（登录制口径）**：TanStack Query 请求缓存 + `apps/mobile/src/stores/recipe-filters.ts`（zustand persist）只持久化**品类/菜系筛选偏好**；搜索词与菜谱内容不落盘（不做离线菜谱库，符合 D-016 排除项）。
- ✅ **聚焦样式适配手绘风**（用户提出）：新增 token `--color-focus` / `--color-focus-line` / `--shadow-focus`；搜索胶囊聚焦时整体泛暖光、输入框不再画内部矩形。实测计算样式：输入框 `outline: none`，胶囊 `border rgb(232,177,131) + 0 0 0 4px rgb(224 123 57 / 13%)`。
- ⬜ F0-11 的 CI 仍暂缓（P1，未接）。

## M1 菜谱库（P0，已交付）

- ✅ **数据与接口（后端）**：Prisma `Recipe` 模型 + 迁移 `20261011151646_recipes`；HowToCook 种子 **28 道真实菜谱**（固定 commit `3dfa950f…`、Unlicense，来源/许可/版本随详情返回）；`RecipeProvider` 可插拔适配层 + 内置实现；接口 `GET /api/recipes`（分页/搜索/筛选）、`GET /api/recipes/filters`、`GET /api/recipes/:id`。
- ✅ **导入管线**：`pnpm run fetch:recipes`（抓取 + 解析）、`pnpm run seed:recipes`（幂等 upsert，不覆盖用户自建菜谱）。
- ✅ **解析器修正**：3 条菜谱的工具项（「直径 30cm 以上的盆」「砂锅（没有的话，用铁锅也行）」「小碗若干」）曾误判为配料，已修正并重新生成 `seeds/howtocook.json`，与测试恢复一致。
- ✅ **前端页面**：菜谱列表（双列卡片、品类×菜系筛选、350ms 防抖搜索、中文输入法组合保护、无限滚动 + 已显示/总量）、菜谱详情（配料用量、步骤含子步骤、备注、来源许可版本、无视频明示）；厨房页搜索/分类/全部/推荐接真实接口；缺图统一「菜谱图片待补」占位，热量缺失显示「热量暂无」（不造数）。
- ✅ **路由**：`/recipes`、`/recipes/:id` 挂在 TabLayout 下，厨房 Tab 高亮；详情返回保留列表条件。

## 验收证据（本次实测）

| 项目 | 命令 / 入口 | 结果 |
| --- | --- | --- |
| 前端构建（pnpm） | `pnpm --dir apps/mobile run build` | 通过：`dist` CSS 28.77 kB(gzip 6.96) / JS 436.91 kB(gzip 147.44) |
| 前端测试 | `pnpm --dir apps/mobile run test` | 2 文件 **11/11** 通过 |
| 后端构建 | `pnpm --dir services/api run build` | 通过（`dist/main.js`） |
| 后端单测 | `pnpm --dir services/api run test` | **8/8** 通过（解析、幂等导入、分页、参数校验） |
| 后端 HTTP 验收 | `pnpm --dir services/api run test:http` | **18/18** 通过（脚本 `services/api/scripts/verify-recipes-http.cjs`） |
| 服务地址 | `http://127.0.0.1:3000/api`（新构建，含菜谱接口）、`/api/docs` Swagger | `/api/recipes` 返回 `total=28` |
| 浏览器实测 | `http://127.0.0.1:5173` | 首页分类（主食/汤/素菜/荤菜）与推荐 6 道来自接口；点「素菜」→ 列表 7 道；搜索「鸡蛋」→ 1 道；详情含配料/步骤/来源；返回保留条件；**刷新后筛选保留**；清除后回到 28 道；滚动加载至 28 道 |

> 端口说明：3000 上原为迁移前旧构建进程，已停止并换成含菜谱接口的新构建；本机 CORS 仅放行 `http://127.0.0.1:5173`，用其它端口（如 5174）起前端会被浏览器拦截，需同步改 `services/api/.env` 的 `CORS_ORIGIN`。

## 阻塞 / 待确认

1. ⬜ **AI 多模态 provider**：由用户通过配置文件自配（D-009），M16 才能落地识图。
2. ⬜ **菜谱配图**：HowToCook 无成品图，当前统一占位；后续用 AI 生图补齐（D-005）。

## 下一步

1. **M2 注册登录与家庭（P0）**：账号 + 密码注册登录、路由守卫、个人资料、JWT 鉴权。
2. M1 余项按清单推进：F1-09 收藏（P1）、F1-10 加入菜单（依赖 M4 菜单）、F1-11～F1-13（P1/P2）。
3. M18 的 9 项按依赖顺序排期（多数依赖 M3/M6/M8/M9/M16）。

## 证据入口

- 调研：`docs/context/RESEARCH.md`
- 方案：`docs/context/PLAN.md`
- 功能清单：`docs/context/FEATURES.md`
- 接口验收脚本：`services/api/scripts/verify-recipes-http.cjs`
- UI 设计稿：`docs/ui-preview/`（选定方向实现稿 `handpainted/index.html`）
- 代码仓库：`https://github.com/aihongfei/cook`（私有）
- 参考原图：`参考图片/`
