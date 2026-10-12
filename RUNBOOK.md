# RUNBOOK

> 有依据的操作步骤、前置条件与验证方法。**未执行的命令标注「未验证」，文档中的步骤不构成执行授权。**

## 前置条件（当前状态）

- **当前工作副本（2026-10-12 实测）**：macOS（Darwin arm64），工作目录 `/Users/aihf/Downloads/work/cook`；Node **v26.7.0** 与 **pnpm 12.11.2** 位于 `~/.nvm/versions/node/v26.7.0`（nvm 默认别名 `26.7.0`；非登录 shell 需自行把该目录加入 PATH，Node 26 已不再随包分发 `corepack`）。
- 数据库：开发期用 SQLite（`services/api/prisma/dev.db`，已建库并应用 init + recipes 两个迁移，**未导入种子数据**），无需额外安装；生产 PostgreSQL 待定。
- 历史环境（2026-10-11，另一台 Windows 机器）：Node v26.7.0（nvm-windows，见 R-000）、Git 在 `C:\Program Files\Git\cmd\git.exe`、工作目录 `C:\Users\Administrator\Desktop\cook`。下方 R-001/R-002 代码块里的 `cd /d C:\...` 属于该环境；在 macOS 上请改用仓库内相对路径（推荐 `pnpm --dir apps/mobile ...` / `pnpm --dir services/api ...`）。

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

## R-007 Docker：起后端 + MySQL（✅ 已验证，2026-10-12）

> **2026-10-12 起，本地开发的默认形态**：后端与数据库跑 Docker，前端在本机跑 Vite。
> 前端不进容器（发布走 Capacitor 打 APK），见 `DECISIONS.md` D-018。
> 下方 R-001 / R-002 的 SQLite 建库步骤已作废（迁移已换 MySQL 方言，旧迁移归档在 `history/prisma-sqlite-archive/`）。

前置：Docker Desktop 已启动（`open -a Docker`，守护进程要真的在跑，光装 App 不够）。

```bash
# 首次：准备 compose 用的环境变量（.env 不入库）
cp .env.example .env        # 按需改密码与端口

# 起后端 + MySQL（首次会构建镜像，耗时取决于网络）
docker compose up -d --build

# 看状态与日志
docker compose ps
docker compose logs -f api

# 停掉（保留数据卷）
docker compose down
# 连库清空重建（会删数据！仅开发期用）
docker compose down -v && docker compose up -d --build
```

**实测结果（2026-10-12，本机 macOS，Docker Desktop 29.8.2）**：
- `docker compose up -d --build` 成功；容器 `cook-mysql-1`（healthy，3306）、`cook-api-1`（3000）。
- api 容器启动时自动执行 `prisma migrate deploy` → 建表 `AppMeta` / `Recipe` / `_prisma_migrations`。
- `GET http://127.0.0.1:3000/api/health` → 200 `{"status":"ok","node":"v24.21.0"}`；`/api/recipes` → 200（空库 `total=0`）。
- 与宿主机前端联调：跨域预检 `OPTIONS /api/recipes`（Origin `http://127.0.0.1:5173`）→ **204** + `Access-Control-Allow-Origin: http://127.0.0.1:5173`。

**踩坑备忘**：
- **容器内必须监听 `0.0.0.0`**：`main.ts` 原先硬编码 `127.0.0.1`，容器里宿主机连不上；现由 `HOST` 环境变量控制（compose 设为 `0.0.0.0`）。
- **MySQL 下 String 默认是 `VARCHAR(191)`**：`searchText`（拼接了名称/别名/配料/标签）与 `rawMarkdown` 必超长，已加 `@db.Text`；否则导入时报 `Data too long`。
- **`prisma migrate dev` 需要建影子库**：应用账号 `cook` 只有单库权限，会失败；从宿主机生成迁移时用 root 连接：
  `DATABASE_URL="mysql://root:<root密码>@127.0.0.1:3306/cook" pnpm exec prisma migrate dev --name <名字>`
- **entrypoint 用 `./node_modules/.bin/prisma` 而不是 `pnpm exec prisma`**：后者会触发 pnpm 的 `verifyDepsBeforeRun` 校验，在容器里白跑一次安装并在受限网络下报警。
- **国内构建慢**：`.env` 里 `NPM_REGISTRY=https://registry.npmmirror.com` 可显著加速镜像构建（仅构建期取包，锁文件完整性仍会校验）。
- **Docker Hub 拉基础镜像偶发失败**（`failed to fetch anonymous token ... connection refused`）：重试一次通常即可，不必改配置。
- **后端单测需要 MySQL 容器在跑**：测试用独立测试库 `cook_test`（自动 `CREATE DATABASE IF NOT EXISTS` 并应用同一份迁移），不碰应用库 `cook`。故 `pnpm --dir services/api run test` 前先 `docker compose up -d mysql`。
- **MySQL 的 JSON 列不保留对象键顺序**：换库后暴露的真实坑——导入器原先用 `JSON.stringify` 比较判断"内容是否变化"，键序被 MySQL 重排后误判为有变，重跑导入会刷新 `updatedAt`、破坏幂等。已改为递归排序键再比较（`canonicalJson`），并在 update 分支显式带回原 `updatedAt`。

---

## R-008 导入菜谱（外部数据源 → MySQL）（✅ 已验证，2026-10-12）

前置：MySQL 容器在跑（`docker compose up -d mysql`）；`.env` 里的 `DATABASE_URL` 指向它。

```bash
# ① 按关键词检索并入库（uapis 免密钥，可当兜底源）
pnpm --dir services/api run import:recipes -- --keywords=番茄炒蛋,红烧排骨,可乐鸡翅 --limit=3
# 参数：--source=<源标识>（默认 uapis；已登记 uapis / jumdata / jisu） --keywords=<逗号分隔> --limit=<每词条数>

# ② 按分类批量建库（主力用法，极速数据 jisu）
pnpm --dir services/api run import:recipes -- --source=jisu --categories=307,305,351 --limit=40
#     --categories=all → 枚举分类树里的全部叶子分类
#     分类 id 从 /recipe/class 取；只认叶子分类，传顶级 id 会返回 205 没有信息

# ③ 把「入库时才生效」的菜名清理规则补用到历史行（不调用任何接口，可反复执行）
pnpm --dir services/api run normalize:names

# ④ 聚美智数（步骤细但无图，仅作补充源）
pnpm --dir services/api run import:recipes -- --source=jumdata --keywords=红烧排骨 --limit=5
```

### 极速数据 jisuapi（主力源，✅ 实测跑通 2026-10-12）

- **密钥**：`JISU_APP_KEY` / `JISU_APP_SECRET` 写进 `services/api/.env`（被 gitignore）。**不要写进 `.env.example`（该文件会提交）**。适配器只读 `JISU_APP_KEY`（作为 `appkey` 查询参数）。
- **接口**：`GET /recipe/class`（分类树）、`GET /recipe/byclass`（按分类枚举）、`GET /recipe/search`（关键词）、`GET /recipe/detail`。成功码 `status=0`。
- **`103 APPKEY无请求此数据权限` = 密钥有效但这个接口没开通**，要去极速数据后台**申请/开通「菜谱」接口**——不是改代码能解决的（本次就卡在这一点上）。
- **`byclass` 关键约束（都实测过）**：
  - 一次返回**含 `material`/`process` 的完整菜谱**，不需要再逐条调详情（比 uapis 省的调用就在这）。
  - `result` 是**对象** `{ total, num, list }`，不是数组。
  - **`num` 硬上限 20**：传 50、100 都只回 20 条，翻页只能靠 `start`。
  - **只认叶子分类**：传顶级 id（如 `1 功效`）返回 `205 没有信息`。
  - `material[].type` 是**数字**：1 主料、0 辅料（主料排在数组末尾），按字符串比会全判成辅料。
- **图片**：`pic` 实测 230×230 px / 16KB JPEG；域名 `api.jisuapi.com` 的 **https 同样可用**，适配器统一把 http 升到 https（避免 APK 内被混合内容策略拦）。**但其文档写明图片链接会过期 → 转存 MinIO 是打包前必做项**。
- **规模与成本**：家常菜类目 `total=12710`、热菜 2681、川菜 456。按 20 条/页，**拉满家常菜约 636 次调用**，扩库要按套餐额度分批跑（`sourceKey` 去重，重跑不会重复入库）。
- **分类树**：14 个顶级、子类合计 900+，但**大部分节点不是菜品分类**（"功效/人群/疾病/体质/场景"是筛选维度）。建库挑「菜品(301)」下的叶子（素菜 307、汤 351、羹 352、海鲜 312、饭 320、面 326…）与「菜系(223)」下的菜系叶子。

**实测结果（2026-10-12）**：
- 权限开通前 `status=103`，开通后 `status=0`。
- 16 个分类、**32 次调用 / 52 秒 → 入库 640 条（去重后库内 600 道）**；构成 `jisu=589`、`uapis=9`、`jumdata=2`，**598/600 带图**。
- 品类分布 主食 235 / 素菜 156 / 荤菜 123 / 汤 86；菜系 10 种（家常 541、川菜 40、苏菜 5、粤菜 4…）。
- 600/600 都有食材与步骤（源站最少 2 项食材、3 步）。

### 聚美智数 jumdata（补充源，✅ 已实测）

- 分类查询 `POST https://api.jumdata.com/cookbook/type`；菜谱查询 `POST https://api.jumdata.com/cookbook/list`（`x-www-form-urlencoded`）。
- 签名：`sign = sha256(appId + appSecret + timestamp)`；`productCode` 固定 `cookbook_query`。
- **`type`（分类）是必填参数**——所以适配器先取分类树，再逐个一级分类按 `name` 检索。
- 返回字段：`name/typeV1-V3/tip(小贴士)/largeImg/smallImag/steps[{orderNum,content}]/yl[{ylName,ylUnit}]`。
- **实测结论**：接口可用（成功入库 2 条）。**抽到的菜谱都没有图片**——与文档示例里图片字段为空一致，因此该源**不满足"图片必须要有"**，仅作补充源；步骤很详细（14 步 / 8 步）但无配图；原料部分带用量（`排骨 → 1.5斤` 解析正确）、部分只有名称；`tip` 小贴士部分有。

### 归一口径（各源共用）

- **品类：源站分类优先**——源站分类名命中映射表（`SOURCE_CATEGORY_MAP`）就直接采用（源站事实）；未命中才退回菜名关键词规则（汤 → 主食 → 素菜 → 荤菜），都不命中归「荤菜」。原始标签完整保留在 `tags`，可无损重映射。**理由**：纯菜名启发式把源站「素菜」类下的"姜汁腐竹拌芹菜"判成了荤菜。
- **菜系：源站事实**——从源站分类名与标签里提取真实菜系（`deriveCuisine()`），没有就写「家常」，不臆造。
- **厨具词先剥掉**：`电饭锅`/`面包机`/`烤箱`… 里的"饭""面"会把菜误判成主食（`红烧肉（电饭锅）` 曾中招），已修并加测试锁住。
- **菜名清理**（`cleanDishName()`）：剥掉 `[原创首发]`、`【儿童美食】` 这类编辑/人群前缀；**不无条件剥括号**——源站有「【红烧排骨】万用的炒糖上色法」「【桂圆银耳羹】」这种菜名本身在括号里的写法。历史行用 `normalize:names` 补用。
- **占位值不当内容**：源站用「无」占位时（`preparetime: 无`）不再渲染出"准备 无"。
- **`origin`/`sourceKey` 必须写进入库负载**：DB 列有默认值，漏写会变成 `origin='user'` 且 `sourceKey=NULL`——既破坏去重，又会让下次导入把记录误判成"用户自建"而跳过（本次实测踩到并修正）。
- **幂等用 `canonicalJson()` 比对**：**MySQL 的 JSON 列不保留对象键顺序**，直接 `JSON.stringify` 比会把"无变化"误判成"有变化"并刷新 `updatedAt`。
- **热量不臆造**：源站无卡路里，一律存 `null` + `caloriesEstimated=false`，前端显示「热量暂无」。

### 实现位置

- 适配层：`src/modules/recipes/sources/`（`recipe-source.ts` 归一规则、`jisu.source.ts`、`uapis.source.ts`、`jumdata.source.ts`）+ `src/scripts/import-recipes.ts`、`src/scripts/normalize-names.ts`。
- 新增源：实现 `search()` 即可；支持分类枚举的源再实现 `listCategories()` + `enumerate()`，并在 `import-recipes.ts` 的 `SOURCES` 里登记。
- **调用成本**：uapis 搜索 1 积分/次、详情 3 积分/次（每条都要再取一次详情才有配料与步骤），限流 4 QPS，脚本内按 300ms 串行节流；jisu 一次调用回 20 条完整菜谱。

---

## R-009 菜谱图片自托管（备份进 MinIO）（✅ 已验证，2026-10-12）

前置：`docker compose up -d mysql minio`；`services/api/.env` 里配好 `MEDIA_S3_*`（值同根 `.env` 的 `MINIO_ROOT_USER/PASSWORD`）。

```bash
# 把第三方图床的图片备份进 MinIO，并回写 Recipe.imageKey/imageHash
pnpm --dir services/api run mirror:images
#   --force  忽略已有记录、强制重新下载（换了图源或怀疑图坏了时用）
```

**为什么要做**：图片原本是第三方域名直链，官方文档明确写"图片链接会过期"。备份后前端只读自己的图，**第三方接口只在首次导入时用到，运行时不再依赖**（也不会因此反复花调用次数）。

**实现要点**：
- 代码：`src/modules/media/media.storage.ts`（S3 客户端 / 桶准备 / 上传 / 对外地址拼接）+ `src/scripts/mirror-images.ts`。
- **只下载图片文件，不调用数据源业务接口** → 备份不消耗第三方 API 调用次数。
- 文件名 = 图片内容的 **sha256**：同一张图被多道菜引用只存一份；重复执行不会重传。
- 同一批里按源 URL 去重，串行 120ms 节流；响应 `Content-Type` 不是已知图片类型（如限流时返回的 HTML）或体积异常的一律拒收。
- **跳过条件是「对象确实在桶里」（HeadObject 探测），不是"DB 里有 imageKey"**。两者会不一致——本次实测踩到：被中断的一次运行给 327 行写了 `imageKey` 但对象并没上传，只看 DB 就会让这 327 道菜的图在页面上 404。脚本现在会自愈补传。
- 桶不存在会自动创建并设为**公开只读**（菜谱图是给所有登录用户看的公开内容；私有内容应另建私有桶）。
- 接口返回地址由 `publicImageUrl()` 决定：**有自托管副本用副本，没有才回退源站直链**（`MEDIA_BASE_URL` 没配的环境也不会无图）。

**实测结果（2026-10-12）**：
- 两次运行合计：`598 道全部备份成功，失败 0`；覆盖率 **598/600**（缺的 2 道是库内本来就无图的 jumdata 记录）。
- MinIO `cook-media` 桶：**598 个对象 / 8.9 MiB**。
- 直连图片：`GET http://127.0.0.1:9000/cook-media/recipes/<hash>.jpg` → **HTTP 200、image/jpeg、16534 字节**。
- 浏览器实测：`/recipes` 列表 12/12 张卡片图全部来自 `127.0.0.1:9000`，`complete && naturalWidth > 0` 全部为真；厨房页推荐位同样来自 MinIO。

**MinIO 常用运维命令**（镜像内置 `mc`）：
```bash
docker exec cook-minio-1 /opt/bitnami/minio-client/bin/mc ls --recursive local/cook-media | wc -l   # 对象数
docker exec cook-minio-1 /opt/bitnami/minio-client/bin/mc du local/cook-media                        # 占用
docker exec cook-minio-1 /opt/bitnami/minio-client/bin/mc anonymous set download local/cook-media    # 桶开公开只读
```

**⚠️ MinIO 镜像来源：用自建镜像（`services/minio/Dockerfile`）**。背景是实测出来的三条硬事实：
- MinIO 官方 Docker 镜像**已不可获取**：`docker pull minio/minio` → `pull access denied ... repository does not exist`（同期 `alpine:3.20` 可正常拉取，排除网络问题）；`quay.io/minio/minio` → `401 UNAUTHORIZED`。
- 官方直发二进制地址 `dl.min.io/server/minio/release/...` **现在返回 410 Gone**（连 `client/mc` 也是 410）。
- **但官方中国镜像站 `dl.minio.org.cn` 仍提供二进制**，自建镜像即从这里取。

```bash
docker compose build minio          # 自建镜像（自动按当前架构选 arm64/amd64）
docker compose up -d minio
```

自建镜像的要点：
- 二进制是 **MinIO 官方发布产物**（`minio --version` 会打印 `RELEASE.2025-04-22T22-12-26Z` / `GNU AGPLv3` / `Copyright: 2015-2025 MinIO, Inc.`），不是第三方二次打包。
- **版本固定 + sha256 校验**：Dockerfile 里钉死 release 与两个架构的哈希，上游若换文件构建会**直接失败报哈希不符**，不会悄悄装上不一样的东西。升级步骤：改 `MINIO_RELEASE` → 下载新文件 → `sha256sum` 更新对应 `ARG`。
- 海外服务器可用 `--build-arg MINIO_DOWNLOAD_BASE=https://dl.min.io` 覆盖下载源（但该站当前对 server 二进制返回 410，需先确认）。
- 镜像只含 `minio` 二进制（167 MB），**不含 curl/wget**；healthcheck 用 `minio --version`。桶与公开读权限不预置，由 `mirror:images` 幂等创建。
- 数据卷挂载点是 **`/data`**（旧的 Bitnami 镜像用 `/bitnami/minio/data`）。换镜像时**命名卷 `minio-data` 保留**，卷根就是数据目录，桶会原样被识别——本次切换后 598 个对象全部可用，已用备份脚本逐个探测确认（`待处理 0 个`）。

**配置项**（`MEDIA_S3_*` 走标准 S3 协议，换成阿里云 OSS / 腾讯云 COS / AWS S3 只改环境变量，不动业务代码）：
`MEDIA_S3_ENDPOINT`、`MEDIA_S3_REGION`、`MEDIA_S3_BUCKET`、`MEDIA_S3_ACCESS_KEY`、`MEDIA_S3_SECRET_KEY`、`MEDIA_BASE_URL`。

---

## R-001 前端：安装 / 构建 / 启动（⚠️ 部分作废，见 R-007 说明）

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
- **`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`（pnpm 12 默认供应链策略）** → pnpm 12 默认拒绝安装"发布未满 24 小时"的包；若锁文件里有刚发布的版本（本项目实测命中 `@tanstack/react-virtual` / `@tanstack/virtual-core`），安装会以"Lockfile failed supply-chain policy check"中断。因为锁文件是团队自己生成并已入库的，用 **`pnpm install --trust-lockfile`** 放行（只跳过本次锁文件校验，不改全局策略）；也可以等满 24 小时后再装。
- **`ERR_PNPM_IGNORED_BUILDS` 让安装非零退出** → pnpm 12 的放行名单在 `pnpm-workspace.yaml` 的 **`allowBuilds` 映射**（如 `esbuild: true`、`'@parcel/watcher': true`、`'@scarf/scarf': false`）；实测旧的 `onlyBuiltDependencies` / `ignoredBuiltDependencies` 在本机不生效（后端 `services/api` 已于 2026-10-12 改为 `allowBuilds`）。
- 若整页背景/颜色失效、`var(--color-*)` 取不到值 → 检查 `src/styles/tailwind.css` 是否用了 `@theme static`（Tailwind v4 默认只输出被工具类引用的 token）。
- 若 `Cannot find module '@/...'` → 检查 `tsconfig.app.json` 的 `paths`（TS 6 已弃用 `baseUrl`，`paths` 相对 tsconfig 解析）。
- **换端口起前端会被浏览器拦**（接口 200 但页面报“暂时连不上厨房”）→ 后端 CORS 只放行 `services/api/.env` 里的 `CORS_ORIGIN`（默认 `http://127.0.0.1:5173`），换端口需同步加白名单。

---

## R-002 后端：安装 / 建库 / 构建 / 启动（✅ 已验证）

前置：Node ≥ 22.19；包管理器用 **pnpm**（见下方 pnpm 排查）。

```bat
cd /d C:\Users\Administrator\Desktop\cook\services\api
pnpm install --trust-lockfile
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

- **`ERR_PNPM_IGNORED_BUILDS` 会让安装链中断**：pnpm 的依赖构建白名单不再读 `package.json` 的 `pnpm` 字段。**pnpm 12 的正确写法是 `pnpm-workspace.yaml` 里的 `allowBuilds` 映射**（`services/api/pnpm-workspace.yaml` 已于 2026-10-12 从前端的同款写法改过来：Prisma 三件套 `true`、`@scarf/scarf` `false`）；旧键 `onlyBuiltDependencies` / `ignoredBuiltDependencies` 在 pnpm 12 下不被读取，仍会报该错。临时绕过可用 `pnpm install --dangerously-allow-all-builds`（会连同遥测脚本一起放行，仅作应急）。
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

**实测结果**：**18/18 通过**。覆盖：分页结构与 pageSize、第二页不重叠、搜索命中菜名/配料/标签（含"只在配料里出现的关键词"）、品类×菜系交叉筛选（结果必须同时满足两个条件）、`/filters` 返回 4 品类、无结果 200 + total=0、详情含配料/步骤/来源四要素、未知 id 404、非法查询（`page=0`/`page=99999`/`pageSize=1000`/重复参数/未知参数）400。

> **订正（2026-10-12）**：本脚本原有 4 条断言写的是 HowToCook 种子时期的**固定数字**（总数 28、别名"番茄炒鸡"命中西红柿炒鸡蛋、素菜×家常=7、许可 Unlicense + 40 位 commit）。换数据源（种子弃用 → 第三方 API 聚合）后这些断言**实际长期失败（14/18）**，而本文档仍写着 18/18 —— 属于"历史结果当成了当前证据"。现已全部改为**行为断言**（不绑定会随数据规模变化的数字，也不绑定具体数据源），换源不会再误报。

---

## R-010 注册登录接口与验收（✅ 已验证，2026-10-12）

**前置：`JWT_SECRET` 必须先在 `.env` 里设好**（≥32 字符；没设或太短后端**直接启动失败**，这是刻意的——避免拿"开发默认密钥"上生产）。

```bash
# 生成一个随机密钥写进 .env（不要把值贴进任何文档/聊天）
openssl rand -base64 48
```

`.env` 需要（示例见 `.env.example`，**值只写在 `.env`**）：

| 变量 | 用途 |
| --- | --- |
| `JWT_SECRET` | 签发 access token 的密钥，**必填、≥32 字符** |
| `JWT_ACCESS_TTL_SECONDS` | access token 有效期，默认 7200（2 小时） |

**接口一览**（前缀 `/api`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/auth/register` | 注册（`account`/`password`/`nickname`/`avatar`），直接返回令牌 |
| POST | `/auth/login` | 登录，**限流 8 次/分**；密码错与账号不存在返回同一句话 |
| POST | `/auth/refresh` | 用刷新令牌换新令牌（**轮换：旧的立即吊销**） |
| POST | `/auth/logout` | 退出（吊销该刷新令牌） |
| GET | `/auth/me` | 当前账号（**需 Bearer token**） |
| PATCH | `/auth/me` | 改昵称/头像（头像须在白名单内） |
| GET | `/auth/options` | 注册口径：账号长度、密码规则、头像白名单（前端不硬编码规则） |

**验收**：

```bash
pnpm --dir services/api run test          # 单测（含密码哈希/规则/令牌轮换）
pnpm --dir services/api run test:http:auth # HTTP 验收：真实请求，20 项
pnpm --dir apps/mobile exec vitest run     # 前端 19 项（含 401 自动续期、守卫跳转）
```

> **注意（限流窗口）**：登录限流按 IP 计数且存在服务内存里，**连着跑两遍 `test:http:auth` 时第二遍会被第一遍的窗口拦成 429**。脚本已内置处理：先探测一次，若已限流就等窗口过期再跑（打印等待提示）。手工连续试登录失败时看到 429 属预期，等 1 分钟即可。
>
> **注意（容器代码是构建产物）**：改了后端代码必须 `docker compose up -d --build api` 再验收，否则验的是旧代码（曾因此出现"注册时选的头像没生效"，实际容器里根本没有该字段的支持）。

---

## R-011 数据库迁移与用户表（✅ 已验证，2026-10-12）

```bash
docker compose exec api npx prisma migrate deploy   # 容器启动时也会自动执行
```

- 迁移文件：`prisma/migrations/`（`20261012021730_init` 菜谱、`20261012032044_recipe_image_mirror` 图片自托管、`auth_users` 用户与刷新令牌）。
- 查用户（示例，**不要在生产库上随手改**）：

```bash
docker compose exec mysql mysql --default-character-set=utf8mb4 -uroot -p -e \
  "SELECT account, nickname, avatar, createdAt FROM cook.User ORDER BY createdAt DESC LIMIT 5;"
```

> `--default-character-set=utf8mb4` 必须带上，否则中文昵称与 emoji 头像在终端里显示成 `???`（数据本身没问题）。


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

---

## R-012 家庭与成员接口（✅ 已验证，2026-10-12）

**前置**：`JWT_SECRET` 已配置（见 R-010）；家庭相关的写操作都需要登录。

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/family` | 我的家庭（含成员列表、我的角色与能力）；**没加入返回 `null`** | 登录 |
| POST | `/family` | 创建家庭，创建者即掌勺人；已在家庭里 → 409 | 登录 |
| POST | `/family/join` | 凭六位邀请码加入（小写/空格自动归一）；**限流 10 次/分** | 登录 |
| PATCH | `/family` | 改家庭名与共享开关 | `family.edit` |
| POST | `/family/invite/reset` | 重置邀请码（旧码立即失效） | `invite.reset` |
| PATCH | `/family/members/:userId` | 改角色；**设为掌勺人即转让**，原掌勺人降为帮厨 | `member.manage` |
| DELETE | `/family/members/:userId` | 移出成员（不能移出自己） | `member.manage` |
| POST | `/family/leave` | 退出家庭；掌勺人只剩自己时即**解散** | 登录 |
| GET | `/family/options` | 三个角色与各自能力（**免登录**，前端不硬编码权限） | — |

```bash
pnpm --dir services/api run test:http:family   # 47 项，真实请求
```

**实测结果**：**47/47 通过**（脚本 `services/api/scripts/verify-family-http.cjs`），连跑两次均通过。覆盖：未加入时返回 null、创建/重复创建 409、邀请码不存在 404、小写+空格输入可加入、成员按角色排序、**吃货改家庭名/重置邀请码/自我升权一律 403（后端强制，不是只藏按钮）**、非法角色 400、转让后原掌勺人自动降为帮厨且全家庭只有一个掌勺人、**能力随角色实时生效（不用重新登录）**、重置后旧邀请码失效、移出成员、掌勺人有人时退出 409、只剩自己时退出即解散（级联清除成员关系）、找回密码全流程（见 R-013）。

> **限流窗口**：加入家庭是 10 次/分且按 IP 计数，脚本自带"等窗口重试"（与 R-010 同一套做法），所以连跑不会误报。

---

## R-013 找回密码（邮箱 + 一次性令牌）（✅ 已验证，2026-10-12）

```bash
# 1. 先在「我的 → 编辑资料」里绑定邮箱（或注册时填）
# 2. 申请重置
curl -s -X POST http://127.0.0.1:3000/api/auth/password/forgot \
  -H 'content-type: application/json' -d '{"email":"mama@example.com"}'
```

**两种发信模式**（`MAIL_TRANSPORT`，见 `RISKS.md` R-16）：

| 模式 | 行为 | 用途 |
| --- | --- | --- |
| `console`（默认） | 邮件内容写进 `docker compose logs api`，且响应里带 `devResetUrl` | **仅开发期**；本机联调不用配邮箱服务 |
| `smtp` | 用 `MAIL_SMTP_*` 真发信，响应**不含**链接 | 上线前必须切到这个（并实测收到信） |

```bash
docker compose logs api | grep "console 邮件"   # console 模式下看重置链接
```

**安全口径（已在验收里断言）**：① 邮箱没绑过账号也返回同样的 200（不泄漏"这个邮箱注册过没有"）；② 令牌**一次性**、1 小时有效、库里只存 sha256；③ 重设成功后**吊销该账号全部旧会话**（改密前的刷新令牌立即 401）；④ 申请接口限流 5 次/分。

---

## R-014 点单接口与验收（✅ 已验证，2026-10-12）

家庭点菜单（M3 / F3-01~F3-05，口径见 `DECISIONS.md` D-022）。**一张卡 = 一个「家庭 + 日期 + 餐次」**，家人各自往里点菜，状态是整餐的。

| 方法 | 路径 | 说明 | 需要的能力 |
| --- | --- | --- | --- |
| GET | `/orders/options` | 餐次、状态标签、可选日期（今天/明天）（**免登录**，前端不硬编码） | — |
| GET | `/orders?family=false&status=PENDING` | 点单列表；`family=false` 只看我参与的，`status=ALL` 或省略即全部；返回 `cards` 与**各状态计数** | 登录 |
| POST | `/orders/items` | 点菜：`{ recipeId, mealDate: 'YYYY-MM-DD', meal: 'LUNCH'\|'DINNER', note? }` | `order.create` |
| DELETE | `/orders/items/:id` | 撤回**自己**点的一份（仅「待确认」阶段；撤掉最后一份会删掉整张空卡） | 登录（且必须是本人） |
| POST | `/orders/meals/:mealKey/status` | 整餐流转，`mealKey` 形如 `2026-10-13-DINNER`，body `{ status }` | 见下表 |

**状态机**（`src/modules/orders/orders.rules.ts`）：`PENDING 待确认 → PLANNED 已安排 → COOKING 准备中 → DONE 已做好`，另有终态 `CANCELED 已取消`。**不跳级、不回退**；`DONE`/`CANCELED` 都不能再流转。

| 目标状态 | 需要的能力 | 前端表现 |
| --- | --- | --- |
| `PLANNED` | `menu.manage` | 「选好了」直接生效 |
| `COOKING` | `menu.manage` | 「开始做」直接生效 |
| `DONE` | `menu.confirm` | 「做好了」直接生效 |
| `CANCELED` | `menu.manage` | 「取消这餐」**弹二次确认**（砖红） |

**两个容易踩的点**：

- **已取消的餐还能重新点菜**：加菜时若这一餐是「已取消」，会把整餐**拉回「待确认」**（`canAddItem`/`revivedStatus`）。理由：一餐的「日期+餐次」在库里唯一，若取消后永久不能点，一家人取消晚餐后就再也点不了这一餐了。注意这是"点菜动作顺带复活"，**状态接口仍然禁止从终态回退**。
- **共享开关在这里第一次真正生效**：`shared=false` 时**吃货**只看到自己参与的餐次；掌勺人/帮厨仍看全量（他们要负责做饭）。「只看我的」视图不受开关影响。

```bash
pnpm --dir services/api run test:http:orders   # 50 项，真实请求
```

**实测结果**：**50/50 通过**（脚本 `services/api/scripts/verify-orders-http.cjs`），连跑两次均通过。覆盖：口径接口、未加入家庭 404、点菜建卡、同餐聚合、同菜合并份数、点菜人去重、备注随菜、全家/只看我的两个视角、状态筛选与计数、撤回（撤别人的 403、撤完空卡清理）、吃货推状态 403、跳级/回退/终态再流转 409、已安排后加菜 409、**取消后重新点菜并复活**、`needsConfirm` 标记、共享开关收窄可见范围、日期范围（后天 400）、非法餐次/状态 400、菜谱不存在 404、备注超长 400、畸形 mealKey 400。

> **限流窗口**：全局限流 60 次/分，而本脚本一轮 50+ 请求，**连跑第二遍会被自己的限流打成一片 429**。脚本对每个请求做了"遇 429 等窗口再重试"（本脚本没有"必须 429"的用例，所以重试不会掩盖断言）；`/family/join` 单独保留自己的限流处理。

---

## R-015 打卡照片接口与验收（✅ 已验证，2026-10-12）

打卡拍照与家庭打卡墙（M9 提前：F9-03/F9-07/F9-08，口径见 `DECISIONS.md` **D-023**）。

| 方法 | 路径 | 说明 | 门槛 |
| --- | --- | --- | --- |
| POST | `/checkins` | 上传：`{ image: 'data:image/jpeg;base64,…', note?, mealKey? }` | 登录 + 属于家庭；限流 12 次/分 |
| GET | `/checkins?family=false&limit=30` | 打卡墙；`family=false` 只看自己上传的 | 登录 + 属于家庭 |
| GET | `/checkins/stats` | 我的/全家的热力图（18 周、周一在前、5 档）+ 连续天数 + 可挂的「已做好」餐 | 登录 + 属于家庭 |
| GET | `/checkins/photos/:id?e=<epoch>&s=<签名>` | 读照片字节 | **三道门：登录令牌 + 签名 + 同家庭**，缺一不可 |

---

## R-016 今日安排与就餐人数（M4 / F4-01、F4-05）（✅ 已验证，2026-10-12）

| 方法 | 路径 | 说明 | 需要的能力 |
| --- | --- | --- | --- |
| GET | `/orders/today` | 今日安排：**永远给午/晚两行**（没点菜的那行 `state=none`、`statusLabel=还没人点`） | 登录 + 属于家庭 |
| POST | `/orders/meals/:mealKey/diners` | 设这一餐的就餐人数，body `{ dinerCount: 3 }`；传 `null`/空 = **清除设定** | `menu.manage` |

**今日安排的一行长这样**（前端不硬编码状态文案）：

```json
{ "meal": "DINNER", "label": "晚餐", "state": "open", "status": "PENDING", "statusLabel": "待确认",
  "dishes": ["番茄炒蛋 ×2"], "dishCount": 2, "ordererCount": 1, "dinerCount": 4,
  "mealKey": "2026-10-12-DINNER", "photoCount": 2 }
```

- `state` 三值：`none` 还没人点 / `open` 收集中·已安排·准备中 / `settled` 已做好·已取消（取消了不催人重做）。
- **`dinerCount` 与 `ordererCount` 是两回事**：前者含**没点菜只吃饭的家人**（老人、小孩、客人），由掌勺人手填；后者是"有几个人点了菜"。
- **不引入 0**：`null` 才表示"还没定"；`dinerCount: 0` 直接 **400**（0 个人吃饭没有意义，拿它当哨兵早晚被误读）。

```bash
pnpm --dir services/api run test:http:orders   # 62 项，真实请求（原 50 + M4 新增 12）
```

**实测结果**：**62/62 通过**。M4 新增的部分覆盖：两行永远都在、日期是今天、没点菜的行不编内容（`dishes=[]`、`dishCount=0`、`status=null`）、人数默认 `null` 不是 0、点过菜的行带上菜名与 `mealKey`、吃货设人数 403、掌勺人设人数 200 且回读到卡片与今日安排、0/小数/超上限 400、`null` 清除、给没点菜的餐设人数 404。

> **顺手修掉一条永远绿的假断言**：原本有一条 `GET /orders/meals/2027-01-01-DINNER` 期望 404——**这个路由压根不存在**，404 来自"路由未匹配"，那一餐就算真的存在也会通过。已改成走真正的流转接口（`POST /orders/meals/:id/status`），验的是服务层的「这一餐还没有人点菜」。**教训：断言 404 时要确认它来自业务分支，不是路由没匹配。**


**照片为什么不直接塞进 `<img src>`**：私有桶（`MEDIA_S3_PRIVATE_BUCKET`，默认 `cook-checkins`）不设公开读。签名只能证明"链接是我们发的"，不能证明"看的人是这家人"——只靠签名的话，链接被转发出去谁都能看别人家的照片。所以前端带 `Authorization` 取回字节再转 blob 显示（`<img>` 带不上请求头）。已实测：

| 场景 | 实测结果 |
| --- | --- |
| 匿名直接 GET 私有桶里的对象 | ✅ **403**（对照：公开桶 `cook-media` 匿名 GET **200**） |
| 匿名列私有桶 | ✅ **403** |
| 带令牌 + 带签名 | ✅ 200 |
| 只带签名、不带令牌 | ✅ **401** |
| 带令牌、但签名改一个字符 | ✅ **401** |
| 别家账号带同一张照片的有效签名 | ✅ **404**（话术「这张照片不存在」，不透露这张照片存在） |

**上传约束**：只收 JPEG / PNG / WebP（**按文件头魔术字节判断真实类型**，不信调用方声明的 content-type——否则任何字节都能伪称图片存进来）、单张 ≤ 8MB、备注 ≤ 60 字；前端上传前先等比缩到**最长边 1600px / JPEG 0.85**（手机上做，省流量也省存储）。对象按内容 sha256 命名，同一张图只存一份。**只能挂到「已做好」的餐上**。

```bash
pnpm --dir services/api run test:http:checkins   # 39 项，真实请求
```

**实测结果**：**39/39 通过**（脚本 `services/api/scripts/verify-checkins-http.cjs`），连跑两次均通过。覆盖：上传真图字节、同家庭互相可见、共享开关收窄吃货可见范围（掌勺人仍看全量）、热力图与连续天数、挂到「已做好」的餐、挂到非 DONE 的餐被拒、HTML 伪称 PNG 被拒、GIF 被拒、超大被拒、备注超长、非法 base64、`limit` 越界、畸形 `mealKey`、读照片的三道门（见上表）。限流自愈同 R-014。

**浏览器实测（真实点击 + 真实上传，2026-10-12）**：妈妈（OWNER）与爸爸（EATER）同家。爸爸先传 2 张 → 妈妈的打卡墙看得到、照片解码为真实尺寸（900×640 / 960×600）→ 妈妈上传 2400×1600 的图，浏览器内缩图实测 **1600×1067 / 43KB JPEG**（直接读回的 `naturalWidth`）→ 墙上前排出现「晚餐的成品」→「我的」页热力图当天格子亮起（`heatmap__cell--l1`）、连续打卡 1 天 → 换爸爸登录：全家 5 张、他自己 4 张、当天格子升到 `--l4`（档位随张数变化）→ 从「已做好」的点单卡点「📷 上传这餐的成品照」，抽屉**预选**那一餐（`2026-10-12-DINNER`）→ 提示「成品照已上传，家里人能看到啦」→ **再看墙，妈妈的照片也在**（跨账号可见）→ 传一个伪装成 PNG 的文本文件：提示「这个文件不是图片（只支持 JPEG / PNG / WebP）」且抽屉不关，可重试。

> **IAB 打不开系统文件选择框**（平台限制，与 Codex 一致）。实测用 `DataTransfer` 把真实 `File` 塞进 input 再派发 `change`——走的是"用户选中文件后"完全相同的代码路径，所以缩图/预览/提交都是真的；只有系统弹窗那一下没被覆盖，真机验收时要补。

## R-017 本周菜单与点菜窗口（M4 / F4-02）（✅ 已验证，2026-10-12）

| 方法 | 路径 | 说明 | 需要的能力 |
| --- | --- | --- | --- |
| GET | `/orders/plan` | 菜单安排：从今天起 N 天（默认 **3**，上限 **7**）每天午/晚两餐的进度 | 登录 + 属于家庭 |
| GET | `/orders/plan?days=7` | 备菜计划的 7 天窗口（`days` 越界或非整数 → 400） | 同上 |

**一天长这样**（与 `/orders/today` 的行**同一形状**，两点刻意保持一致）：

```json
{ "scope": "family",
  "days": [
    { "date": "2026-10-12", "label": "今天", "weekday": "周一",
      "meals": [ { "meal": "LUNCH", "label": "午餐", "state": "none", "status": null,
                   "statusLabel": "还没安排", "dishes": [], "dishCount": 0, "ordererCount": 0,
                   "dinerCount": null, "mealKey": "2026-10-12-LUNCH", "photoCount": 0 },
                 { "meal": "DINNER", "state": "open", "status": "PENDING", "statusLabel": "待确认",
                   "dishes": ["煎烹大虾"], "dishCount": 1, "dinerCount": null, "photoCount": 0 } ] } ] }
```

- **与今日安排共用一份组装逻辑**（`MealProgressRow` / `mealProgress`）：两处各算一份迟早会分叉（改了一处忘另一处）。文案不同：今日安排空行写「还没人点」，本周菜单写「还没安排」。
- **点菜窗口：今天/明天/后天**（`ORDER_DAY_SPAN = 3`）。**扩这一格是因为 F4-02 的「去安排」要能真的安排到后天**；不扩就是死路。越界提示语按窗口生成（`只能点今天/明天/后天的菜`），改了窗口提示语不会说错。再远的日子归 F4-03 备菜计划。
- **共享关闭时整格与"真没安排"完全一致**：菜名、`status`、`dinerCount`、`photoCount` 全部退回空/空值（**给 `status: 'PENDING'` 就等于承认"有人张罗了这一餐"**——第一版就是这么漏的）。响应带 `scope: 'mine'`，前端据此明说「家里关了共享」。
- **`days` 上限 7**：给 F4-03 备菜计划预留的窗口，现在就能用，但"每日加菜"的语义没做。

```bash
pnpm --dir services/api run test:http:orders   # 77 项，真实请求（62 + F4-02 新增 15）
```

**实测结果**：**77/77 通过**。F4-02 新增部分覆盖：默认 3 天 × 午晚两餐、今天/明天/后天的相对说法与 `weekday` 对得上、空行不编内容、点过的格子带菜名与 `mealKey`、**后天真的点得进去（201 + mealKey 对得上）**、`days=5` 放开且第 4 天起改用星期、`days=8`/`days=abc` → 400、未带 token → 401、共享关闭时吃货拿到空行（`status === null`、`dinerCount === null`、`photoCount === 0`）而掌勺人仍是全量、共享开回来后又看得到。

**浏览器实测（真实点击，2026-10-12）**：发现页点「后天·晚餐」的「去安排」→ 落到 `/recipes` 且 `history.state.usr.plan = {date: '2026-10-14', label: '后天晚餐', meal: 'DINNER'}` → 打开一道菜 → 详情页 state 仍在 → 点「想吃这道」→ 抽屉**预选好「后天」+「晚餐」**并提示「从「本周菜单」来的：默认放进后天晚餐，也可以改」→ 提交 → toast「已加入后天晚餐，等掌勺人安排」→ 回发现页，**后天晚餐那行显示「煎烹大虾 · 人数还没定 · 待确认」**（不再是「还没安排」）。

> **路由 state 要当外部输入读**：`plan` 是跨页传递的字符串，可能是昨天留下的链接（"后天"已过期）或手改的值。抽屉里**预设日期必须落在当下下发的 `dayOptions` 内**才生效，否则回落"下一餐"——不预选一个提交必被拒的日期。四个反证都验过会变红：去掉过期守卫、去掉空行占位、菜单卡漏传 `plan`、`readPlanTarget` 不做校验。

## R-018 AI 推荐与问答（M16 子集 / D-026）（✅ 已验证，2026-10-12）

**要验证什么**：AI 两条路（`suggest` 推荐 / `chat` 问答 + `chat/stream` 流式）在**没配 / 配了**两种状态下的行为，以及"不静默降级、不泄露密钥、模型编造的 id 会被丢掉"这几条底线。

### 前置：AI 配置（密钥只放 `.env`）

容器**不读** `services/api/.env`，Docker 跑时密钥写在**根目录 `.env`**（compose 从这里注入）：

```bash
# .env（不入库）——值由用户提供，不要写进文档、不要贴进对话
AI_API_BASE=https://opencode.ai/zen/go/v1
AI_API_KEY=oc_sk_...        # 用户自己的密钥
AI_MODEL=deepseek-v4.1-flash
AI_TIMEOUT_MS=              # 可选，默认 90000
AI_JSON_SCHEMA=             # 可选，默认开；上游不认 response_format 时填 0
```

本机直跑（`pnpm --dir services/api run start:dev`）则填 `services/api/.env`。改完 `docker compose up -d --build api` 重启。

### 三条验收命令

```bash
# ① 没配 AI 的路径：状态说没配、调用得 503 且话术给出去哪配（先在根 .env 里清空 AI_*）
pnpm --dir services/api run test:http:ai     # 8/8

# ② 配了 AI 的路径（真实网关，花钱、每次十几到几十秒；13 项）
pnpm --dir services/api run test:http:ai     # 13/13

# ③ 配了 AI 但**不花用户额度**：本地 stub 上游
node services/api/scripts/ai-stub-upstream.cjs 18990 &   # 另开一个终端
AI_API_BASE=http://host.docker.internal:18990/v1 AI_API_KEY=stub-key AI_MODEL=stub-model \
  docker compose up -d --build api
pnpm --dir services/api run test:http:ai     # 13/13
```

**stub 为什么必要**：AI 的功能验收不能依赖用户的真实密钥与额度，也不该把密钥写进脚本。stub 回**形状真实**的回包（推荐那段**带一条编造的 id** + 一条**从收到的候选清单里现取的真 id**），于是能验最关键的两件事——**服务端确实把候选清单发给了模型**、**模型编造的 id 被丢掉**。真 id 必须现取：写死一个假 id 的话，两条一起被丢掉也照样"通过"，等于没验（反证过：把候选清单的 id 抹掉，第二条断言会红）。
- `STUB_FORCE_STREAM=1`：强制回 SSE，验客户端"网关不听话也照样回 SSE"的降级。
- `STUB_ECHO_JSON_OBJECT=1`：模拟老 `json_object` 的故障（把参数当正文回）——那正是真网关的行为，见 D-026。

### 实测结果（2026-10-12）

- **未配置路径 8/8**：`/ai/status` 回 `{configured:false,model:null}` 且**不含密钥**；`suggest`/`chat` → 503 + 「AI 还没配置：Docker 跑填根目录 .env、本机直跑填 services/api/.env…」；未登录 → 401；输入错（hint 非文字 / >200 字 / 空消息）**先于配置判定**报 400。
- **真实网关 13/13**：推荐返回真实菜（每条都在库里）、编造 id 被丢、问答返回整段回答、**流式 200 + `text/event-stream` + 分 20～38 段到 + `[DONE]` 收尾**、输入闸门 400、流式的输入校验**在写头之前**（真 400，不是 200 的流里夹一段错）、未登录 401。
- **stub 13/13**（不花额度）：同上一套，另验"候选清单真的发给了模型"与"编造 id 被丢"。
- **浏览器实测（真实点击）**：发现页「AI 帮你想」→ 点「清淡点」→ 约 20 秒后出 4 道菜（`干贝花菇芹菜羹` / `凉拌海带丝` / `素炒蘑菇` / `黄瓜鸡蛋包子`，各带一句理由）→ 点第一道的「点这道」→ 抽屉关、**本周菜单的「明天午餐」出现「干贝花菇芹菜羹[原创首发] · 待确认」**（`18:00` 时"下一餐"= 明天午餐，与「想吃这道」同一份规则）。「问 AI」→ 流式逐字上屏、等待时显示 DotLoading + 阶段提示。

### 踩过的坑（都已在代码里修掉，供复查时对照）

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 推荐半数失败，回包正文 `{"type":"json_object"}` | 网关不支持老 `json_object`，模型把参数当正文回 | 改用 `json_schema` + `strict`；默认开、可关 |
| 网关 400 `This response_format type is unavailable now`（8 次里 5 次） | `json_schema` 的支持**按后端路由**，且错误体有两种形状 | 发过结构化参数的请求拿到 400 就**去掉它重试一次**（判据只看状态码） |
| `Unexpected token 'd', "data: {"id"...` | 没显式发 `stream: false`，上游回 SSE | 显式发 `stream: false`；另按 content-type 兜 SSE |
| 上游报错时界面是「服务器开小差了」(500) | 客户端与服务抛的是普通 `Error`，Nest 只映射 `HttpException` | `ask()` 里统一映射：超时 504、模型答非所问 502 |
| 模型回散文时仍是 500 | `parsePicks` 在 `ask()` **之外**调用，绕过了映射 | 解析器作为参数传进 `ask`（stub 复现后修） |
| 一次推荐要 11～40 秒，30 秒超时半数失败 | 推理模型先想再答 | 默认超时调到 **90 秒**；前端 AI 请求单给 **120 秒**（`apiClient` 默认 15 秒会在客户端先掐） |
| 500 的详情只有 `{"model":"deepseek-v4.1-flash"}` | 错误体形状多变，取错了字段 | `safeErrorText` 按 `error.message` → 顶层 `message` → 原文依次退 |

> **密钥纪律**：任何验证输出、日志、文档里都不得出现 key 值。`/ai/status` 只回 `configured` 与模型名（HTTP 断言里钉死了"不含 `sk-`、不含 `apiKey`/`baseUrl` 字段"）。日志只记模型名与状态码。

## R-019 页面右上角的角落插画（用户新增需求）（✅ 已验证，2026-10-12）

**要验证什么**：除首页（厨房）外的各页右上角原本是空的（用户 2026-10-12：「每个页的右上角都有点空」）。补上插画后要同时满足三件事——**不压住任何可点元素**、**不给自己造出空档**（用户随后说「间隙太大」「图片往上放点」）、**各页位置一致**。

### 图怎么来的（`image-generation` 技能）

```bash
python3 "$HOME/.agents/skills/image-generation/scripts/generate_image.py" \
  --prompt "<完整提示词>" --output generated-images/corner-<页>.png \
  --background transparent --timeout 300
```

- **密钥纪律照旧**：脚本从本机私有配置读 key，**不打印、不写入仓库、不进对话**（用户环境里图片网关 `api.ymeng.cc` 可达，与本项目 AI 网关的连通性互不影响）。
- **提示词要点**（7 张一套风格）：透明底、手绘水彩、暖棕描边、奶油白/焦糖橘/橄榄绿、纸纹、单主体、方形构图、**明确写 no sticker border / no glow / no halo / no coloured fringing**、不要文字与水印。
- **⚠️ 透明底会翻车**：第一次生成的碗那版带一圈红/黄彩边和白色贴纸感描边，直接贴上去很脏。**必须重新生成并在提示词里排除 halo**，不要事后抠图（抠不干净，边缘留灰）。生成后抽查边缘 alpha：
  ```bash
  magick <图>.png -crop 256x6+0+0 +repage -alpha extract -format "顶边alpha均值=%[fx:mean]\n" info:  # 期望 0
  ```
- **⚠️ 生成不稳**：本轮 7 张里有 2 张、后续 1 张报 `IncompleteRead` / `SSL: UNEXPECTED_EOF_WHILE_READING`（网络读一半断）。**脚本要带重试**，不要当成提示词问题去改提示词。
- **统一处理**（产出 384px 左右、`-colors 256`）：
  ```bash
  magick <原图>.png -trim +repage -resize 384x384 -background none -gravity center \
    -extent 384x384 -strip -colors 256 -define png:compression-level=9 \
    apps/mobile/public/img/corner/<页>.png
  ```
  `-colors 256` 把单张从 ~150KB 压到 ~40KB，130px 显示下肉眼无差（并排比过）。`-trim` 裁掉透明边再补成正方，7 张的"视觉大小"才接近。
- **中间产物进 `.gitignore`**：`generated-images/` 单张 1~3MB，只有压缩后的 `public/img/corner/*.png` 入库。

### 版面契约（这块改了三版，别再退回前两版）

- **锚点＝页面容器，不是页头**。`.corner-art` 是 `position: absolute`，挂的容器是 `.pscreen`（订单/发现/冰箱/我的/打卡/家庭）与 `.recipes-page`（菜谱小书），**两者都必须 `position: relative`**。
- **`.page-head` 上不能写 `position`**，也不能给自己 `min-height`。写了它就成为插画锚点，于是只剩两条错路：
  - ① 插画跟着页头往下排 → 探出页头压住下方按钮（家庭页「改家庭名」、订单页「只看我的」被压过）；
  - ② 给页头加 `min-height` 把插画兜住 → 没有副标题的页（家庭/我的）平白多出二十几像素，卡片被推下去（用户：「间隙太大」）。
- **七页统一 84×84**（旋转 4°，视觉外框约 90），贴容器顶边、`right: 4px`；页头 `padding-right: 98px` 只负责横向让位。**没有页面级例外**。
- **尺寸的硬上限来自页头下方最近的实内容**：`/order` 的分段控件顶边在 **y=87**（可点），插画下沿不能过它。要改大先量这个值，别无脑调。
- **⚠️ 看着"太大/太小"多数不是尺寸问题，是主体占画布的比例问题**。同一个 84px 框里，主体占画布 37% 的（家庭的小房子）和占 98% 的（相机特写）看起来差着将近一倍。所以换图之后**先量这一项**再决定动不动 CSS：
  ```bash
  magick <图>.png -alpha extract -threshold 50% -format "%@" info:   # 实心主体外框
  ```
  七张的目标区间是**实心主体占画布宽 37%~59%**（当前：家庭 37 / 发现 42 / 冰箱 45 / 我的 50 / 订单 52 / 打卡 56 / 菜谱 59）。新图不在这个区间就调 `-resize` 的尺寸再 `-extent` 补透明边，**不要**去改 `.corner-art` 的宽高。

### 验收命令（浏览器实测）

```js
// 每页都该拿到 []：既没压住可点元素，也没压住标题
[...document.querySelectorAll('button,a,input,select,textarea,[role="button"],[role="tab"]')]
  .filter(el => { const b = el.getBoundingClientRect(); const r = document.querySelector('.corner-art').getBoundingClientRect()
    return Math.min(r.right,b.right)-Math.max(r.left,b.left) > 0 && Math.min(r.bottom,b.bottom)-Math.max(r.top,b.top) > 0 })
```

### 实测结果（2026-10-12，390×844）

| 页面 | 插画外框（含旋转） | 压到按钮 | 压到标题 | 页头高度 |
| --- | --- | --- | --- | --- |
| /discover | [299,-3,90,90] | 无 | 无 | 55（标题+副标题） |
| /order | [299,-3,90,90] | 无 | 无 | 55 |
| /fridge | [299,-3,90,90] | 无 | 无 | 55 |
| /family | [299,-3,90,90] | 无 | 无 | 32（只有标题） |
| /mine | [299,-3,90,90] | 无 | 无 | 32 |
| /recipes | [299,-3,90,90] | 无 | 无 | （三行标题带，天然够高） |
| /checkins | [299,-3,90,90] | 无 | 无 | 55 |

七页页头高度与加插画之前**完全一致**（有副标题 55 / 无副标题 32），即没有为插画多留一像素；七页插画落在**同一坐标** `[299,-3,90,90]`。`/kitchen` 刻意不放（首屏已有 HeroBanner 大图，再放会撞）；`/recipes/:id` 顶部是整幅成品图，没有空位。

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 家庭/订单/打卡三页插画压住真按钮 | 插画 84px 比页头（无副标题只有 32px）还高，贴页头往下排就探到 y≈93 的分段控件上 | 锚点从页头改成页面容器 |
| 改完「间隙太大」「图片往上放点」 | 给页头加 `min-height: 70px` 兜住插画，没有副标题的页就多出 38px 空档 | 去掉 `min-height`；页头只留横向 `padding-right`，高度回自然值 |
| 中途把三页改成 `withAction`（插画左移） | **误判了碰撞方向**：碰撞是纵向的，左移既没解决纵向重叠，又把插画从"右上角"挪开 50px，等于制造新的空白 | 撤销 `withAction`；它只该留给"右上角确实有按钮"的页面 |
| 一度把所有页换成 3:2 横构图大插画（130×86） | **看错了用户的范围**——原话只说打卡墙那张小，其余页是满意的 | 全部退回（横构图那版留在 `generated-images/`，已忽略入库） |
| 给打卡墙单独放大到 116×116，用户回「太大了，和其他页对比一下」 | **把"图太小"直接归因成"框太小"**。真正的原因是那张相机图的构图松散（相机只占画布一小块），不是框不够大。换了顶满画框的特写后又矫枉过正（实心占 98%） | 删掉页面级例外，七页统一 84；改为**调图不调框**：重做后的相机再 `-resize 220 -extent 384`，把实心主体压到 56%，落进其他页的区间 |
| 第一版碗带白色贴纸描边 + 红黄彩边 | 生成时没有明确排除 halo | 提示词里写 no halo/fringing 后重生成；不靠事后抠图 |
| 菜谱小书的 `.recipes-heading .corner-art { top: 20px }` 覆盖失效 | 该覆盖是给旧锚点写的，换成容器锚点后会把插画拽回标题带 | 删掉该覆盖，位置统一由 `.corner-art` 决定 |
| 生成报 `IncompleteRead` / `SSL: UNEXPECTED_EOF_WHILE_READING` | 网络读到一半断（不是提示词问题） | 脚本带重试（本轮 3 张靠重试拿到） |

### 回归测试

`apps/mobile/src/components/ui/corner-art.test.tsx`（6 条）：

1. 每个用到的插画名都**真的有图**（写错一个字母在界面上只是破图标，只有肉眼能发现）；
2. `.corner-art` 必须 `pointer-events: none`（它绝不能吃掉点击）；
3. **版面契约**：`.page-head` / `.recipes-heading` 不得有 `position`、不得有 `min-height`，`.pscreen` 与 `.recipes-page` 必须是定位元素；
4. 渲染出来的 `alt` 为空、`aria-hidden`（纯装饰，不该被读屏念出来）；
5. `withAction` 只加一个类。

反证 4 组都验过会变红：插画名写错、删掉 `pointer-events`、给 `.page-head` 加回 `position`、去掉 `.pscreen` 的 `position`。

## R-020 AI 对话内点菜（工具循环）（用户第③项 / D-026 第三次补充）（✅ 已验证，2026-10-12）

**要验证什么**：模型在对话里能**自己去菜谱库搜真实的菜**、提一份"要不要加进菜单"的建议，而**库里在用户点确认之前一个字节都不变**。

### 三条命令

```bash
# ① 不花额度：本地 stub（它会演一遍完整的工具循环）
node services/api/scripts/ai-stub-upstream.cjs 18991 &
AI_API_BASE=http://host.docker.internal:18991/v1 AI_API_KEY=stub-key AI_MODEL=stub-model \
  docker compose up -d --build api
pnpm --dir services/api run test:http:ai     # 19/19

# ② 真实网关（花钱、每次调用十几秒）
docker compose up -d --build api             # 用根 .env 里的真实配置
pnpm --dir services/api run test:http:ai     # 19/19

# ③ 单测（规则层，不碰网络与数据库）
pnpm --dir services/api test                  # 104/104（其中 ai.tools 10 条）
pnpm --dir apps/mobile test                   # 194/194（其中对话点菜 5 条）
```

**stub 演的工具循环**（判据按**内容**分，不按工具结果条数——按条数分会在"模型并行发两个调用"时误判轮次，这个 bug 真出现过）：

| 轮 | 触发条件 | stub 回什么 |
| --- | --- | --- |
| 1 | 还没有 tool 结果 | 两个**并行** `search_dishes`（与真网关实测一致） |
| 2 | 有搜索结果、还没有 accepted | 一个 `propose_menu_items`，参数里**带一条编造的 id** + 一条从上一轮搜索结果里**现取**的真 id |
| 3 | 出现过 accepted | 一段收尾正文（含"要我把这两道加进…"） |

工具调用的**参数按 8 字符碎片发**：真上游就是这么切的，一次发完的话"参数碎片要按 index 拼起来"这段实现就没被验到。stub 另外会**校验协议形状**（`tool_calls` 必须是 `{id,type,function:{name,arguments}}`、`role=tool` 必须带 `tool_call_id`），形状不对就回 400——这条是补上来的：第一版服务端把内部对象直接塞回去了，真网关 400，而当时 stub 照单全收。

### 实测结果（2026-10-12）

**真实网关 19/19**（`deepseek-v4.1-flash`）：模型搜了 3 次库 → 读家里安排 → 提两道**真菜**（`蒜蓉粉丝蒸虾`、`三素汤羹`），末尾原话是「清淡的话，给你配一荤一汤吧……**要我把这两道加进今天晚餐吗？点确认就成。**」；工具轮次的状态事件依次为「正在翻菜谱…×3、正在看家里这几天的安排…、正在核对这几道菜…」；**加菜前与加菜后的 plan 完全一致**（提议没写库）；点确认后 `/orders/items` 201。

**stub 19/19**：同一套断言，另验"编造的 id 被丢掉、真 id 留下"这条（stub 是唯一能稳定造出这条的场景）。

**浏览器真人点一遍**：发现页 →「点这里问 AI →」→ 问「明天晚餐想加两道清淡的」→ 界面先显示「正在翻菜谱…」再显示「正在核对这几道菜…」→ 回答末尾问「要我把这两道加进明天晚餐吗？」→ 两张建议卡（各带「今天/明天晚餐」的人话与「加入菜单」按钮）→ 点「加入菜单」→ 提示「已把「蒜蓉粉丝蒸虾」加进晚餐」、该卡变「已加入」→ **数据库里 `2026-10-13 DINNER` 确实多了这道菜**（用 `/orders/plan` 之外直接查库核对的）。

> 验收期间往开发库的「明天晚餐」加了一道 `蒜蓉粉丝蒸虾`（点确认按钮加进去的，就是功能本身）。不想要的话在订单页删掉即可。

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 工具都跑了、状态事件也发了，但前端一个建议都收不到 | 循环里把"模型不再要工具"当正常收尾写了 `return`，**跳过了末尾的 proposals 事件** | 改成 `break` + `settled` 标记（返回前必须把建议发出去） |
| 真实网关第二轮 400，表现是"第一轮搜完菜就断了"；错误体只有 `{"model":"deepseek-v4.1-flash"}` | 回喂给上游的 `tool_calls` 是**内部形状** `{id,name,arguments}`，而上游要 `{id,type:'function',function:{name,arguments}}` | `toWire()` 按协议形状转换；并给 stub 补上形状校验，本地就能拦住这类问题 |
| stub 验收里 propose 那一轮永远走不到 | stub 按"工具结果**条数**"判轮次，而模型并行发两个调用时那一轮有两条 | 改按**内容**判（有没有 `accepted`），不按条数 |
| 模型把两道菜提给了「已做好」的今天晚餐，用户点下去只拿到「这餐已经做好了，换个餐次再点吧」 | 提示词没明说这件事（status 在上下文里，但没要求它据此选择） | 提示词加一条：标了「已做好/已取消」的那一餐不要再加菜，改提别的餐次；改完实测它会自动选「明天晚餐」 |
| 验证脚本报 `Cannot read properties of undefined (reading 'length')` | `readStream` 的**提前返回分支**没带新加的 `statuses`/`proposals` 字段 | 每个 return 都补齐字段（提前返回的路径最容易漏） |
| 等第一段字时对话区里多出一个圆圈（用户 2026-10-12 截图指出「这块多了一个圆圈」） | 为了"边写边长"，turns 里先塞了一格**内容为空**的 assistant 占位；渲染时它照样套 `.ai__turn`（有内边距 + 圆角），画出来就是个空框 | 渲染时**内容为空的 assistant 格不画**（等待态由下面"正在想…"那格负责）；补一条测试断言等待时 `.ai__turn--assistant` 只有 1 格（反证验过会红） |

### 回归测试

**后端 `tests/ai.tools.test.ts`（10 条）**：工具声明形状、编造 id 丢掉并点名、日期收敛（窗口内保留 / 越界与乱写收敛 / `2026-13-45` 不滚月）、餐次只认午晚、重复与上限、坏 JSON 不抛异常、`when` 的人话、搜索结果形状（含空结果给的是"换个词"）、日期键补零、轮数上限是个小数字。

**前端 `ai-sheets.test.tsx`（+5 条）**：工具状态上屏、点「加入菜单」才写库（且带上建议自己的日期与餐次）、「先不用」不写库、再问一句时上一轮建议收走、等第一段字时不留空气泡。

**反证 7 组全部验过会红**：后端 —— 不核对 id / 日期不收敛 / 不去重；前端 —— 不清上一轮建议 / 不显示工具状态 / 建议直接写库不等确认 / 空占位气泡照画（用户看到的那个圆圈）。
