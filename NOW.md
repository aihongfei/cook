# NOW

> 接续任务先读本文件。状态实质变化时修订，不反复追加。

## 当前目标

完成 Phase 2（工程文档骨架 + 落盘调研/方案/功能清单），拿到用户对**完整功能清单**与**UI 方案**的确认后，进入第一个可独立验收的功能开发。

## 进展（本次完成）

- ✅ 读取并解析 `参考图片/` 全部 13 张截图，识别出两套产品形态：暖橙「家庭小厨房」（4 Tab）、清新绿「御膳私房菜」（5 Tab 与 4 Tab 变体）。
- ✅ Phase 0 立项调研：确认无可直接使用的成熟开源项目（详见 `docs/context/RESEARCH.md`）。
- ✅ Phase 1 需求对齐：产品定位、平台、后端、数据、执行方式已全部确认（详见 `DECISIONS.md` D-001~D-013）。
- ✅ Phase 2 建档：`AGENTS.md`、`PROJECT_INDEX.md`、`README.md`、`NOW.md`、`MAP.md`、`RUNBOOK.md`、`DECISIONS.md`、`RISKS.md`、`history/README.md`、`docs/context/{RESEARCH,PLAN,FEATURES}.md`。
- ✅ 需求追加：**必须注册登录**（D-008）；**AI 能力模块**（拍照识别冰箱食材入库、拍照识菜与营养分析），改造为**配置文件驱动 + pi-agent harness + 内置提示词**（D-009）。
- ✅ 平台收敛：**只做 Android**（D-002）；**不做小程序**（D-010）；**不用 uni-app**，坚持 React + Capacitor（D-013）；使用丰富的依赖与组件库（D-011）。
- ✅ 图片生成链路验证：`gpt-image-2` 可用（HTTP 200，约 20–60s/张，`b64_json`）。
- ✅ **UI 方向探索（两轮，均用 AI 出图）**：
  - 第一轮 6 版（杂志风 / 便签墙 / 极简时间轴 / 暗色夜厨 / 新中式）→ **用户否决**（"都不好看，不要极简的"），存于 `docs/ui-preview/directions/`。
  - 第二轮 6 版按**可爱 / 漂亮**重做（可爱治愈系 / 萌兔 IP / 玻璃拟态 / 手绘水粉 / 3D 软陶 / 马卡龙粉彩）→ **待用户选**，入口 `docs/ui-preview/directions2/index.html`。
  - 更早的照搬参考图 HTML 稿已**废弃**。
  - **用户选定 04 手绘水粉**，已交付实现稿并多轮微调：`docs/ui-preview/handpainted/index.html`（5 个 Tab + 与原图并排对照）。当前状态：① 品牌字用**透明底**笔绘 PNG 直接落在插画上（无遮挡层）；② 分类为 **5 个独立按钮**（笔绘图标图片 + 手写字体文字标签）；③ 全站文字改用**手写字体 ZCOOL KuaiLe（站酷快乐体，OFL-1.1 可商用，726KB woff2 单文件）**；④ 素材在 `handpainted/assets/`（主题插画 + 菜品图 + 横幅 + 分类图标 + 字体）。
- ✅ **开发环境已解决**：nvm-windows 实际装在 `%LOCALAPPDATA%\Author Software\nvm`，Node **v26.7.0** 可用（npm 11.19.0）。已创建 `C:\nvm4w\nodejs` 连接并修正 `NVM_HOME`；新开终端后 `node -v` 直接可用。
- ✅ **需求追加（2026-10-11 第三轮）**：用户要求加入 **3D 能力**（3D 冰箱预览、3D 菜品预览）→ 新增里程碑 **M17**（6 条，含 P0 的 2.5D 降级策略，见 `DECISIONS.md` D-015）；同时我方提交 **M18 候选方向 12 条**（烹饪模式、AI 对话式助手、买菜小票识别、适老化等）标记为**待用户取舍**（D-016）。清单合计更新为 **19 个里程碑 / 142 条**。
- 🔄 **M0 工程基建进行中**（2026-10-11）：
  - ✅ **F0-01 前端脚手架**：`apps/mobile`，Vite 8 + React 18.3.1 + TS 6 + Tailwind v4 + Sass。`npm run build` 通过（`dist`：CSS 17.19 kB / JS 274.83 kB，gzip 88.23 kB）。
  - ✅ **F0-02 路由 + 5 Tab**：react-router，`/kitchen` `/order` `/discover` `/fridge` `/mine` 五条路由**逐条实测通过**（标题与高亮均正确）。
  - ✅ **F0-03 设计 token + 字体**：Tailwind `@theme static` 输出全部 token（实测 `--color-cream=#fcf1da`、`--color-brand=#e07b39`、`--spacing-page=16px`）；手写字体 ZCOOL KuaiLe 生效（`document.fonts.check` 为 true）。
  - ✅ **F0-04 移动端适配**：`viewport-fit=cover` + `env(safe-area-inset-*)`。
  - ✅ **F0-06 图标与插画**：5 个 Tab 的 SVG 图标 + 草枝；笔绘素材（hero、3 张菜品、5 个分类方块、横幅、透明底品牌字、字体）已落库到 `apps/mobile/public/`。
  - ✅ **F0-09 / F0-10**：axios 客户端（token 注入 + 401 处理，`VITE_API_BASE_URL` 接线）；`.gitignore` 排除 `.env*` + `.env.example`。
  - ✅ **F0-12**：antd-mobile / Tailwind / Sass / zustand / TanStack Query / framer-motion / axios / ahooks / echarts / swiper / zod / dayjs 等已安装。
  - ✅ **已确认的手绘首页已落成代码**：厨房页拆成 HeroBanner / SearchBar / CategoryRow / TodayMeals / DishCard / SeasonalBanner 六个组件 + 页面级 `kitchen.scss`。
  - ✅ **F0-05 通用组件**：Page / SectionTitle / Chips / Pill / EmptyState + **BottomSheet（antd-mobile Popup）/ Toast·Dialog 封装 / Skeleton**；已在厨房页实际接入（"拍照识菜"打开抽屉、加菜出 Toast，实测 `hasPopup: true`）。antd-mobile Tabs 封装待补。
  - ✅ **F0-08 后端脚手架**：NestJS 12 + Prisma 6 + Swagger。`prisma migrate dev --name init` 已建库（`prisma/dev.db`）；`pnpm run build` 产出 `dist/main.js`；**接口实测** `GET http://127.0.0.1:3000/api/health` → `{"status":"ok","name":"yushan-api",...,"node":"v26.7.0"}`；文档 `/api/docs`。
  - 🔧 待办：前端目前仍是 **npm** 安装（后端已按用户要求改用 **pnpm**），需要统一到 pnpm（删 `node_modules`+`package-lock.json` 后 `pnpm install`）。
- ✅ **代码已上 GitHub（2026-10-11）**：私有仓库 `https://github.com/aihongfei/cook`，默认分支 `main`，首次提交 **126 文件 / 12507 行 / 56.6 MB**。API 核对：可见性 PRIVATE、远端 blob 数与本地一致、敏感文件自查无输出。`参考图片/`（第三方截图）按约定排除；署名 `aihf <82986195+aihongfei@users.noreply.github.com>`（noreply 邮箱，不暴露真实地址）。操作与自查命令见 `RUNBOOK.md` R-006。
- **验收证据**：dev server `http://127.0.0.1:5173`（当前仍在后台运行）；构建输出见上；五条路由的实测标题：家宴点菜单 / 发现 / 我的冰箱 / 我的。

## 阻塞 / 待用户确认

1. ✅ **开发环境已解决**：Node v26.7.0 + npm 11.19.0 可用（`RUNBOOK.md` R-000、`RISKS.md` R-08）。**新开终端**才会读到修正后的环境变量。
2. ⬜ **UI 稿待确认**：用户已选 04 手绘水粉，实现稿在 `docs/ui-preview/handpainted/index.html`。待用户确认后进入 M0。
3. ⬜ **完整功能清单待确认**：`docs/context/FEATURES.md` 共 **19 个里程碑 / 142 条**（含 M17 3D、M18 候选 12 条待取舍）。
4. ⬜ **AI 多模态 provider**：由用户通过配置文件自配（我方不锁定厂商）。
5. ✅ 已定：注册=账号+密码；harness=pi-agent；仅 Android；不做小程序；不用 uni-app。

## 下一步

1. M0 收口：前端统一到 pnpm；补 antd-mobile Tabs 封装；F0-11 的 CI 暂缓。
2. 进入 **M1 菜谱库**（P0）：菜谱数据模型 + 种子数据导入管线（HowToCook）+ 列表/筛选/搜索/详情。
3. 提醒：AI 多模态 provider 由用户通过配置文件自配（`DECISIONS.md` D-009）；3D 见 D-015；M18 候选方向待用户取舍（D-016）。

## 证据入口

- 调研：`docs/context/RESEARCH.md`
- 方案：`docs/context/PLAN.md`
- 功能清单：`docs/context/FEATURES.md`
- UI 设计稿：`docs/ui-preview/`（当前选定方向实现稿 `handpainted/index.html`；`directions2/index.html` 为第二轮六版对比，`directions/index.html` 为已被否决的第一轮）
- 代码仓库：`https://github.com/aihongfei/cook`（私有）
- 参考原图：`参考图片/`
