# MAP

> 目录、端口、配置与部署位置的关系。映射变化时更新；**不虚构尚未创建的环境**。

## 目录结构（⬜ = 尚未创建）

```
cook/
├─ AGENTS.md / PROJECT_INDEX.md / README.md / NOW.md
├─ MAP.md / RUNBOOK.md / DECISIONS.md / RISKS.md / .gitignore
├─ docker-compose.yml         # ✅ MySQL + MinIO + 后端 API 编排（前端不进 Docker）
├─ .env.example               # ✅ compose 用：库与对象存储密码、端口、镜像源（.env 不入库）
├─ 参考图片/                  # 13 张原始参考截图（被 .gitignore 排除，仅存于原开发机）
├─ docs/
│  ├─ context/               # RESEARCH.md / PLAN.md / FEATURES.md
│  └─ ui-preview/            # UI 方向探索
│     ├─ directions/         # 第一轮 6 版（已否决）
│     ├─ directions2/        # 第二轮 6 版（用户选定 04 手绘水粉）
│     └─ handpainted/        # ✅ 已确认的设计稿（HTML + assets + README）
├─ history/                  # 归档：pnpm 迁移前的 npm 锁文件、SQLite 期迁移
├─ services/minio/            # ✅ 自建 MinIO 镜像（Dockerfile：官方二进制 + sha256 校验）
├─ apps/
│  └─ mobile/                # ✅ 前端（Vite + React 18 + TS + Tailwind v4 + Sass）；本机跑，不进 Docker
│     ├─ public/
│     │  ├─ fonts/           # 手写字体 ZCOOL KuaiLe（woff2）
│     │  └─ img/             # 笔绘素材：hero / 菜品 / cat-1..5 / banner / logo-t
│     ├─ src/
│     │  ├─ api/             # client.ts（axios 实例 + token 注入 + 401 单飞续期 + 统一错误文案）、
│     │  │                   # recipes.ts（菜谱接口与查询 hooks）、auth.ts（注册登录/找回密码）、
│     │  │                   # family.ts（家庭接口与能力判定 can()）、orders.ts（点单接口与卡片合并）、
│     │  │                   # checkins.ts（打卡接口 + 上传前缩图 + 带令牌取图）
│     │  ├─ components/      # icons/（SVG 图标）、ui/（Page/SectionTitle/Chips/Pill/EmptyState/FilterTabs/BottomSheet/
│     │  │                   # toast.tsx 轻提示 + Toaster、ConfirmDialog.tsx 二次确认模态框、Skeleton、
│     │  │                   # Heatmap.tsx 打卡热力图、CheckInPhoto.tsx 带令牌取回并显示打卡照片）
│     │  ├─ config/          # tabs.ts（底部 5 Tab 定义）
│     │  ├─ data/            # demo.ts（M0 占位数据；订单示例已删除——点菜单在 M3 改用真实接口）
│     │  ├─ layouts/         # TabLayout（外壳 + 底部导航）
│     │  ├─ pages/           # kitchen/ recipes/（列表 + 详情）/ auth/（登录、注册、忘记密码、重设密码、auth.scss）
│     │  │                   # / shopping/（采购清单页，M7 F7-01；入口在「冰箱」Tab 首屏，D-040）/ fridge/（冰箱页：采购一行入口 + 库存骨架）/ recipes/favorites/（我收藏的菜，M1 F1-09）/ family/（家庭与成员 + family.scss）/ order/（点菜单 + OrderDishSheet
│     │  │                   # 点菜抽屉 + order.scss）/ checkins/（家庭打卡墙 + components/CheckInUploadSheet
│     │  │                   # 打卡上传抽屉 + checkins.scss）/ discover/ fridge/ mine/ + shared.scss
│     │  │                   # kitchen/components/：HeroBanner / CategoryRow（配 category-icons.ts 的品类→素材查表）/
│     │  │                   # TodayMeals（今日安排，M4 起接真实点单）
│     │  ├─ router/          # index.tsx（路由表）、RequireAuth.tsx（未登录跳 /login 并记住来源页）
│     │  ├─ stores/          # recipe-filters.ts（仅品类/菜系偏好）、auth.ts（token/refreshToken/user，persist）
│     │  ├─ styles/          # tailwind.css（@theme static token）、index.scss（字体 + 基础 + 聚焦态）
│     │  └─ theme/           # tokens.ts（token 的 TS 视图）
│     └─ .env.example
├─ services/
│  └─ api/                   # ✅ 后端（NestJS 12 + Prisma 6 + MySQL 8），容器化
│     ├─ Dockerfile          # 多阶段构建（node:24-alpine）
│     ├─ docker-entrypoint.sh# 启动时 prisma migrate deploy → node dist/main
│     ├─ prisma/             # schema.prisma（Recipe / User / RefreshToken / Family / FamilyMember / PasswordReset
│     │                      # / MealOrder / OrderItem / CheckIn / Favorite）
│     │                      # + migrations/（init、recipe_image_mirror、auth_users、family_and_password_reset、
│     │                      # meal_orders、check_ins、meal_diner_count、favorites）
│     ├─ seeds/              # howtocook.json（28 道种子）——已弃用为数据来源，保留为历史实现
│     ├─ scripts/            # verify-recipes-http.cjs、verify-auth-http.cjs、verify-family-http.cjs、
│     │                      # verify-orders-http.cjs、verify-checkins-http.cjs、verify-favorites-http.cjs、
│     │                      # verify-discover-http.cjs、verify-shopping-http.cjs（HTTP 验收脚本）
│     ├─ tests/              # node:test：解析器 / 导入幂等 / 查询与校验 / 密码哈希与账号规则 / 点单规则
│     ├─ src/
│     │  ├─ main.ts          # HOST/PORT 可配置（容器内 0.0.0.0）
│     │  ├─ app.module.ts    # 全局限流守卫（Throttler）+ 各业务模块
│     │  ├─ modules/health/  # 健康检查
│     │  ├─ modules/auth/    # 注册登录：controller / service / jwt 配置与守卫 /
│     │  │                   # password.service.ts（scrypt 哈希与校验）/ account.rules.ts（账号·密码·邮箱·头像白名单）
│     │  ├─ modules/family/  # 家庭与成员：controller / service /
│     │  │                   # family.roles.ts（角色→能力表、邀请码生成与归一）
│     │  ├─ modules/orders/  # 点单：controller / service /
│     │  │                   # orders.rules.ts（状态机、流转权限、日期范围、卡片合并——纯规则，可单测）
│     │  ├─ modules/checkins/# 打卡：controller / service / checkins.rules.ts（大小·备注·魔术字节·热力图·连续
│     │  │                   # 天数——纯规则）/ checkins.signature.ts（照片短链签名与校验）
│     │  ├─ modules/favorites/# 收藏（M1 F1-09）：controller / service / favorites.rules.ts（id 校验、上限判定）
│     │  ├─ modules/discover/ # 决策引擎（M5 F5-02）：controller / service / discover.rules.ts（按餐去重、合分排序）
│     │  ├─ modules/shopping/ # 采购清单（M7 F7-01）：controller / service / shopping.rules.ts（用量文本合并、按名汇总）
│     │  ├─ modules/mail/    # 发信通道（可插拔）：console（开发，写日志）/ smtp（真发信）
│     │  ├─ modules/recipes/ # 菜谱：controller / query / provider（可插拔）/ howtocook 解析器 / importer
│     │  │  └─ sources/      # 外部数据源适配器：recipe-source.ts（归一规则）、jisu / uapis / jumdata.source.ts
│     │  ├─ modules/media/   # 图片自托管：media.storage.ts（S3 客户端 / 桶准备 / 上传 / 对外地址拼接）
│     │  └─ scripts/         # import-recipes.ts（多源导入，关键词或按分类）、normalize-names.ts（补用菜名清理）、
│     │                      # mirror-images.ts（把第三方图片备份进 MinIO）、
│     │                      # fetch-recipes.ts + seed-recipes.ts（HowToCook 历史实现，已不作数据来源）
│     ├─ .npmrc
│     ├─ pnpm-workspace.yaml
│     └─ nest-cli.json / tsconfig.json / .env.example
└─ packages/                 # ⬜ 共享包（暂未引入 workspace）
```

## 端口与运行位置（已实测）

| 对象 | 位置/端口 | 状态 |
| --- | --- | --- |
| 前端 dev server | 本机 `apps/mobile` · `http://127.0.0.1:5173` | ✅ 已验证（`pnpm run dev`，**不进 Docker**） |
| 前端构建产物 | `apps/mobile/dist` | ✅ 已验证（`pnpm run build`） |
| 后端 API | 容器 `cook-api-1` · `http://127.0.0.1:3000/api`（宿主映射） | ✅ 已验证（`docker compose up -d`） |
| 后端接口文档 | `http://127.0.0.1:3000/api/docs` | ✅ Swagger |
| 数据库 | 容器 `cook-mysql-1` · MySQL 8.4 · `127.0.0.1:3306` · 库名 `cook` | ✅ 已建库建表（迁移 init / recipe_image_mirror / auth_users / family_and_password_reset），数据在命名卷 `cook_mysql-data` |
| 对象存储（菜谱图 + 打卡照片） | 容器 `cook-minio-1`（**自建镜像 `cook-minio`**，源码 `services/minio/Dockerfile`）· S3 API `http://127.0.0.1:9000` · 控制台 `http://127.0.0.1:9001` · 数据卷 `minio-data` 挂在 `/data` · 桶：`cook-media`（菜谱图，公开只读）/ `cook-checkins`（打卡照片，**私有、无公开读策略，只给签名短链**） | ✅ 已验证：健康检查 healthy、`cook-media` 598 对象 / 8.9 MiB、匿名读 200；`cook-checkins` 匿名读 **403**、带签名 + 令牌 200 |
| 容器网络 | compose 网络 `cook_default`；容器内互访用服务名 `mysql` / `api` / `minio` | ✅ |

## 配置

- 前端环境变量前缀 `VITE_`；模板见 `apps/mobile/.env.example`。**打包 APK 前需把 `VITE_API_BASE_URL` 指向服务器地址**（本机开发指向 `http://127.0.0.1:3000/api`）。
- compose 用根目录 `.env`（模板 `.env.example`）：`MYSQL_ROOT_PASSWORD` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` / `MYSQL_PORT` / `API_PORT` / `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` / `MINIO_PORT` / `MINIO_CONSOLE_PORT` / `MEDIA_S3_BUCKET` / `MEDIA_BASE_URL` / `JWT_SECRET` / `MAIL_TRANSPORT`（+ `MAIL_SMTP_*`、`PUBLIC_APP_URL`）/ `NPM_REGISTRY` / `CORS_ORIGIN`。
- 后端环境变量见 `services/api/.env.example`（`DATABASE_URL` / `PORT` / `HOST` / `CORS_ORIGIN` + 图片自托管的 `MEDIA_S3_*` / `MEDIA_BASE_URL` / **`MEDIA_S3_PRIVATE_BUCKET`（打卡照片私有桶，默认 `cook-checkins`）** + 登录鉴权的 `JWT_SECRET` / `JWT_ACCESS_TTL_SECONDS`）。宿主机连容器库用 `127.0.0.1`，容器内连库由 compose 覆盖为服务名 `mysql`。
- **`JWT_SECRET` 必填且 ≥32 字符**：缺失或过短后端**直接启动失败**（刻意不给默认值，防止"开发默认密钥"上生产）。生成：`openssl rand -base64 48`。
- **`MAIL_TRANSPORT` 默认 `console`**（找回密码的邮件只写日志、且接口会把重置链接回给调用方）：**部署到公网前必须改成 `smtp`**，并把 `PUBLIC_APP_URL` 改成正式域名（见 `RISKS.md` R-16）。
- **图片地址**：接口返回的图片 URL = `MEDIA_BASE_URL` + `imageKey`（如 `http://127.0.0.1:9000/cook-media/recipes/<hash>.jpg`）。**`MEDIA_BASE_URL` 必须是浏览器/APK 能访问到的地址**——本机开发写回环，部署到服务器时改成域名或公网 IP，写错了页面就无图。
- **包管理器**：前后端统一用 **pnpm 12**（原 npm 锁文件归档在 `history/`）。**密钥（数据库密码、第三方 API key 等）一律放 `.env`，不写入文档、不入库、不进对话记录。**
- **CORS**：后端只放行 `CORS_ORIGIN`（默认 `http://127.0.0.1:5173`）。换端口起前端必须同步加白名单，否则页面显示"暂时连不上厨房"。**APK 走 WebView，其 Origin 与网页不同，接入 M14 时需一并放行。**

## 部署（服务器待定，形态已定）

- **形态**：本地与服务器共用 `docker-compose.yml` —— 起 `mysql` + `minio` + `api` 三个容器；前端不入容器（开发本机跑 Vite，发布由 Capacitor 打包 APK）。
- **数据落盘**：库数据在命名卷 `cook_mysql-data`，菜谱图片在命名卷 `minio-data`，都不随容器删除丢失；删卷即丢数据，别乱 `down -v`。
- **迁移**：api 容器启动时自动执行 `prisma migrate deploy`，无需手工建表。
- **数据**：落在命名卷 `cook_mysql-data`，`docker compose down` 不丢数据（`down -v` 才会删）。
- **待定**：服务器厂商与配置、域名与 HTTPS、数据库备份策略、强密码。确定后在此登记实际地址与流程，不提前虚构。
