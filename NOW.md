# NOW

> 接续任务先读本文件。状态实质变化时修订，不反复追加。

## 当前目标

**M0 工程基建、M1 菜谱库、M2（注册登录 + 家庭与成员，F2-01~F2-07/09）均已交付并验证**。M2 只剩 F2-08（多家庭切换，P2）未做。下一步进入 **M3 点菜与点单流转**（F3-01~F3-09）——注意 M3 的权限点已在家庭模块里定义好（`order.create` / `menu.manage` / `menu.confirm`），直接复用。

## 已完成（长期有效的事实）

- ✅ **立项与建档**：`参考图片/` 13 张截图解析；Phase 0 调研（`docs/context/RESEARCH.md`）、Phase 1 需求对齐（`DECISIONS.md` D-001~D-013）、Phase 2 文档骨架全部完成。
- ✅ **关键决策**：必须注册登录（D-008）；AI 走配置驱动 + pi-agent + 内置提示词（D-009）；**只做 Android**（D-002、D-010）；不用 uni-app，React + Capacitor（D-013）；**渲染层维持 WebView、不采用 React Native（D-017，2026-10-12 用户确认）**；3D 用 react-three-fiber + 2.5D 降级（D-015）。
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

- ✅ **数据与接口（后端）**：Prisma `Recipe` 模型 + 迁移 `20261012021730_init`（MySQL）；`RecipeProvider` 可插拔适配层 + 内置实现；接口 `GET /api/recipes`（分页/搜索/筛选）、`GET /api/recipes/filters`、`GET /api/recipes/:id`。**菜谱数据已不是 HowToCook 种子**——该种子按用户 2026-10-12 指示弃用，改由第三方 API 聚合接入（见下节「菜谱数据源接入」），库内现有 **600 道**。
- ✅ **导入管线**：`pnpm run import:recipes`（多源：按关键词或按分类批量建库，幂等 upsert，不覆盖用户自建/他源记录）；`pnpm run normalize:names`（把菜名清理规则补用到历史行）。
- ✅ **解析器修正**：3 条菜谱的工具项（「直径 30cm 以上的盆」「砂锅（没有的话，用铁锅也行）」「小碗若干」）曾误判为配料，已修正并重新生成 `seeds/howtocook.json`，与测试恢复一致。
- ✅ **前端页面**：菜谱列表（双列卡片、品类×菜系筛选、350ms 防抖搜索、中文输入法组合保护、无限滚动 + 已显示/总量）、菜谱详情（配料用量、步骤含子步骤、备注、来源许可版本、无视频明示）；厨房页搜索/分类/全部/推荐接真实接口；缺图统一「菜谱图片待补」占位，热量缺失显示「热量暂无」（不造数）。
- ✅ **路由**：`/recipes`、`/recipes/:id` 挂在 TabLayout 下，厨房 Tab 高亮；详情返回保留列表条件。

## 本机环境恢复（2026-10-12，macOS）

> 本节是在当前 macOS 工作站上把项目跑起来的实测结果；下面「验收证据」表来自 2026-10-11 的另一台 Windows 机器，两者不要混用。

- ✅ **工具链对齐**：本机 nvm 下装好 **pnpm 12.11.2**（与 `apps/mobile/package.json` 的 `packageManager` 固定值一致；此前本机只有 11.22.0）；Node **v26.7.0**（nvm 默认别名）。注意：非登录 shell 里 node/pnpm 不在 PATH，且 Node 26 已不随包分发 `corepack`。
- ✅ **依赖安装**：前端、后端均安装成功。后端首次安装被 `ERR_PNPM_IGNORED_BUILDS` 中断——`services/api/pnpm-workspace.yaml` 还在用 pnpm 12 已不读取的旧键，已改成与前端同款 **`allowBuilds`** 映射（Prisma 三件套放行、`@scarf/scarf` 拒绝），随后 Prisma Client 生成成功。
- ✅ **本地配置**：由 `.env.example` 生成 `apps/mobile/.env` 与 `services/api/.env`（两者都被 `.gitignore` 覆盖，未入库）。
- ✅ **数据库**：`services/api/prisma/dev.db` 已建，迁移 `20261011145533_init`、`20261011151646_recipes` 均已应用。
- ✅ **菜谱库已填充**：HowToCook 种子弃用后改走第三方 API 聚合导入，库内现有 **600 道**（`jisu=589`、`uapis=9`、`jumdata=2`），598 道带成品图；页面不再显示空态。详见「菜谱数据源接入」节。
- ✅ **服务在跑**：后端 `http://127.0.0.1:3000/api`（文档 `/api/docs`）、前端 `http://127.0.0.1:5173`。

| 项目 | 命令 / 入口 | 结果 |
| --- | --- | --- |
| 前端构建 | `pnpm --dir apps/mobile run build` | 通过：CSS 28.80 kB(gzip 6.97) / JS 436.91 kB(gzip 147.44)，与 10-11 记录基本一致 |
| 后端构建 | `pnpm --dir services/api run build` | 通过 |
| 建库 | `pnpm --dir services/api exec prisma migrate deploy` | 两个迁移全部应用成功 |
| 健康检查 | `GET /api/health` | 200：`{"status":"ok","name":"yushan-api","node":"v26.7.0"}` |
| 菜谱列表 | `GET /api/recipes?page=1&pageSize=12` | 200（当时为空库；现为 600 道，见下节） |
| 筛选选项 | `GET /api/recipes/filters` | 200（当时为空库；现返回 4 品类 + 10 个菜系） |
| 接口文档 | `GET /api/docs` | 200（Swagger） |
| 前端页面 | `http://127.0.0.1:5173/`、`/recipes` | 均 200；浏览器实测截图：厨房页与菜谱页渲染正常，「今日安排」示例数据在、菜谱推荐与列表显示空态文案、底部 5 Tab 与手绘水粉风样式正常 |

## 数据库换 MySQL + 后端容器化（2026-10-12 完成）

- ✅ **决策已落档**：`DECISIONS.md` **D-018**（MySQL 8 + 后端与数据库容器化；**前端不进 Docker**，发布走 Capacitor 打 APK）、**D-019**（菜谱数据源走 API 聚合，**不自建爬虫**——实测见 `docs/context/RESEARCH.md` 第三节）。
- ✅ **数据库**：Prisma provider `sqlite` → `mysql`；SQLite 期迁移归档到 `history/prisma-sqlite-archive/`（未删除），重建单一初始迁移 `20261012021730_init`。原库两表均为 0 行，**零数据损失**。
- ✅ **修掉一处会在导入数据时爆的隐患**：MySQL 下 Prisma 默认把 String 映射为 `VARCHAR(191)`，而 `searchText`（名称/别名/配料/标签拼接）与 `rawMarkdown` 必然超长 → 已改 `@db.Text`，URL 类字段放宽到 `@db.VarChar(512)`。
- ✅ **容器化落地**：`services/api/Dockerfile`（多阶段）、`services/api/docker-entrypoint.sh`（启动时自动 `prisma migrate deploy`）、根 `docker-compose.yml`（mysql:8.4 + api，healthcheck + 命名卷 `cook_mysql-data`）、根 `.env.example`。
- ✅ **后端代码改动**：`main.ts` 的监听地址改为 `HOST` 可配（默认 `127.0.0.1`，容器内由 compose 覆盖为 `0.0.0.0`）——原先硬编码回环地址会导致容器内服务彼此不可达。
- ❌ **前端不进 Docker**（按用户 2026-10-12 指示）：前端 Dockerfile / nginx 配置已删除，恢复本机 Vite 开发形态。

| 项目 | 命令 / 入口 | 结果 |
| --- | --- | --- |
| 起全栈 | `docker compose up -d --build` | ✅ `cook-mysql-1` healthy（3306）+ `cook-api-1`（3000） |
| 建表 | api 容器 entrypoint 自动 `prisma migrate deploy` | ✅ `AppMeta` / `Recipe` / `_prisma_migrations` 已建；重启显示 "No pending migrations to apply" |
| 健康检查 | `GET http://127.0.0.1:3000/api/health` | ✅ 200（容器内 node v24.21.0） |
| 菜谱接口 | `GET /api/recipes?page=1&pageSize=5` | ✅ 200（当时为空库；现为 600 道，见下节） |
| 跨域联调 | `OPTIONS /api/recipes`，Origin `http://127.0.0.1:5173` | ✅ 204 + `Access-Control-Allow-Origin: http://127.0.0.1:5173` |
| 前端本地 | `http://127.0.0.1:5173/recipes` | ✅ 浏览器实测：页面正常渲染（当时显示空态；现已显示真实菜谱，数据链路 前端 → api → 容器内 MySQL） |
| 启动日志 | `docker compose logs api` | ✅ 无 pnpm 告警（entrypoint 改用 `./node_modules/.bin/prisma`，避开 pnpm 的运行时依赖校验） |

## 菜谱数据源接入（2026-10-12 完成，主力源 = 极速数据 jisuapi，库内 600 道）

- ✅ **决策更新**（`DECISIONS.md` D-019 补充）：**HowToCook 弃用**（用户："HowToCook 不需要了"）；**聚合数据因价格搁置**（用户："有点贵"）；**主力源 = 极速数据 jisuapi**（用户已注册并开通「菜谱」接口，实测跑通）；**uapis.cn 保留作免密钥兜底源**。
- ✅ **适配层**：`services/api/src/modules/recipes/sources/` —— `recipe-source.ts`（源适配接口 + 品类/菜系映射 + 配料/步骤解析 + 统一入库行）、`jisu.source.ts`、`uapis.source.ts`、`jumdata.source.ts`。新增源只需实现 `search()`；支持分类枚举的源再实现 `listCategories()` + `enumerate()`。
- ✅ **导入命令**：按关键词 `--keywords=…`；按分类批量建库 `--source=jisu --categories=307,305,351 --limit=40`（`--categories=all` 为全部叶子分类）。见 `RUNBOOK.md` R-008。
- ✅ **导入器重构**：所有源共用 `upsertAll()`，冲突保护（不覆盖用户自建/他源记录）与幂等口径一致；幂等比对用 `canonicalJson()`——**MySQL 的 JSON 列不保留对象键顺序**，直接 `JSON.stringify` 比会误判成"有变化"。
- ✅ **品类映射改为「源站分类优先」**：源站分类名命中映射表就直接采用（源站事实），未命中才退回菜名关键词规则（汤→主食→素菜→荤菜）。此前只靠菜名猜，把源站「素菜」类下的"姜汁腐竹拌芹菜"判成了荤菜。
- ✅ **菜系来自源站真实数据**：从源站分类名与标签里提取川菜/粤菜/湘菜等（`deriveCuisine()`），不再一律写"家常"——筛选器因此有了真实菜系可选。
- ✅ **菜名清理**：`cleanDishName()` 剥掉 `[原创首发]`、`【儿童美食】` 这类编辑/人群前缀；**不无条件剥括号**（源站有「【红烧排骨】万用的炒糖上色法」「【桂圆银耳羹】」这种菜名本身在括号里的写法）。历史行用 `pnpm run normalize:names` 补用规则。
- ✅ **占位值不再当内容**：源站用「无」占位时不再渲染出"准备 无"；已回填修正 38 行历史数据。
- ✅ **前端配套修正**：详情页标签去重（源站标签常带"汤""包子"这类品类词，与前面的品类/菜系标签重复）。
- ⚠️ **聚美智数已实测**：接口可用、入库 2 条（`origin=jumdata`），但**抽到的菜谱均无图片**，不满足"图片必须要有"的硬指标 → **不作主源**；其步骤详细、有小贴士、原料部分带用量，**可作补充源**（多源按 `origin` 隔离、互不覆盖）。这 2 条无图记录**尚未清理**，待用户决定。
- ❌ **已排除**：聚合数据 id 733（无图片字段）；showapi（用户确认无图）。
- ⚠️ **图片转存仍是必须项，未开工**：极速数据同样是**第三方域名直链**，其文档写明"图片链接会过期，请尽快保存图片"；uapis 的 9 条是 http 外链（APK 内可能被混合内容策略拦）。→ **MinIO 需尽快加进 compose**。（好消息：极速数据的图 **https 可访问**，本适配器已统一把 http 升到 https，见下表实测。）

**极速数据接口实测结论（2026-10-12，用用户真实 key 调通）**：

- `GET /recipe/class`：`result` 是数组，**14 个顶级分类、子类合计 900+**（菜品 88 个、菜系 106 个…）；分类里混着"功效/人群/疾病"这类筛选型节点，**大部分不是菜品分类**，建库要挑着用。
- `GET /recipe/byclass`：`result` 是**对象** `{ total, num, list }`（不是数组）；**`num` 硬上限 20**（传 50、100 都只回 20 条），翻页只能靠 `start`；**只认叶子分类**（传顶级 id 返回 `205 没有信息`）。一次即返回含 `material`/`process` 的完整菜谱，**不需要逐条再调详情**（这点比 uapis 省调用）。
- `material[].type` 是**数字**：1 主料、0 辅料（主料排在数组末尾），按字符串比会全部判成辅料。
- 图片实测 **230×230 px / 16KB JPEG**，`http://api.jisuapi.com/...`，**该域名 https 同样返回 200**，可规避混合内容。
- 数据量（`total`）：家常菜 **12710**、热菜 2681、川菜 456。**但按 20 条/页翻页，拉满家常菜需 ~636 次调用**——扩充规模要按调用次数配额分批跑。

| 项目 | 命令 / 入口 | 结果 |
| --- | --- | --- |
| 权限校验 | `GET /recipe/class?appkey=…` | ✅ `status=0 msg=ok`（此前为 `103 APPKEY无请求此数据权限`，用户开通接口后解除） |
| 批量建库 | `pnpm --dir services/api run import:recipes -- --source=jisu --categories=307,314,306,312,305,351,352,320,326,324,335,336,302,304,310,224 --limit=40` | ✅ 16 个分类、**32 次调用 / 52 秒** → 入库 640 条（去重后库内 **600 道**） |
| 库内构成 | `SELECT origin, COUNT(*) FROM Recipe GROUP BY origin` | ✅ `jisu=589`、`uapis=9`、`jumdata=2`；**598/600 带图**，无图的就是 jumdata 那 2 条 |
| 品类分布 | `SELECT category, COUNT(*) FROM Recipe GROUP BY category` | ✅ 主食 235 / 素菜 156 / 荤菜 123 / 汤 86 |
| 菜系分布 | `SELECT cuisine, COUNT(*) FROM Recipe GROUP BY cuisine` | ✅ 10 种：家常 541、川菜 40、苏菜 5、粤菜 4、韩国料理 4… |
| 数据完整性 | 校验每行的 `ingredients` / `steps` 非空 | ✅ 600/600 都有食材与步骤（极速数据最少 2 项食材、3 步） |
| 列表接口 | `GET /api/recipes?pageSize=3` | ✅ 返回真实菜名 + `https://` 成品图 + 品类/菜系 |
| 筛选器 | `GET /api/recipes/filters` | ✅ 4 品类 + 10 个菜系（全部由数据推导，非硬编码） |
| 后端测试 | `pnpm --dir services/api run test` | ✅ **16/16** 通过（含源站分类映射、菜系派生、菜名清理的新用例） |
| 前端测试 | `pnpm --dir apps/mobile run test` | ✅ **11/11** 通过 |
| 前端页面 | `http://127.0.0.1:5173/kitchen`、`/recipes`、`/recipes/jis-921962f7135f17d6590d` | ✅ 浏览器实测截图：推荐位与列表双列卡片均显示真实成品图；详情页食材（含用量、主料在前）、5 步做法、来源许可与原始链接齐全；标签去重生效；备注不再出现"准备 无" |

## 验收证据（2026-10-11，原 Windows 机）

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

## 菜谱图片自托管（MinIO）（2026-10-12 完成，598/600 已备份）

> 目标：图片不再依赖第三方图床（对方文档写明链接会过期），**备份进自己的对象存储，前端只读自己的图**；第三方接口此后只在"首次导入"时用到。

- ✅ **数据模型**：`Recipe` 新增 `imageKey`（自托管对象 key）/ `imageHash`（内容 sha256）/ `imageStoredAt`；迁移 `20261012032044_recipe_image_mirror`。原 `image` 字段**保留为源站原始地址**（溯源与重下用，也避免重新导入时把镜像地址误判成"内容变了"而覆盖）。
- ✅ **存储实现**：`src/modules/media/media.storage.ts` —— 标准 S3 协议（`@aws-sdk/client-s3`）+ `src/scripts/mirror-images.ts`。**换阿里云 OSS / 腾讯云 COS / AWS S3 只改 `MEDIA_S3_*` 环境变量**，不动业务代码与数据。
- ✅ **接口行为**：`publicImageUrl()` —— 有自托管副本就用副本，没有才回退源站直链（没配 `MEDIA_BASE_URL` 的环境也不会无图）。前端无需改动。
- ✅ **备份脚本**（`pnpm run mirror:images`）：**只下载图片文件、不调用数据源业务接口 → 不消耗第三方调用次数**；文件名 = 内容 sha256（同图多菜只存一份、重复执行不重传）；响应非图片类型（如限流返回的 HTML）或体积异常一律拒收；串行 120ms 节流。
- ✅ **跳过条件以「对象是否真在桶里」为准**（HeadObject 探测），而不是"DB 里有 imageKey"。**这一条是踩坑换来的**：一次被中断的运行给 327 行写了 `imageKey` 但对象没上传，只看 DB 就会让这 327 道菜的图在页面 404；脚本现在会自愈补传。
- ✅ **容器化**：`docker-compose.yml` 增加 `minio` 服务（命名卷 `minio-data`）+ api 的 `depends_on: service_healthy`；桶不存在时脚本自动创建并设为**公开只读**（菜谱图是公开内容；私有内容应另建私有桶）。
- ✅ **MinIO 用自建镜像（用户指示"自己部署 minio"）**：`services/minio/Dockerfile` —— 从**官方中国镜像站 `dl.minio.org.cn`** 取 MinIO 官方发布二进制，装进 alpine。**版本固定 + 双架构 sha256 校验**（上游换文件即构建失败，不会静默换版本）；`minio --version` 实测 `RELEASE.2025-04-22T22-12-26Z / GNU AGPLv3 / MinIO, Inc.`，确认是官方产物。镜像 167 MB，运行时不含 curl/wget。背景（官方 Docker 镜像下架、`dl.min.io` 对二进制返回 410）见 `RISKS.md` R-14。

| 项目 | 命令 / 入口 | 结果 |
| --- | --- | --- |
| MinIO 服务 | `docker compose up -d minio` | ✅ `cook-minio-1` healthy；`GET /minio/health/live` → 200 |
| 备份图片 | `pnpm --dir services/api run mirror:images` | ✅ 两次运行合计 **598 张全部成功、失败 0**（第一次 271 张，第二次补传 327 张） |
| 自建 MinIO 切换 | `docker compose build minio && docker compose up -d minio` | ✅ 镜像构建通过（sha256 校验生效）；换镜像后**数据卷里的 598 个对象原样可用**，再跑备份脚本逐个探测 → `待处理 0 个` |
| 桶内容 | `mc ls --recursive local/cook-media \| wc -l` | ✅ **598 个对象 / 8.9 MiB** |
| 图片直连 | `GET http://127.0.0.1:9000/cook-media/recipes/<hash>.jpg` | ✅ HTTP 200、`image/jpeg`、16534 字节（公开只读生效） |
| 接口返回 | `GET /api/recipes?pageSize=3` | ✅ 图片地址已变为 `http://127.0.0.1:9000/cook-media/recipes/…` |
| 浏览器实测 | `/recipes` 列表 12 张卡片图 | ✅ **12/12 全部来自 `127.0.0.1:9000`**，`complete && naturalWidth>0` 全为真；厨房页推荐位同样来自 MinIO |
| 后端测试 | `pnpm --dir services/api run test` | ✅ **20/20** 通过（新增图片类型白名单、命名、地址回退、S3 配置覆盖用例） |

## M2 注册登录与家庭（P0 已交付：F2-01/02/03）（2026-10-12）

> 范围：账号 + 密码注册登录、登录态与路由守卫、用户资料绑定。**家庭成员/家庭创建属 P1（F2-04~F2-09），尚未开工**。

- ✅ **数据模型**：`User`（`account` 唯一、`nickname`、`avatar`、`passwordHash`）+ `RefreshToken`（`tokenHash` 唯一、`expiresAt`、`revokedAt`）；迁移 `auth_users`。
- ✅ **密码存储**：**scrypt**（Node 内置）——选它是因为 alpine 镜像里装 bcrypt/argon2 要编译原生模块，scrypt 零依赖即得强哈希。存储格式自描述 `scrypt$N$r$p$<salt>$<hash>`，将来升参后**老哈希仍能校验通过**（不让所有人被迫改密码）。参数 N=32768 / r=8 / p=1（单次约 32MB 内存）。
- ✅ **令牌策略**：access token 用 JWT（2 小时，无状态）；刷新令牌**入库并轮换**（30 天，只存 sha256 摘要，每次刷新吊销旧的）——旧令牌被重放一律 401。选轮换而非长有效期 JWT，是为了让「退出登录」和「令牌泄露」都能真正生效（无状态 JWT 单靠自己做不到吊销）。
- ✅ **防爆破**：`@nestjs/throttler` 全局 60 次/分 + **登录接口单独 8 次/分**；连续错密码实测触发 429。
- ✅ **接口**：`POST /api/auth/register|login|refresh|logout`、`GET/PATCH /api/auth/me`、`GET /api/auth/options`（注册口径：账号长度、密码规则、头像白名单——**规则只在后端定义一份**，前端不硬编码，改规则不用发版）。
- ✅ **前端**：`stores/auth.ts`（zustand persist，只存 token/refreshToken/user，**不存密码**）；`api/client.ts` 自动带 token、**401 单飞自动续期并重放一次**（并发请求只刷新一次）、错误文案统一走 `apiErrorMessage`；登录页 / 注册页（手绘风，注册即选头像）；`RequireAuth` 路由守卫；我的页接真实账号 + 资料编辑 + 退出登录。

| 项目 | 命令 / 入口 | 结果 |
| --- | --- | --- |
| 后端单测 | `pnpm --dir services/api run test` | ✅ **27/27** 通过（新增密码哈希与校验、账号/密码规则、头像白名单、刷新令牌轮换用例） |
| 后端 HTTP 验收 | `pnpm --dir services/api run test:http:auth` | ✅ **20/20** 通过（`services/api/scripts/verify-auth-http.cjs`，真实请求不 mock） |
| 限流窗口自愈 | 上述脚本连续跑两次 | ✅ 两次均 **20/20**（第二次先等限流窗口过期再跑，不把存量限流误判成功能失败） |
| 菜谱接口回归 | `pnpm --dir services/api run test:http` | ✅ **18/18** 通过（见下方「验收脚本订正」） |
| 前端测试 | `pnpm --dir apps/mobile exec vitest run` | ✅ **19/19** 通过（含 401 自动续期、守卫跳转、注册带头像、错误文案映射） |
| 未登录访问 | 浏览器打开 `/kitchen` | ✅ 跳转 `/login`，登录后回到拦截前的 `/kitchen` |
| 注册 | 注册页提交（头像选 🍳） | ✅ 库内 `mama_20261012 / 妈妈 / 🍳`；重复注册 409、弱密码 409、中文账号 409 |
| 登录 | 先错误密码、后正确密码 | ✅ 错误显示「账号或密码不对」（与"账号不存在"同一句话，不泄漏账号是否存在）；成功后落 `/kitchen` |
| 资料编辑 | 我的页改头像 → 保存 | ✅ 页面与库内一致（`avatar=🍳`、`updatedAt` 已更新） |
| 退出登录 | 我的页「退出登录」 | ✅ 本地会话清空（`yushan-auth` 归零）并跳 `/login`；刷新令牌吊销由 HTTP 验收覆盖 |

- ⚠️ **踩坑：改了后端代码必须重建容器再验收**。`avatar`（注册时选头像）是构建容器**之后**才加的代码，运行中的容器仍是旧版、静默忽略该字段，导致注册时选了 🍳 却存成默认 🐰。前端页面无报错、看着像"没生效"，实际是验证的是旧代码。→ **`docker compose up -d --build api` 之后再跑验收**；容器跑的是构建产物，不是挂载的源码。
- ⚠️ **踩坑：限流会误伤验收脚本自己**。登录限流按 IP 计数、存在服务内存里，连着跑两遍 `test:http:auth`，第二遍会被第一遍的窗口拦成 429，把功能用例整片判成失败（实测 10/20）。脚本现在**先探测一次**，若已限流就等窗口过期再跑并打印等待提示；限流用例还要求「429 之前确实出现过 401」，避免拿存量限流当结论。
- ⚠️ **订正：429 文案曾经不可达**。`apiErrorMessage` 原来先透传后端 message、后判 429，而后端**总会**带 message（真机抓到 `ThrottlerException: Too Many Requests`），友好文案永远走不到，用户直接看到异常类名。已改为**限流与断网优先判**，并把形如 `XxxException:` 的类名过滤掉（5xx 给「厨房服务开小差了」）。用例原来用 `data: {}` 才让这个 bug 溜过去，现已换成后端真实回包。

**验收脚本订正（2026-10-12）**：`verify-recipes-http.cjs` 里 4 条断言是 HowToCook 种子时期的固定数字（总数 28、别名"番茄炒鸡"、素菜/家常 = 7、许可 Unlicense + 40 位 commit），换数据源后**实际已长期失败（14/18）**，而文档里仍写着 18/18。现改为行为断言（随 pageSize 返回 / 关键词能在配料命中 / 交叉筛选结果同时满足两条件 / 来源四要素齐全）→ **18/18**，且今后换数据源不会再误报。

## M2 家庭与成员（P1 已交付：F2-04/05/06/07/09）（2026-10-12）

> 口径由用户 2026-10-12 拍板：**一人建家庭、其他人凭六位邀请码加入**；**权限＝纯角色制**（掌勺人/帮厨/吃货）；**找回密码走邮箱**且发信可插拔。详见 `DECISIONS.md` D-021。

- ✅ **数据模型**：`Family`（名称、六位邀请码、共享开关）+ `FamilyMember`（角色三档；`userId` 唯一 = 一个账号同时只在一个家）+ `PasswordReset`（一次性令牌）+ `User.email`；迁移 `20261012044218_family_and_password_reset`。
- ✅ **权限表只定义一份**（`family.roles.ts`）：6 个能力点（`order.create` / `menu.manage` / `menu.confirm` / `member.manage` / `invite.reset` / `family.edit`）× 3 角色，**随接口下发 `myCapabilities`**，前端不硬编码——与 D-020 的注册口径同一思路。M3/M4 的菜单权限直接复用这批 key。
- ✅ **后端强制校验**：管理类操作都过 `requireCapability`，不是"前端藏按钮"。验收里专门断言了吃货改家庭名/重置邀请码/给自己升权**全部 403**。
- ✅ **家庭成员上限 10 人**、邀请码长期有效（仅掌勺人可重置，重置即旧码失效）、加入接口限流 10 次/分防猜码。
- ✅ **唯一掌勺人**：把成员设为掌勺人＝**转让**（原掌勺人自动降帮厨，事务内完成）；掌勺人家里还有人时**不能退出**（要先转让），只剩自己时退出＝**解散家庭**。
- ✅ **找回密码（F2-04）**：绑定邮箱 → 一次性令牌（1 小时、只存 sha256）→ 邮件链接重设；**改密后吊销全部旧会话**。"邮箱没绑过"也返回同样的 200，不泄漏账号是否存在。
- ✅ **发信可插拔**：`console`（默认，邮件进日志，接口回 `devResetUrl` 便于本机联调）→ 配好 `MAIL_SMTP_*` 即真发信，业务代码不改。**上线前必须切 smtp**（`RISKS.md` **R-16**）。
- ✅ **前端**：家庭页（创建/加入/成员列表/角色调整/移出/邀请码复制与重置/共享开关/退出与解散）；忘记密码与重设密码页；我的页新增**家庭入口**（显示「家庭名 · N 位成员」）与**邮箱字段**；注册页可选填邮箱；厨房「邀请家人一起」与登录页「忘了密码」接上真实入口。
- ✅ **一个账号同时只在一个家庭**（DB 唯一约束）。F2-08「多家庭/多人切换」维持 P2 未做，放开时的改法已记入 `RISKS.md` **R-17**。

| 项目 | 命令 / 入口 | 结果 |
| --- | --- | --- |
| 后端单测 | `pnpm --dir services/api run test` | ✅ **35/35** 通过（新增角色-能力矩阵、邀请码字符集与随机性、邮箱校验用例） |
| 家庭接口验收 | `pnpm --dir services/api run test:http:family` | ✅ **47/47** 通过（真实请求，脚本 `verify-family-http.cjs`） |
| 连跑两次 | 同上连续执行 | ✅ 两次均 **47/47**（第二遍先等限流窗口，加入家庭是 10 次/分） |
| 前端测试 | `pnpm --dir apps/mobile exec vitest run` | ✅ **32/32** 通过（新增家庭页 8 项、找回密码 5 项） |
| 权限回归 | `pnpm --dir services/api run test:http:auth` / `test:http` | ✅ 20/20、18/18 未受影响 |
| 浏览器实测 | `http://127.0.0.1:5173/family` | ✅ 未加入时给"建家/加入"两个入口 → 建家后显示邀请码 `JZL3JJ`、掌勺人、成员列表 → 关共享开关生效 |
| 邀请码加入 | 浏览器注册第二个账号（林阿姨，带邮箱）→ 输 `" jzl3jj "`（小写带空格） | ✅ **加入成功**，成为吃货；**管理控件全部不显示**、共享开关禁用并提示"只有掌勺人能改" |
| 库内核对 | `SELECT f.name,u.nickname,m.role FROM Family f JOIN FamilyMember m …` | ✅ 小艾=OWNER、林阿姨=EATER，同属「小艾的家」，`shared=0` |
| 找回密码全流程 | `/forgot` → 开发链接 → `/reset-password?token=…` | ✅ 两次输入不一致被本地拦下；改密成功后**旧密码 401、新密码 200**；库里 5 个令牌 `usedAt` 全部已标记（一次性生效） |
| 我的页 | `/mine` | ✅ 显示「小艾的家 · 2 位成员」与已绑邮箱 |

- ⚠️ **踩坑：限流会误伤验收脚本自己**（家庭版）。加入家庭 10 次/分的窗口在一轮脚本里就用掉大半，**连着跑第二遍必然 429**。脚本改成遇到 429 就等窗口并打印原因，重试一次——不是把限流关掉，而是让脚本可重复运行。
- ⚠️ **`GET /family/options` 一开始挂在鉴权守卫下**（控制器级 `@UseGuards`），验收打出 401 才发现：角色/能力口径是**静态元数据**，必须像 `/auth/options` 一样免登录（前端在"还没加入家庭"时就要用它渲染角色标签）。已改为逐方法挂守卫。
- ⚠️ **前端测试里改 `localStorage` 不生效**：zustand 的 persist 只在**模块加载时**读一次 localStorage，在 `beforeEach` 里写已经晚了，store 仍是 null（页面直接跳登录页）。测试改为直接 `useAuth.getState().setSession(...)`。
- 🔧 **UI 修正（用户指出，2026-10-12）**：① `/mine` 的「编辑资料」被长邮箱挤成两行 → 按钮统一 `white-space: nowrap`、文本容器 `min-width: 0`、账号邮箱改单行省略号（规范记入 `docs/ui-preview/README.md`「排版规范」）；② **家庭页没有返回入口** → 新增返回链接，按来源显示「返回我的 / 返回厨房」，来源不在白名单或直接输地址时一律回「我的」。菜谱列表/详情原有的返回入口改用同一个 `.page-back` 样式（去掉重复定义）。
- 🔧 **UI 调整（继续，用户提出）**：① 家庭页两条说明的上下间隙统一为 **10px**（原为 12/30 与 0/35，根因是外边距合并随邻居变化）；② 新增**共用手绘风 toast**（`components/ui/toast.tsx` + `<Toaster />` 挂根部），把「邀请码已复制 / 已退出家庭 / 资料已更新 / 邮箱格式不对」这类一句话结果从页内提示段落改成悬浮提示——段落会把下方内容顶下去；同时删掉 `feedback.ts` 里重复且样式不搭的 antd-mobile Toast 包装。前端测试 41/41。
- 🔧 **危险操作补二次确认（用户提出，2026-10-12）**：新增共用**确认弹窗** `components/ui/ConfirmDialog.tsx`（居中模态框 + 遮罩 + Esc/点遮罩=取消 + 焦点默认在"取消" + 锁背景滚动 + 危险键砖红）。用于**退出/解散家庭、移出成员、转让掌勺人**三处——其中「移出成员」与「转让掌勺人」原来**没有**任何确认（点一下就生效，转让还会当场把自己的掌勺人身份交出去）。普通角色调整（帮厨/吃货）保持直接生效，不打扰用户。同时删掉没人引用的 `components/ui/feedback.ts`（antd Dialog 包装，与新弹窗重复）。前端测试 52/52；浏览器实测三个弹窗均居中、取消不留副作用、背景滚动恢复。
- 🔧 **「共享设置」上的白圈（用户截图指出，2026-10-12）**：`.family-switch` 的类名写成了 `` `family-switch${shared ? 'is-on' : ''}` `` → 漏空格拼成 `family-switchis-on`，**基础类样式整块失效**（含 `position: relative`），里面绝对定位的圆点失去定位父级、飘到视口左上角 (3px,3px)，看上去就是「返回我的」上方一个莫名的白圈；同时"开启"的橙色轨道也从未生效过（一直是灰底）。改用数组拼接，并补了两条类名断言（已验证"把 bug 放回去会失败"）；浏览器复核白圈消失、开关为 48×28、`is-on` 时轨道是品牌色。与上一条「砖红确认键失效」是同一个坑，已写进 `docs/ui-preview/README.md` 的排版规范。
- 📌 **测试断言别写死会变的数字**：这轮的家庭用例只断言"能力集合与角色一致""邀请码是六位且不含易混字符"这类不变式，不写死具体邀请码或成员数——上一轮菜谱脚本就是因为写死种子期的数字才长期红着没人发现。

**遗留（本轮明确未做）**：F2-08 多家庭切换（P2）；家庭消息提醒（M10）；共享开关目前只是个可开关的状态，**还没有任何功能去读它**（M3 点菜与 M4 菜单落地时才会真正生效——现在关掉它不会隐藏任何东西）。

## 阻塞 / 待确认

1. 🚧 **极速数据审核未通过、暂不能购买调用次数（用户 2026-10-12 明确告知）**：现在只有注册赠送的 **100 次免费额度**，已用约 **36 次**（3 次权限探测 + 1 次连通性验证 + 32 次建库），**剩约 64 次**。→ **在审核通过前不要再跑批量导入**。库内现有的 600 道足够开发期使用；扩充等额度到位后再做（详见下方"下一步"第 2 条）。
2. ⬜ **jumdata 那 2 条无图记录怎么处理**（`懒人版快手菜——盐水排骨…`、`红烧肉（电饭锅）`）：它们不满足"图片必须要有"，但删数据需用户授权。可选：删掉这 2 条 / 保留但后续用 AI 生图（D-005）补齐 / 整源下线。
3. ⬜ **AI 多模态 provider**：由用户通过配置文件自配（D-009），M16 才能落地识图。
4. ✅ **菜谱配图缺口已由数据源解决**：极速数据的菜自带成品图（230×230），不再是 HowToCook 时代的"统一占位"。

## 下一步

1. **M3 点菜与点单流转（P0）**：点单状态机（待确认→已安排→准备中→已做好）、状态筛选与计数、点单卡（谁点的/几人吃）、备注传递。**权限点已在 M2 定义好，直接复用**（点菜 `order.create` 人人可用，掌勺人/帮厨额外能改菜单与确认）。
2. **M2 遗留**：F2-08 多家庭切换（P2）；共享开关目前无人读取，M3/M4 落地时才真正生效。
2. **菜谱数据源剩余项**：① ✅ **图片已转存到自有 MinIO**（见上节「菜谱图片自托管」）；② 按用户给定的规模分批扩充菜谱库（**需等极速数据审核通过 + 购买额度**）；③ `steps` 扩展为带图结构（源站每步都有配图 `process[].pic`，适配器已取到 `stepImages`，但数据模型暂未落库；现在也可以顺便把步骤图一起备份进 MinIO）；④ jumdata 那 2 条无图记录的去留；⑤ 少量菜名仍带源站营销后缀（如 `三色春笋丁#多效护理一招制胜#`），可扩展 `cleanDishName` 清理。
3. **后端基建评估结论**（用户 2026-10-12 提问"还需不需要 redis、消息推送、minio、AI harness"）：见下方「建议」——**AI harness 必须放后端**（密钥不能进 APK）；**MinIO 已落地**（见上节）；Redis 建议纳入；推送不自建。
4. M1 余项按清单推进：F1-09 收藏（P1）、F1-10 加入菜单（依赖 M4 菜单）、F1-11～F1-13（P1/P2）。
5. M18 的 9 项按依赖顺序排期（多数依赖 M3/M6/M8/M9/M16）。

**建议（尚未确认，供用户取舍）**：

- **AI harness 放后端（强烈建议，实质是硬约束）**：pi-agent 是 Node 库（D-009 已定），且**模型密钥绝不能打进 APK** —— 否则任何拿到安装包的人都能提取 key 刷你的额度。因此 AI 调用必须在 `services/api` 里，前端只调我们自己的 `/api/ai/*`；顺带解决限流、审计与"用户自配 provider"（配置留在服务端）。**不需要额外基建**，就是后端一个新模块。
- **Redis（建议纳入，M2 时加）**：`RISKS.md` R-07 要求登录限流与防爆破，`RISKS.md` R-11 的推送去重、M16 的 AI 调用限流与缓存、通知防重发都需要它。一个容器、无状态，成本极低。**暂不引入**消息队列（家庭应用没有高吞吐场景，多一层只会增加运维负担）。
- **MinIO / 对象存储（✅ 已落地，2026-10-12）**：598/598 张菜谱图已备份进自建 MinIO，接口改为优先返回自托管地址（见上节「菜谱图片自托管」）。代码走标准 S3 协议，将来换成阿里云 OSS/S3 只改 `MEDIA_S3_*` 环境变量。**镜像为自建**（官方二进制 + sha256 校验，见 `services/minio/Dockerfile` 与 `RISKS.md` R-14）。同一套存储也能承接口味档案头像、分享卡片等后续图片需求——但**私有内容应另建私有桶**，别混进公开只读的 `cook-media`。
- **消息推送（不自建）**：推送没有"自己写一个"的选项——安卓要么走厂商通道/聚合推送服务，要么退化为应用内轮询。建议首版只做**本机可判定**的场景（计时结束、快过期）用本地通知，远端提醒按 `RISKS.md` R-11 在 M10 开工前再定通道。后端只需一个通知表 + 定时任务，**不需要新增基建**。
- **M17 3D 验证前置**：用户已明确"3D 要做，还要做好"，建议在 M2 之后、M3–M9 大量铺开之前先做一次真机基线 + 资产管线验证（Draco/KTX2、烘焙贴图、首屏不加载），同时补齐 `RISKS.md` R-09 欠的实测。
- **WebView 交互一致性清单**（对应 `RISKS.md` R-13）：返回键/手势、启动白屏、键盘遮挡、滚动与长按行为，建议作为 M14 打包前的验收条目逐条真机实测。
- **素材体积优化**（与选型无关）：`apps/mobile/public/img/` 单张手绘 PNG 达 2.4–3.4 MB、字体 726 KB，建议转 WebP/AVIF + 按显示尺寸出图 + 懒加载。

## 证据入口

- 调研：`docs/context/RESEARCH.md`
- 方案：`docs/context/PLAN.md`
- 功能清单：`docs/context/FEATURES.md`
- 接口验收脚本：`services/api/scripts/verify-recipes-http.cjs`（菜谱）、`services/api/scripts/verify-auth-http.cjs`（注册登录）
- UI 设计稿：`docs/ui-preview/`（选定方向实现稿 `handpainted/index.html`）
- 代码仓库：`https://github.com/aihongfei/cook`（私有）
- 参考原图：`参考图片/`
