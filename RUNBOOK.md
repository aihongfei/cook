# RUNBOOK

> 有依据的操作步骤、前置条件与验证方法。**未执行的命令标注「未验证」，文档中的步骤不构成执行授权。**

## 前置条件（当前状态）

- Node.js：**已就绪 v26.7.0**（nvm 装在 `%LOCALAPPDATA%\Author Software\nvm`；PATH 经 `C:\nvm4w\nodejs` 连接生效）。Git：已安装 `C:\Program Files\Git\cmd\git.exe`。
- 数据库：开发期计划用 SQLite，无需额外安装；生产 PostgreSQL 待定。
- 工作目录：`C:\Users\Administrator\Desktop\cook`

---

## R-000 环境自检 ✅ 已解决（Node v26.7.0 可用）

```bat
node -v
npm -v
git --version
```

**实测结果（2026-10-11）：三条命令全部报"不是内部或外部命令" → Node.js 实际未安装成功；Git 已安装于 `C:\Program Files\Git\cmd\git.exe`；`C:\nvm4w` 为空目录。**

### 已解决（2026-10-11）——以下为当时的排查过程，保留供追溯

**最终处理**：nvm-windows 实际装在 `%LOCALAPPDATA%\Author Software\nvm`，Node **v26.7.0** 已安装且为 default。执行：

```bat
mklink /J "C:\nvm4w\nodejs" "%LOCALAPPDATA%\Author Software\nvm\installs\v26.7.0"
setx NVM_HOME "%LOCALAPPDATA%\Author Software\nvm"
```

验证：`"C:\nvm4w\nodejs\node.exe" -v` → `v26.7.0`；`npm.cmd -v` → `11.19.0`。**新开终端后 `node -v` 直接可用。**（`C:\nvm4w\nodejs` 本来就在 PATH 里，所以建好连接即生效。）

### 历史排查过程

**推荐路线**

1. 打开 https://nodejs.org/ ，下载 **Windows x64 LTS**（≥ 22.19）的 `.msi` 安装包。
2. 安装时勾选 "Add to PATH"。
3. **关闭所有终端与编辑器后重新打开**，再复测：

```bat
node -v
npm -v
```

**备选路线（修复 nvm-windows）**

1. 重装 nvm-windows 到 `C:\nvm4w`；2. `nvm install lts`；3. `nvm use lts`；4. 复测 `node -v`。

预期：`node` 打印 `v22.x` 或更高（必须 ≥ v22.19.0），`npm` 打印版本号。全部通过后才可进入 M0。

---

## R-001 前端：安装 / 构建 / 启动（✅ 已验证，2026-10-11 起改用 pnpm）

前置：Node ≥ 22.19（见 R-000）；包管理器用 **pnpm**（与后端一致）。

```bat
cd /d C:\Users\Administrator\Desktop\cook\apps\mobile
pnpm install
pnpm run build      :: tsc -b && vite build
pnpm run dev        :: 开发服务器 http://127.0.0.1:5173
```

**实测结果（2026-10-11，pnpm）**：
- `pnpm install` 成功（224 包）；依赖构建许可写在 `apps/mobile/pnpm-workspace.yaml` 的 `allowBuilds`（见下方排查）。
- `pnpm run build` 通过 → `dist/`：`index.html 0.89 kB`、CSS `28.77 kB`（gzip 6.96 kB）、JS `436.91 kB`（gzip 147.44 kB）。
- `pnpm run dev` 启动成功，`http://127.0.0.1:5173/kitchen` 与 `/recipes` 均返回 200。
- `pnpm run test` → 2 文件 **11/11** 通过（`src/api/recipes.test.ts`、`src/pages/recipes/recipes.test.tsx`）。
- 五条路由逐条实测：`/kitchen`、`/order`「家宴点菜单」、`/discover`「发现」、`/fridge`「我的冰箱」、`/mine`「我的」；底部 Tab 高亮均正确；`/recipes`、`/recipes/:id` 同壳挂载、厨房 Tab 高亮。

其他脚本：`pnpm run typecheck`（tsc -b）、`pnpm run lint`（oxlint）、`pnpm run format`（prettier）。

**迁移备忘（npm → pnpm）**：
- 转换：`pnpm --dir apps/mobile import`（读取 `package-lock.json` 生成 `pnpm-lock.yaml`）；原 npm 锁文件归档到 `history/package-lock.mobile.pre-pnpm.json`，未删除。
- `pnpm install --frozen-lockfile` 在锁文件元数据未同步时会报 `ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE` → 先跑一次普通 `pnpm install` 同步，再回到 frozen。

**排查备忘**：
- **`ERR_PNPM_IGNORED_BUILDS` 让安装非零退出** → pnpm 12 的放行名单在 `pnpm-workspace.yaml` 的 **`allowBuilds` 映射**（如 `esbuild: true`、`'@parcel/watcher': true`、`'@scarf/scarf': false`）；实测旧的 `onlyBuiltDependencies` / `ignoredBuiltDependencies` 在本机不生效。
- 若整页背景/颜色失效、`var(--color-*)` 取不到值 → 检查 `src/styles/tailwind.css` 是否用了 `@theme static`（Tailwind v4 默认只输出被工具类引用的 token）。
- 若 `Cannot find module '@/...'` → 检查 `tsconfig.app.json` 的 `paths`（TS 6 已弃用 `baseUrl`，`paths` 相对 tsconfig 解析）。
- **换端口起前端会被浏览器拦**（接口 200 但页面报“暂时连不上厨房”）→ 后端 CORS 只放行 `services/api/.env` 里的 `CORS_ORIGIN`（默认 `http://127.0.0.1:5173`），换端口需同步加白名单。

---

## R-002 后端：安装 / 建库 / 构建 / 启动（✅ 已验证）

前置：Node ≥ 22.19；包管理器用 **pnpm**（见下方 pnpm 排查）。

```bat
cd /d C:\Users\Administrator\Desktop\cook\services\api
pnpm install --dangerously-allow-all-builds
copy .env.example .env
pnpm exec prisma migrate dev --name init
pnpm run build
pnpm run start:prod
```

**实测结果（2026-10-11）**：
- `pnpm install` 成功（NestJS 12 / Prisma 6.19.3）。
- `prisma migrate dev --name init` → 创建 `prisma/dev.db`，迁移 `20261011145533_init` 已应用，Prisma Client 生成成功。
- **菜谱迁移**：`20261011151646_recipes` 已应用（`Recipe` 表），随后 `pnpm run seed:recipes` 入库 28 道（见 R-003）。
- `pnpm run build` → `dist/main.js`、`dist/app.module.js`、`dist/modules/`。
- `pnpm run start:prod` → 映射 `GET /api/health`，Nest 启动成功。
- 接口实测：`http://127.0.0.1:3000/api/health` 返回
  `{"status":"ok","name":"yushan-api","version":"0.1.0","uptime":17,"timestamp":"...","node":"v26.7.0"}`；`GET /api/recipes` 返回 `total=28`。
- **注意**：2026-10-11 曾停掉 3000 上残留的旧构建进程（`node dist/main`，只含 health）并换成本次构建；改代码后必须 `pnpm run build` + 重启 `start:prod`，否则端口上仍是旧代码。

接口文档：`http://127.0.0.1:3000/api/docs`（Swagger）。

### pnpm 排查备忘（都踩过）

- **`ERR_PNPM_IGNORED_BUILDS` 会让安装链中断**：pnpm 的依赖构建白名单不再读 `package.json` 的 `pnpm` 字段。放行名单写在 `services/api/pnpm-workspace.yaml` 的 `onlyBuiltDependencies` / `ignoredBuiltDependencies`；临时绕过可用 `pnpm install --dangerously-allow-all-builds`。
- **`pnpm add -D <pkg>` 取 latest 会装到 RC**：本次误装 `prisma@8.0.0-rc` 与 `typescript@7`。**优先改 package.json 再 `pnpm install`**，不要盲用 `pnpm add`。
- **Prisma 7 破坏性变更**：`datasource.url` 不再支持，需改用 `prisma.config.ts` + driver adapter。M0 阶段先用 **Prisma 6.x**（稳定、`url = env("DATABASE_URL")` 仍可用）。
- **NestJS 12 要求 TypeScript ≥ 6**（`@nestjs/schematics@12` 的 peer）。
- **TS 6 弃用项**：`moduleResolution: "node"` 已弃用 → `tsconfig.json` 里加了 `ignoreDeprecations: "6.0"` 暂时静默（技术债，后续迁到 `node16`/`nodenext`）。

---

## R-003 导入菜谱种子数据（✅ 已验证，2026-10-11）

前置：Node ≥ 22.19；后端依赖已装（R-002）。

```bat
cd /d C:\Users\Administrator\Desktop\cook\services\api
pnpm run fetch:recipes   :: 抓取 HowToCook 固定 commit 的 Markdown，解析并写出 seeds/howtocook.json
pnpm run seed:recipes    :: 幂等 upsert 入库（不覆盖用户自建菜谱）
```

**实测结果**：

- `fetch:recipes` 产出 `services/api/seeds/howtocook.json`：28 道真实菜谱，固定 commit `3dfa950f6daf0a5b311fc46619f1b559bac980c4`、许可证 Unlicense（随详情接口返回）。
- `seed:recipes` → `{"imported":28,"skipped":0,"total":28}`；重复执行结果一致（幂等，测试已覆盖）。
- 解析口径：`## 必备原料和工具` 按工具特征归入 tools，`## 计算` 的用量合并回配料，`###` 子标题保留为步骤分组；原文无热量时 `calories=null`，不估算不造数。
- 若改了 `howtocook.parser.ts` 的解析规则：**必须同步重新生成 `seeds/howtocook.json`**（`tests/recipe.importer.test.ts` 会逐条比对“重新解析结果 == 种子文件”），再重跑 `pnpm run test` 与 `pnpm run seed:recipes`。

---

## R-003b 菜谱接口 HTTP 验收（✅ 已验证，2026-10-11）

前置：后端服务已在运行（R-002 的 `pnpm run start:prod`）。

```bat
cd /d C:\Users\Administrator\Desktop\cook\services\api
pnpm run test:http        :: 可用 BASE_URL 覆盖，默认 http://127.0.0.1:3000/api
```

**实测结果**：**18/18 通过**。覆盖：分页结构与总数（28 条 / 首页 12 条）、第二页不重叠、搜索命中（菜名/配料/标签、别名「番茄炒鸡」）、品类×菜系交叉筛选（素菜×家常=7）、`/filters` 返回 4 品类、无结果 200 + total=0、详情含配料/步骤/来源许可与固定 commit、未知 id 404、非法查询（`page=0`/`page=99999`/`pageSize=1000`/重复参数/未知参数）400。


---

## R-004 验证第三方图片生成接口（已执行，成功）

```bat
curl -s -X POST "https://api.ymeng.cc/v1/images/generations" ^
  -H "Authorization: Bearer <KEY>" ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"gpt-image-2\",\"prompt\":\"flat vector rabbit chef app icon\",\"size\":\"1024x1024\",\"n\":1}"
```

- **结果：HTTP 200，约 20s，返回 `{"data":[{"b64_json":"..."}]}`**，解码为 1024×1024 PNG（约 1.2MB）。
- 该端点**不支持** `GET /v1/models`（返回 401 属正常，不要据此判断密钥失效）。
- 密钥从 `.env` 读取，**不得写入本文件**。
- 生成脚本（落地后）：把 `b64_json` 解码写入 `packages/seed-data/assets/` 或 `apps/mobile/public/`。

---

## R-005 探测 AI 网关能力（已执行，确认不支持识图）

```bat
curl -s https://api.ymeng.cc/v1/models -H "Authorization: Bearer <KEY>"
:: 返回 4 个模型，supported_endpoint_types 全为 ["image-generation","openai"]

curl -s -X POST "https://api.ymeng.cc/v1/chat/completions" ^
  -H "Authorization: Bearer <KEY>" -H "Content-Type: application/json" ^
  -d "{\"model\":\"gpt-image-2\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":5}"
:: 不返回文本，返回一张 base64 图片 → 端点被代理到出图模型
```

**结论：该网关只能出图，不能看图。** 拍照识别（冰箱食材/菜品/营养）必须由用户另配多模态模型，走配置文件（见 `DECISIONS.md` D-009）。

---

## R-006 Git 与 GitHub 远端（✅ 已执行，2026-10-11）

仓库 `https://github.com/aihongfei/cook`，**Private**，默认分支 `main`，远端 `origin` 已配好并跟踪。

```bat
:: 首次建仓 + 推送（已执行成功）
gh repo create cook --private --source=. --remote=origin --push

:: 日常提交推送
git add -A
git commit -m "feat: ..."
git push
```

- GitHub CLI **2.102.0**，路径 `C:\Program Files\GitHub CLI\gh.exe`（winget 安装，**新开终端**才在 PATH 中；当前会话可用绝对路径调用）。
- 认证：`gh auth login --web --git-protocol https`（设备码流程，非交互 shell 下也能跑），token 存 Windows keyring，作用域 `repo` / `read:org` / `gist`。
- 提交署名（**仓库级**，未改全局）：`aihf <82986195+aihongfei@users.noreply.github.com>`。用 GitHub 官方 noreply 邮箱，不暴露真实邮箱。
- 不入库清单见 `.gitignore`：`.env`、`*.db`、`node_modules/`、`dist/`，以及 **`参考图片/`**（第三方 App 截图，版权风险，仅本地对照）。
- **密钥一旦推送就无法靠删文件清除**，必须 `git filter-repo` 重写历史 + 强推；提交前先跑下面的自查。

```bat
:: 远端内容核对（期望：126）
gh api "repos/aihongfei/cook/git/trees/main?recursive=1" --jq "[.tree[]|select(.type==\"blob\")]|length"

:: 敏感文件自查（期望：无输出）
gh api "repos/aihongfei/cook/git/trees/main?recursive=1" --jq ".tree[].path" | findstr /R "node_modules \.env$ \.db$ 参考图片 dist/"
```

**实测结果（2026-10-11）**：建仓推送成功；远端 126 blob 与本地一致；可见性 PRIVATE；敏感文件自查无输出。
