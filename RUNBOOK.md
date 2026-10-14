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
  - **订正（2026-10-12，F4-03 起）**：窗口已由 3 天扩到 **7 天**（`ORDER_DAY_SPAN = 7`，与备菜页的 `PLAN_DAYS_MAX` 对齐，单测断言两者相等）。本节余下的「3 天」表述保留为当时的证据，**当前口径见 R-022**。
- **共享关闭时整格与"真没安排"完全一致**：菜名、`status`、`dinerCount`、`photoCount` 全部退回空/空值（**给 `status: 'PENDING'` 就等于承认"有人张罗了这一餐"**——第一版就是这么漏的）。响应带 `scope: 'mine'`，前端据此明说「家里关了共享」。
- **`days` 上限 7**：给 F4-03 备菜计划预留的窗口，现在就能用，但"每日加菜"的语义没做。（**订正**：F4-03 已交付，「加菜」语义见 R-022。）

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

---

## R-021 动效：抽屉滑进滑出 + 换页淡入上浮（D-027）（✅ 已验证，2026-10-12）

**触发**：用户 2026-10-12：「还有底部 ai 对话出来时要加个滑动出来，不要这种生硬的，整个系统都是不要生硬的」。

### 改了什么

| 位置 | 文件 | 说明 |
| --- | --- | --- |
| 所有底部抽屉（9 处调用） | `apps/mobile/src/components/ui/BottomSheet.tsx` | 自己管一层 `shown`：挂载后先渲染成"关着"、随即翻成"开着"，让 Popup 的 spring 有起始值（100% → 0）——入场就是从下往上滑 |
| 写入成功后自动收起的 5 个抽屉 | `DinerCountSheet` / `FreeDishSheet` / `OrderDishSheet` / `AiSuggestSheet` / `CheckInUploadSheet` | 改成 `sheet.current.close()`：先播退场，动画结束再回调 `onClose` |
| 换页 | `apps/mobile/src/layouts/TabLayout.tsx` + `TabLayout.scss` | 页面包一层 `key=pathname` 的容器，重播 `page-in`（0.24s 淡入 + 上浮 6px） |
| 对话区 | `apps/mobile/src/pages/discover/discover.scss` | 新气泡与建议卡走 `ai-in` 淡入上浮 |
| 底部 Tab | `apps/mobile/src/layouts/TabLayout.scss` | 选中横线改"缩放 + 淡入"；按下去整格缩到 0.94 |

### 怎么验

```bash
# 单测（含 5 条动效契约，其中 2 条做过反证）
pnpm --dir apps/mobile test                    # 199/199
pnpm --dir apps/mobile exec tsc -b          # ⚠️ 订正（2026-10-13）：前端 tsc 必须加 -b（tsconfig 是 references 型，不带 -b 什么都不编译、恒 exit=0），详见 RISKS.md R-25
pnpm --dir apps/mobile run lint                # 6 条警告（与改动前一致，无新增）

# 浏览器里量位移：点开抽屉后每 ~30ms 读一次 .adm-popup-body 的 inline transform
#   document.querySelector('.adm-popup-body').style.transform
#   document.querySelector('.adm-mask') 的 opacity
```

**实测（2026-10-12，390×844 视口）**：

| 动作 | 采样到的位移 / 透明度 |
| --- | --- |
| 打开 AI 抽屉 | `translateY` 73% → 49% → 32% → 21% → 13% → 8.4% → 0（遮罩 0.14 → 0.89 → 1） |
| 关闭（点遮罩） | 9% → 42% → 69% → 82% → 90% → 94% → 96.6%（遮罩 1.00 → 0.01），**滑完之后内容才卸载** |
| 换个 Tab | `page-in`：opacity 0.11 → 1、`translateY` 5.3px → 0（约 240ms） |
| 发一句话 | 新气泡 `ai-in`：opacity 0 → 0.93 |

中间那层换页容器没影响滚动：`.tab-layout__body` 的 `scrollHeight=1299 / clientHeight=644`，把 `scrollTop` 设成 400 之后确实是 400。

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 抽屉"啪"地出现，没有滑动（用户指的就是这个） | antd-mobile 的 `Popup` 只在 `visible` **由 false 变 true** 时才播动画；而本项目的用法是"打开时才挂载、`visible` 写死 true"——spring 的初值直接等于终点，等于没动画 | 自己管一层 `shown`：先渲染成关着，下一个渲染再打开 |
| 关闭时没有退场 | 调用方的 `onClose` 一执行就把抽屉卸载了（条件渲染的用法） | 关闭先走内部 `close()`（遮罩点击也走它），等 `afterClose`（弹簧停下那一刻）再回调 `onClose`；成功后自动收起的页面用 `ref` 拿 `close()` |
| 抽屉卡在屏幕上关不掉 | 退场回调挂在弹簧"跑完"那一刻，**弹簧没得跑就不会回调**——刚挂载、入场第一帧还没画就被关掉时，目标值等于当前值，无动画可播 | `close()` 加兜底计时器（`EXIT_FALLBACK_MS = 420`）；"调用方自己置 false"那条路用"内容还在就重挂 Popup" |
| 换页容器加上后短页面撑不满 | 页面根节点的 `min-height: 100%` 需要一个**高度确定**的父元素 | 容器写 `height: 100%`（不是 `auto`）；实测滚动与高度都正常 |
| 多了个 `onClose` 竞态：并行跑全量时偶发红 | 关闭现在是"过一会儿才回调"，测试里紧跟其后的断言变成了赛跑 | 相关断言包进 `waitFor`（`DinerCountSheet` 那条 2s、打卡那条 3s），并写明原因 |
| lint 冒出一条新告警 | `react(set-state-in-effect)` | 就地 `oxlint-disable-next-line` 并写明"这里要的就是两个渲染本身"（全站警告数没变） |

### 回归测试

**`apps/mobile/src/components/ui/bottom-sheet.test.tsx`（5 条，新增）**：挂载那一刻还在屏幕外（`translateY > 50`）、随后归位；关闭先退场（内容还在、`onClose` 未回调）→ 动画结束才回调；连点遮罩只回调一次；调用方置 `visible=false` 时不回调 `onClose`；`ref.close()` 走同一条退场路径。

**反证 2 组都验过会红**：

1. `useState(visible)`（旧的"一上来就已经开着"）→ `expected 0 to be greater than 50`（起始位移是 0 = 没有滑动）；
2. `close()` 里立刻回调 `onClose`（旧的"没有退场"）→ `expected "vi.fn()" to not be called at all, but actually been called 1 times`。

---

## R-022 备菜计划（F4-03）：7 天窗口与逐餐加菜（D-028）（✅ 已验证，2026-10-12）

**改了哪些地方**：点菜窗口 3 → 7 天（`orders.rules` 的 `ORDER_DAY_SPAN`，与 `PLAN_DAYS_MAX` 对齐）；`MealProgressRow` 加 `canAdd`（后端按 `canAddItem` 算）；新增备菜页 `/prep` 与发现页「备菜计划 →」入口；`OrderDishSheet` 的预选提示改成不写死入口名。

### 怎么验

```bash
# 单测（不需要 MySQL 与真模型）
pnpm --dir services/api test                    # 104/104
pnpm --dir apps/mobile test                     # 206/206
pnpm --dir apps/mobile exec tsc -b          # ⚠️ 订正（2026-10-13）：前端 tsc 必须加 -b（tsconfig 是 references 型，不带 -b 什么都不编译、恒 exit=0），详见 RISKS.md R-25

# 接口（真请求，需要 docker compose 的 api）
docker compose up -d --build api
pnpm --dir services/api run test:http:orders    # 91/91
pnpm --dir services/api run test:http:ai        # 19/19（stub，覆盖 AI 侧对日期的收敛）
```

### 实测结果（2026-10-12）

| 项 | 结果 |
| --- | --- |
| `GET /orders/options` | 7 天：今天/明天/后天/周四/周五/周六/周日（第 4 天起用星期） |
| 点第 7 天 | **201**（`2026-10-18-DINNER` 写进去了）；点第 8 天 400，提示「只能点从今天到周日这 7 天内的菜」 |
| `GET /orders/plan?days=7` | 7 天 × 午晚 = **14 行**，第 4～7 天都在 |
| 每行的 `canAdd` | 收集中/空着的 13 行 = `true`；已做好那 1 行 = `false`（终态） |
| 共享关闭时 | 吃货看到的是**收窄后的空行**（菜名/状态/人数/张数全空），但 `canAdd` 仍是 `true`——他不能看到别人点的菜，但仍然能加自己想吃的那道 |
| 浏览器（390×844） | 发现页卡头两个出口都在；`/prep` 7 张卡 14 行；点第 13 行（周日午餐）的「加菜」→ 菜谱小书 → 详情「想吃这道」→ 抽屉已默认选中**周日 + 午餐**、提示「已按你选的那一餐默认：周日午餐」→ 提交 → toast「已加入周日午餐」、抽屉正常退场（`.adm-popup-body` 与 `.adm-mask` 都清零、`body.overflow` 复原）→ 库里 `2026-10-18 LUNCH` 确实多了 `【桂圆银耳羹】` |

> 验收期间在开发库你那个验收家庭里加了 4 餐（今天晚餐、后天午餐、周五晚餐、周日午餐）。不想要的话在点菜页删掉即可。

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 接口验收里两条 `canAdd` 断言红 | 我**把断言的前提写死了**（假设"今天午餐一定是 DONE"），而那一格实际状态取决于本脚本前面的流转与库里已有数据 | 改成断言**关系**：`state === 'settled'` 的那些行必须 `canAdd === false`、其余必须 `true`。写死具体格子等于把"这条规则"绑到了某个数据快照上 |
| 验收脚本 `SyntaxError: Identifier 'lastDay' has already been declared` | 我在同一次编辑里新增的变量与前文重名 | 重命名（`seventhDay` / `prepSeventhDay`），`node --check` 过一遍再跑 |
| 预选提示说「从「本周菜单」来的」，但从备菜计划来也这么说 | 那句话是只有一个入口时写的 | 改成「已按你选的那一餐默认：X」，并补了一条测试（同时防"从另一个入口来觉得系统记错页面"） |
| 截图连续三次 `surface preparation timed out` | 标签页表面卡住（换页、改视口都不解），**不是页面本身的问题** | 新开一个标签页就能截（同一 URL）；旧标签页关闭 |

### 回归测试

**后端 `tests/orders.rules.test.ts`（改 3 条）**：7 天窗口的值与标签、第 7 天可点且第 8 天不可点、越界提示语跟着窗口生成（`这 7 天`）、`ORDER_DAY_SPAN === PLAN_DAYS_MAX`、凌晨时区用例的窗口改成 7 个日期。

**后端 `scripts/verify-orders-http.cjs`（+6 条）**：7 天口径、第 7 天 201 / 第 8 天 400 与提示语、`/orders/plan?days=7` 的 14 行、`canAdd` 三态关系、第 4～7 天的标签与日期。

**前端 `PrepPage.test.tsx`（新增 6 条）**：看的是 7 天（参数 + 7 张卡 + 14 行 + 第 4 天起也在）、每行「加菜」带对日期餐次（点开验路由 state）、终态行不给按钮且状态戳仍在、空行文案、汇总数字、没家庭时不请求接口。

**前端 `WeekPlan.test.tsx`（+1 条）**、**`OrderDishSheet.test.tsx`（改 2 条）**：卡头两个出口的 href、预选提示不再写死入口名。

**反证 2 组都验过会红**：

1. 后端 `canAdd` 一律写 `true` → `❌ 已做好/已取消的餐 canAdd=false`（90/91）；
2. 前端备菜页把 `meal.canAdd` 改成恒真 → `expected [ …(14) ] to have a length of 12 but got 14` 与 `expected [] to have a length of 2`；把 `days: 7` 改成 3 → `expected 3 to be 7`。

---

## R-023 常用组合（F4-04）：一键整组加进某一餐（D-029）（✅ 已验证，2026-10-12）

**数据模型**：`Combo`（家庭级，`@@unique([familyId, name])`）+ `ComboItem`（`@@unique([comboId, recipeId])`，菜谱删除时级联）。迁移 `20261012143341_combos`。

### 怎么验

```bash
# 单测
pnpm --dir services/api test                    # 111/111（组合规则 +7）
pnpm --dir apps/mobile test                     # 214/214（组合页 8 条）

# 接口（真请求）
docker compose up -d --build api
pnpm --dir services/api run test:http:combos    # 28/28

# 类型与 Lint
pnpm --dir services/api exec tsc --noEmit       # exit=0
pnpm --dir apps/mobile exec tsc -b          # ⚠️ 订正（2026-10-13）：前端 tsc 必须加 -b（tsconfig 是 references 型，不带 -b 什么都不编译、恒 exit=0），详见 RISKS.md R-25
pnpm --dir apps/mobile run lint                 # 6 条警告（与改动前一致）
```

### 实测结果（2026-10-12）

| 项 | 结果 |
| --- | --- |
| 建组 | 201；名字去首尾空格；组内重复自动去重（3 道发成 4 个 id → 2 道）；菜 id 编造 → 404「有 1 道菜不在菜谱库里」；重名 → 409；超 24 字 → 400；空列表 → 400 |
| 可见性与权限 | 组合家庭共用（吃货能看到妈妈组的，`canEdit=false`）；吃货删/改别人的 → 403 |
| 一键加入 | 这一餐已有的**跳过**（added=2 / skipped=1）；再点一次 added=0、skipped=3（**幂等**）；库里 dishCount=3（不是 6）；窗口外日期 400；缺日期餐次 400；不存在的组合 404 |
| 终态餐 | 整组加到「已做好」的那一餐 → 409，且那一餐**一道菜都没多**（先判定后写入） |
| 改与删 | PATCH 一次落地名字/说明/整组替换；删后列表里没有、再 `add` → 404 |
| 浏览器（390×844） | 点单卡「⭐ 存成常用组合」→ 预填「后天午餐」、改名「工作日的两菜」→ 存下 → `/combos` 卡片（菜名、谁组的、删除、加进某一餐）→ 一键加入（默认"明天午餐"，改成明天晚餐）→ 提示「已把 1 道加进明天晚餐」→ 库里 `2026-10-13 晚餐` 确实多了那道 → 再点一次提示「「工作日的两菜」这组菜在明天晚餐都有了」 |

> 验收期间开发库里多了 1 个组合「工作日的两菜」和 1 道菜（明天晚餐的「红烧排骨」）。不想要的话在组合页与点菜页删掉即可。

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 前端三个用例白天绿、固定时间跑红 | 默认落点是"下一餐"，**跟着时钟走**（下午 3 点前后不同）；用例没钉时间 | 涉及提交的用例统一 `pinMorning()`（10:00），并在注释里写明"这不是理论，是最先红的那几条" |
| 断言 toast 文字失败 | toast 由应用根部的 `<Toaster/>` 渲染，**组件测试树里没有它** | 改断言 `toast.success` 的**调用**（spy），而不是渲染出的文字 |
| `Found multiple elements with the text: 加进某一餐` | fixture 里两个组合各有一个同名按钮 | 用 `findAllByText(...)[0]` 并注明"每组一个" |
| 反证第一次没变红 | 我的 `python replace` 没匹配上（缩进不同），改动其实没落进文件 | 改完先 `grep 反证` 确认落盘，再跑测试——"反证没红"先怀疑反证本身 |
| 组名/菜列表的 `道数: undefined as never` 混进返回体 | 写服务时手滑留下的一行（TS 也不报，因为 `as never`） | 删掉；**教训**：`as never` 这类"让编译器闭嘴"的写法要当场清掉，不然它会把真问题一起盖住 |

### 回归测试

**后端 `tests/combos.rules.test.ts`（新增 7 条）**：名字去空格/空值/上限；说明可空与归一；菜 id 去重保序；至少一道、最多 12 道、类型非法拒；一键加入跳过已有的（含幂等）；空餐整组都加；改/删权限三分支。

**后端 `scripts/verify-combos-http.cjs`（新增 28 条）**：上表全部。

**前端 `CombosPage.test.tsx`（新增 8 条）**：列表与 `canEdit`；一键加入带对日期餐次（点开验请求体）；跳过要说出来（两句提示）；整组都在时说实话（只一句）；后端拒绝时显示话术且抽屉不关；删除先确认；空状态指路；没家庭不请求接口。

**反证 2 组都验过会红**：

1. 后端 `planAdd` 无视已有的、全都要加 → 单测 `not ok 51 一键加入跳过已经有的菜`；接口验收 4 条红，实测**库里 dishCount=7**（`【桂圆银耳羹】 ×3`…）——正是"点一次得到双份"的样子；
2. 前端把用户选的餐次写死成 `DINNER` → `expected { mealDate: '2026-10-13', …(1) } to deeply equal …`。

---

## R-024 确认菜单（F4-05）：先看汇总再定，定完留"谁定的"（D-030）（✅ 已验证，2026-10-12）

**改了哪些地方**：`MealOrder` 加 `confirmedById` / `confirmedAt`（迁移 `20261012151637_meal_confirm`，`User` 侧 `SET NULL`）；`orders.rules` 新增 `confirmStampFor`；`orders.service` 在流转与"取消后复活"两处按它写/清留痕，卡片下发 `confirmedBy` / `confirmedAt`；点单页「选好了」不再直接写库，改为开 `ConfirmMenuSheet`（整桌菜 + 份数 + 随菜备注 + 人数入口 + 锁单说明），按「就这些，定了」才真的定；卡片显示「🔒 妈妈 10 / 12 15:20 定下这餐」。

### 怎么验

```bash
# 单测（不需要 MySQL 与真模型）
pnpm --dir services/api test                    # 113/113（留痕规则 +2）
pnpm --dir apps/mobile test                     # 219/219（汇总视图与留痕 +6）

# 类型与 Lint
pnpm --dir services/api exec tsc --noEmit       # exit=0
pnpm --dir apps/mobile exec tsc -b          # ⚠️ 订正（2026-10-13）：前端 tsc 必须加 -b（tsconfig 是 references 型，不带 -b 什么都不编译、恒 exit=0），详见 RISKS.md R-25
pnpm --dir apps/mobile run lint                 # 6 条警告（与改动前一致）

# 接口（真请求，需要 docker compose 的 api）
docker compose up -d --build api
pnpm --dir services/api run test:http:orders    # 97/97（留痕 +6）
pnpm --dir services/api run test:http:combos    # 28/28（回归）
pnpm --dir services/api run test:http:checkins  # 44/44（回归）
```

### 实测结果（2026-10-12）

| 项 | 结果 |
| --- | --- |
| 定菜单记留痕 | `POST .../status {PLANNED}` → `confirmedBy={nickname:"妈妈",avatar:"🐰"}`、`confirmedAt` 是当下的 ISO 时间 |
| 开始做/做好了不动它 | `COOKING` / `DONE` 两次流转后 `confirmedAt` 与定菜单那一刻**逐字节相同**（做的还是那一版菜单） |
| 取消清留痕 | `CANCELED` → `confirmedBy=null`、`confirmedAt=null`（这一版作废了） |
| 取消后复活 | 重新加菜 → 整餐回 `PENDING`，留痕**仍是空的**（与取消各清一次，两条路都堵上） |
| 锁单仍然生效 | 已安排的餐再加菜 409「这餐已经「已安排」了，想加菜先取消这餐」 |
| 浏览器（390×844） | 卡片点「选好了」→ 抽屉滑上来（**没有请求发出**）→ 看到「共 1 道 / 【桂圆银耳羹】/ 动效验收 点的 · 1 人点了 / 还没定几个人吃 去定」+ 锁单说明 → 点「去定人数」→ 确认抽屉收起、人数抽屉接着开（屏幕上**同时只有一层** `sheet__body`）→ 加 1 人保存（toast「这餐按 2 人算」）→ 回到卡片看到「2 人吃（1 人点了） · 改」→ 再点「选好了」→ 汇总里显示「2 人吃 改」→「就这些，定了」→ toast「这一餐定了」、卡片变「已安排」并出现「🔒 动效验收 10 / 12 23:44 定下这餐」、动作变成「开始做 / 取消这餐」→ 取消这一餐后**留痕整行消失**、抽屉与遮罩都已卸载、`body.overflow` 复原 |

> 验收期间开发库里改动：2026-10-18 午餐被取消、2026-10-16 晚餐被定下并设为 2 人吃。不想要的话在点菜页取消/撤掉即可。

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| `Found multiple elements with the text: 妈妈：少放盐` | 备注在**卡片上**和**汇总抽屉里**各有一份（这是对的，抽屉就是让人在定之前重看一遍） | 断言限定在抽屉里取：`within(document.querySelector('.sheet__body'))` |
| 老用例「点「选好了」直接请求」红了 | 它断言的是**改动前的行为**（直接写库），不是 bug | 改写成新契约的用例，并**显式断言"只点「选好了」时一个请求都没有"**——把"不许提前写库"钉住 |
| AI 接口验收 17/19（问 AI 500、建议卡空） | **与本轮改动无关**（未碰 `modules/ai/**`），是上游偶发要求回传 `reasoning_content`；**同一条命令紧接着再跑一次 19/19 全绿** | 单独记进 `RISKS.md` **R-23**（含两次跑的对照表）；不当成本次回归失败，但也不当噪音放过 |
| `python replace` 反证又没落盘 | 老问题：脚本里的缩进/引号没对上，替换静默失败 | 两次反证都先在写完后 `grep 反证` 确认落盘，再跑测试 |
| 反证 2 只红了 1 条接口断言 | 取消与"取消后复活"**是两条清留痕的路**：把取消那条改坏，复活那条仍会把留痕清掉 | 这正是两条路都存在的好处；单测（`confirmStampFor`）与接口断言各钉一条，反证时一起变红 |

### 回归测试

**后端 `tests/orders.rules.test.ts`（新增 2 条）**：`confirmStampFor` 的四态（定菜单 `stamp` / 开始做与做好了 `keep` / 取消 `clear`）；复活路径与 PENDING 不经过状态接口的分工。

**后端 `scripts/verify-orders-http.cjs`（新增 6 条）**：定菜单记下谁与何时；`COOKING` 后 `confirmedAt` 不变；`DONE` 后留痕仍在；另一餐定下也留痕；取消后两人份清空；复活后仍为空。

**前端 `pages/order/order.test.tsx`（改 1 条 + 新增 5 条）**：只点「选好了」不发请求、抽屉内容与锁单说明、按「就这些，定了」才发 `PLANNED`；人数行显示与「去定人数」交接（确认抽屉收起后人数抽屉接着开）；`COOKING` 不走汇总视图直接生效；卡片显示留痕且**是 `<p>` 不是按钮**；收集中的那餐不显示留痕；开汇总抽屉时不弹确认对话框。

**反证 3 组都验过会红**：

1. `confirmStampFor` 里把 `PLANNED → stamp` 改成 `keep` → 单测 `not ok 99`，接口 93/97（4 条留痕断言红，`confirmedBy=null`）；
2. 把 `CANCELED → clear` 改成 `keep` → 单测 `not ok 99`，接口 96/97（「取消会清掉留痕」红、`confirmedBy={"nickname":"妈妈",…}` 还在）；
3. 前端 `onAction` 里跳过汇总视图（`if (false && action.status === 'PLANNED')`）→ 3 条前端用例红（「先开汇总视图，不直接写库」「汇总视图里…去定」「不弹确认对话框」）。

---

## R-025 快问与示例问题由 AI 现生成（D-032）（✅ 已验证，2026-10-12）

**改了哪些地方**：后端新增 `POST /api/ai/prompts` + `promptsContext`（家庭画像）+ `ai.rules` 的 `parsePrompts`（含 `extractJsonObject`）；前端 `api/ai` 加 `useAiPrompts`，`ai-prompts.ts` 的两个池子**降级为兜底**（`pickHints(from?)` / `pickExamples(from?)` 多了一个"从 AI 那批里抽"的参数），两个抽屉接上并在 AI 那批到手后重抽一次；stub 上游加了提示词那一支（故意回脏数据）。

### 怎么验

```bash
# 单测
pnpm --dir services/api test                    # 120/120（提示词规则 +7）
pnpm --dir apps/mobile test                     # 227/227（提示词兜底/替换 +8）
pnpm --dir services/api exec tsc --noEmit       # exit=0
pnpm --dir apps/mobile exec tsc -b          # ⚠️ 订正（2026-10-13）：前端 tsc 必须加 -b（tsconfig 是 references 型，不带 -b 什么都不编译、恒 exit=0），详见 RISKS.md R-25
pnpm --dir apps/mobile run lint                 # 6 条警告（与改动前一致）

# 接口：stub（不花额度）
node services/api/scripts/ai-stub-upstream.cjs 18993 &
AI_API_BASE=http://host.docker.internal:18993/v1 AI_API_KEY=stub-key AI_MODEL=stub-model \
  docker compose up -d --build api
pnpm --dir services/api run test:http:ai        # 23/23

# 接口：真网关（花额度，看真实生成质量）
docker compose up -d --build api               # 回到根 .env 的配置
```

### 实测结果（2026-10-12）

| 项 | 结果 |
| --- | --- |
| 未登录 → 401 | `POST /ai/prompts` 无 token 401（与另两个 AI 入口一致） |
| 没配 AI → 503 | 话术与 `/ai/suggest`、`/ai/chat` 同一套（前端据此静默回退） |
| stub（脏数据清洗） | 回包带重复项、超长项、非字符串（`42`、`null`）→ 服务端清洗后 `hints` 5 条 / `examples` 3 条，全部是干净的短句 |
| 真网关（内容质量） | 17.3s 返回 200：`hints` 18 条 / `examples` 12 条，**明显贴着这个家**——「冰箱有半颗白菜」「秋燥想吃润点」「下班累不想炒菜」「一人份别做太多」，示例问题也集中在同一批食材（白菜/挂面/南瓜/鸡蛋羹） |
| 浏览器（390×844） | 打开「AI 帮你想」**先看到兜底那批**（立即可用）→ 约 13s 后**自动换成 AI 那批**（「想喝银耳那种羹」「想囤点放冰箱的」「买了蟹不会做」「想吃排骨，但怕腻」「板栗买多了」——都是这家的实际历史）→ 点「换一批」**0.6s 内**换出另一组（含「最近有点上火」「想下饭，别太油」），**没有新的上游请求** |
| 浏览器（问 AI 那侧） | 关掉再开「问 AI」，示例问题直接就是 AI 那批（「山药削完皮手痒怎么办」「板栗怎么剥不粘皮」「蟹蒸几分钟肉不柴」）——两个抽屉共用一次生成（`staleTime` 半小时） |

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 接口验收在**真网关**下 21/23 假红 | 我把断言写死了「必须包含『清淡点』」——那只对 stub 成立；真网关写的是「一个人吃，简单点」「下班累，想快手」（**更好**，只是与 stub 不同） | 改成断言**关系**：结果干净（无重复、都是长度内的非空字符串）+ 够一屏 + 两批不重叠。同一条脚本要对 stub 与真网关都成立，就不能写死具体句子 |
| 「两批各归自己的字段」也是假红 | 同上：我按 stub 的措辞写判据（示例必须含"怎么/多久"），真网关给的「虾蒸几分钟才不老」不含"怎么" | 换成"两批不重叠"这个**与具体措辞无关**的判据 |
| 「换一批」用例先报 `expected 0 got 1` | 我的基线取早了：抽屉一打开就会拉一次 `/ai/prompts`，请求在"取基线之后、断言之前"才落地 | 先 `waitFor` 等 AI 那批真的上屏，再取基线与请求数——这类"并发到达"的断言必须先把起点钉稳 |
| 打开抽屉 25s 没换批，一度以为替换逻辑坏了 | 真网关这次要 17～40s（R-023 那个数量级）；我等的比它短 | 改成**轮询等待**而不是定长 sleep，并记下真实耗时（13s）；顺带确认"兜底先显示、AI 后替换"这条设计正好覆盖了这段等待 |
| 后端单测两条红了，报"AI 给的提示词不够用" | 我的测试数据里干净的句子不够一屏，先被 `PROMPTS_*_MIN` 那条拦下，压根没走到清洗 | 把干净项补够——**这条红线本身是对的**（它正是在防"半批混着写死的那份出"） |

### 回归测试

**后端 `tests/ai.rules.test.ts`（新增 7 条）**：正常解析与按上限收敛；脏数据（非字符串/空串/超长/换行/重复）清洗；空白压成单空格；不够一屏判失败（含边界刚好够要放行）；不是 JSON / 字段名不对判失败；```json 包裹与前后带话能认；超长整条丢掉而不是截断。

**后端 `scripts/verify-ai-http.cjs`（新增 3 条 + 未登录/未配各 1 条）**：未登录 401；未配 503 同一套话术；结果干净且够一屏；两批不重叠。

**前端 `ai-prompts.test.ts`（新增 4 条）**：给了 AI 那批就从它里面抽（兜底池的句子一个都不该出现）；不够一屏退回兜底；示例问题同理；`undefined`/空数组时与以前完全一样。

**前端 `ai-sheets.test.tsx`（新增 4 条 + 改 1 条）**：AI 给的快问会被用上（兜底池的句子不该再出现）；生成失败静默回退（不给错误提示、5 条都在）；没配 AI 时不请求生成；「问 AI」的示例也走 AI 那批（共用一次生成）；「换一批」改写成"换掉那一组 **且请求数不变**"。

**反证 2 组都验过会红**：

1. `parsePrompts` 跳过清洗（原样收下模型的数组）→ 后端单测 3 条红（脏数据用例、空白压缩、超长整条丢掉），接口 **22/23**（`hints` 里出现 `42` 与那条超长句子）；
2. 前端 `pickHints` 忽略传入的 AI 那批、只用兜底池 → 前端 3 条红（「给了 AI 那批就从它里面抽」「AI 给的快问会被用上」「换一批真的换掉那一组」）。

## R-026 推荐的三个毛病：池子固定、重问不清、一次只给两道（D-033）（✅ 已验证，2026-10-13）

**改了哪些地方**：后端 `ai.rules.ts` 新增 `extractKeywords`（中文二元切词）与 `sampleList`（洗牌抽样），`ai.service.ts` 的 `candidates()` 改成"关键词命中优先 + 随机补齐 + 采样顺序即清单顺序"，系统提示词加上数量与换菜要求；前端 `AiSuggestSheet.tsx` 在提问时清空上一批、点过的菜置灰，`discover.scss` 加 `.ai__pick.is-done`；验收脚本加两条关系型断言；stub 无需改（它一直取"清单里的第一道"，池子打乱后它自己就变了）。

### 怎么验

```bash
# 单测
pnpm --dir services/api test                    # 126/126（关键词/抽样 +6）
pnpm --dir apps/mobile test                     # 229/229（清空/置灰 +2）
pnpm --dir services/api exec tsc --noEmit       # exit=0
pnpm --dir apps/mobile exec tsc -b          # ⚠️ 订正（2026-10-13）：前端 tsc 必须加 -b（tsconfig 是 references 型，不带 -b 什么都不编译、恒 exit=0），详见 RISKS.md R-25
pnpm --dir apps/mobile run lint                 # 6 条警告（与改动前一致）

# 接口：stub（不花额度）
node services/api/scripts/ai-stub-upstream.cjs 18993 &
AI_API_BASE=http://host.docker.internal:18993/v1 AI_API_KEY=stub-key AI_MODEL=stub-model \
  docker compose up -d --build api
pnpm --dir services/api run test:http:ai        # 25/25

# 接口：真网关（花额度）
docker compose up -d --build api               # 回到根 .env 的配置
pnpm --dir services/api run test:http:ai        # 25/25
```

### 实测结果（2026-10-13）

| 项 | 结果 |
| --- | --- |
| 候选池不再是固定一小批 | 真网关同一问题连问三轮，共返回 **14 种**不同菜品（改动前是"每次都鱼香肉丝和蘑菇"）；两句话（「剩饭怎么处理」/「想吃点辣的」）拿到两批**完全不同**的候选 |
| 数量 | 三次实测都落在 **5 道**（目标 4～6），改动前是 2 道 |
| 重问先清旧结果 | 浏览器实测：点「想几道」后 250ms 内旧那一批 `pickNames: []`（0 行）、骨架屏 6 行、等待语「快好了，看看合不合口…」；**5s 后**新一批 5 道上屏，与上一批**零重叠**，内容贴着新提示（「孩子不吃辣，想清淡点」→ 清蒸虾 / 金针菇烧豆腐 / 三素汤羹 / 菠菜鸡蛋水饺） |
| 点过的那道置灰 | 点第一道的「点这道」→ 该行变 `is-done`、显示「已加入」、计算样式 `opacity: 0.55`（其余行 `opacity: 1`），「点这道」按钮从 5 个减到 4 个，**抽屉不关** |
| 骨架形状 | 6 行（= `SUGGEST_PICKS_MAX`），不是原来的 2 行——结果回来时页面高度不跳 |
| 单测 | 后端 126/126、前端 229/229、后端 `tsc --noEmit` exit=0、lint 6 条（不变）；**前端的 tsc 当时记错了**——`--noEmit` 对 references 型 tsconfig 是空操作，真实检查 `tsc -b` 有 7 条既有错（与本次无关），见 RISKS R-25 |
| 接口 | stub 25/25、真网关 25/25（各含新增的 2 条关系型断言） |

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 首次跑出 **22/25**、再跑 **20/25**，五条红全是 502 | **不是本次改动**：容器日志里是 `上游连接失败（model=deepseek-v4.1-flash）：fetch failed`（连接层），与 R-23 的 `reasoning_content` 400 是两回事；传输层失败当前**不重试** | 第三次重跑 **25/25**。已单列 `RISKS.md` **R-24**，并把"看日志区分 `fetch failed` 与 400"写进判定方法——**同代码时红时绿不能当修好了** |
| 我自己的浏览器脚本报「期望 4 个『点这道』，实际 5」 | 我按"5 道里已经点过一道"写的断言，但那一批是新问答刚回来的，**还没点过任何一道** | 断言改成 5（并说明为什么是 5）；再点第一道 → 验证后剩 4。**断言写的是我以为的状态，不是页面当时的状态** |
| 第一次反证没变红（把二元切分整段删掉） | 我的 python 补丁**匹配串没对上**（文件里那行带尾注注释），`assert` 直接失败、**没写进文件**，于是"反证"其实什么都没改，测试自然全绿 | 先 `grep -n` 读出真实代码再构造补丁；补丁后**必须看到 `not ok`**才算反证成立（这一条已经栽过第二次，见 R-025） |

### 回归测试

**后端 `tests/ai.rules.test.ts`（新增 6 条）**：中文无词边界时整段搜不到要切二元组（「剩饭怎么处理」→ 含「剩饭」）；标点分开的短句照旧整词保留（原路不能改坏）；三字以内不切二元组（切了只有碎片）；去重、有序、数量有上限；抽样真的打乱顺序（`random=0` 保持原序、`random=1` 每次取剩余里最后一个）；抽样数量边界安全（要得比给得多就全给、0 与负数给空、永不含 `undefined`）。

**后端 `scripts/verify-ai-http.cjs`（新增 2 条，均为关系型）**：「两句话问到的是两批候选」（两句**完全不同**的诉求→候选 id 列表不应相同）；「同一句话反复问，推荐不该总是同一道」（三轮的并集要 ≥2 种）。**不写死具体菜名**——写死就把规则绑到数据快照上了（R-025 的教训）。

**前端 `ai-sheets.test.tsx`（新增 2 条）**：再问一次先把上一次的推荐清掉（第二次请求**挂着不返回**，断言旧菜在等待期间就消失——让第二次响应到达再断言的话，替换会把问题盖住，见下）；点过的那道置灰并显示「已加入」、不能再点第二次。

**反证 3 组都验过会红**：

1. `extractKeywords` 去掉二元切分 → 后端 `not ok 19`「中文没有词边界…切出「剩饭」」1 条红（125/126）；
2. `sampleList` 不洗牌、只按原序截前 N 个 → 后端 `not ok 23`「抽样：会真的打乱顺序」1 条红（125/126）；
3. 前端 `ask()` 拿掉 `setPicks(null)` → 前端 1 条红「再问一次时先把上一次的推荐清掉」（228/229）。

三处均已恢复，恢复后后端 126/126、前端 229/229、工作树只留本轮改动。

## R-027 再点一次（F3-06）：照过去的一餐整桌再来（D-034）（✅ 已验证，2026-10-13）

**改了哪些地方**：后端 `orders.rules.ts` 新增 `dishKey` / `canRepeatFrom` / `planRepeat`（`aggregateItems` 的合并键改为复用 `dishKey`），`orders.service.ts` 新增 `repeat()` + `repeatDishOf()`，卡片视图新增 `canRepeat`；控制器新增 `POST /orders/meals/:mealKey/repeat`；前端 `api/orders.ts` 新增 `repeatMeal` / `useRepeatMeal` 与 `canRepeat` 字段，新增 `pages/order/components/RepeatMealSheet.tsx`，`OrderPage` 加卡片入口，`order.scss` 加样式；验收脚本 `verify-orders-http.cjs` 新增 14 条。

### 怎么验

```bash
# 单测
pnpm --dir services/api test                    # 132/132（再点一次规则 +6）
pnpm --dir apps/mobile test                     # 234/234（入口与抽屉 +5）
pnpm --dir services/api exec tsc --noEmit       # exit=0（后端这条是真检查）
pnpm --dir apps/mobile exec tsc -b              # ⚠️ 必须带 -b！见下方"坑"第 3 条与 RISKS R-25
pnpm --dir apps/mobile run lint                 # 6 条警告（与改动前一致）

# 接口（服务已在跑即可，不需要 AI 上游）
docker compose up -d --build api
pnpm --dir services/api run test:http:orders    # 114/114（新增 14 条）
```

### 实测结果（2026-10-13）

| 项 | 结果 |
| --- | --- |
| 入口出现的位置 | 浏览器实测 5 张卡：`已取消` 的 10-18 午餐、**日子已过去的 10-12 晚餐**（状态还挂在待确认）**有**「🔁 再点一次」；`已安排` 的 10-16、`待确认` 的 10-14/10-13（今天/明天）**没有** |
| 接口：来源判定 | 待确认 → `canRepeat=false`，拿它当来源 → **409**「这一餐还在「待确认」，等它定局（做好或取消）之后再照它点」；推到 DONE 后 → `canRepeat=true` |
| 接口：整桌照抄 | 来源（晚餐，A 带备注 + B 点两份）→ 照到后天午餐：`added` 2 道、`dishCount=2`；**B 是 1 份不是 2 份**；**备注全空**；`mineCount=2`（照抄的是我点的）+ `ordererCount=1` |
| 接口：幂等 | 同一来源再照一次同一餐：`added=0`、`skipped=2`、`dishCount` 仍是 2、`message="这一餐里这桌菜都有了"` |
| 接口：部分已有 | 目标已有一道 → `added=1`、`skipped=1`、`dishCount=2`（不凑成两份） |
| 接口：边界 | 来源不存在 → 404；不传目标餐 → 400「要说清照到哪一天哪一餐」；目标超 7 天窗口 → 400（与手点同一套话术）；来源标识非法 → 400；未登录 → 401；目标已做好 → 409 且**一道都没进去**（`dishCount` 仍是 1） |
| 浏览器（390×844） | 10-12 晚餐卡点「再点一次」→ 抽屉显示「2026-10-12 · 晚餐 共 1 道」+ 菜名「【桂圆银耳羹】」+「备注不跟着走」说明 + 日期（今天/明天/后天/周五…）/餐次选择 → 点「照这桌点进今天晚餐」→ toast「照 2026-10-12 晚餐点了 1 道进今天晚餐」→ **今天晚餐从 3 道变 4 道**，多出的正是那道菜；再照一次 → toast「这一餐里这桌菜都有了」，**仍是 4 道**（幂等） |
| 单测/接口 | 后端 132/132、前端 234/234、接口 114/114、后端 `tsc --noEmit` exit=0、lint 6 条（不变） |

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| **验收脚本一开始想用"昨天"当来源，写不下去** | 接口**不让人补点过去的日子**（已有用例「点昨天 → 400」），所以**没法用 API 造出一张"日期在过去"的卡** | 来源改用「已做好」（终态）那条路径；"日子已经过去"那条由**单测**钉（`canRepeatFrom` 的纯函数）。**同一个口径的两条路径，能验到哪条就用哪条，另一条明确标注由哪一层覆盖** |
| 首跑前端两条用例报 `post` 一次都没调 | ① 抽屉里的提交键在 `/orders/options` 回来前是 disabled 的，我点早了；② 我断言了"默认下一餐 = 明天晚餐"，而那是**按当前钟点算**的（15 点前是今晚） | ① 先 `findByRole` 等按钮可用；② **显式点「明天」「晚餐」再提交**——断言依赖钟点的默认值，下午必然变红。默认值那条规则由 `next-meal` 自己保证，不在这里重复验 |
| `planRepeat` 一条用例红了：重复项被算进 `skipped` | 我的实现用**一个** `have` 集合同时管"目标已有"和"这次已收"，于是来源里的重复项（两个人各点一份）被报成"那一餐本来就有" | 拆成 `inTarget`（要报给用户的）+ `taken`（这次算过的）：重复项**静默收一份**，不谎报"本来就有"。**不是测试写错了，是逻辑错了**——用户会照着 toast 以为那道菜本来就在那一餐 |
| **反证时我用 `git checkout <file>` 还原，把整份未提交的改动清掉了** | 那个文件（`orders.rules.ts`）的改动**还没提交**，`git checkout` 是从 HEAD 恢复，不是"撤销刚才的反证" | 用备份副本还原（`cp` 到 `/tmp` 再拷回）；`git checkout` 只对**已提交内容**安全。已把重写的那部分重新补上并确认 132/132 |

### 回归测试

**后端 `tests/orders.rules.test.ts`（新增 6 条）**：`canRepeatFrom` 认终态与"日子过去了"两条路径；今天/明天还在收集中的不给；`planRepeat` 已有的跳过 + 来源重复只收一份；跳过判定认 id 优先（改名不算新菜、同名不同 id 算新菜）；`dishKey` 有 id 时菜名不参与；目标为空则整桌照抄。

**后端 `scripts/verify-orders-http.cjs`（新增 14 条）**：入口开关（待确认不给 / 已做好给）；拿未定局的当来源 409；整桌照抄的道数与落卡；不带备注；点两份的只收一份；照抄的是"我点的"；幂等（`added=0` + `skipped` + `message`）；部分已有只补缺的；来源不存在 404；缺目标参数 400；目标超窗口 400；来源标识非法 400；未登录 401；目标已做好 409 且一道没进。

**前端 `order.test.tsx`（新增 5 条）**：入口按后端 `canRepeat` 出/不出；抽屉先念"要照的那一桌"（含 ×2 与"备注不跟着走"）；确认后按选中的那一餐发对请求 + 两条 toast（加了 N 道 / 跳过哪道）；整桌都有时只念后端给的那句、不编"加了 0 道"。

**反证 3 组都验过会红**：

1. 前端改成自己复刻状态判定（`card.status === 'DONE'`）而不是用后端下发的 `canRepeat` → 前端 1 条红（`已取消` 的那张卡入口消失）；
2. `planRepeat` 退回单集合写法（来源重复项被报成"本来就有"）→ 后端 1 条红（132→131）；
3. `canRepeatFrom` 去掉"日子已经过去"那条分支 → 后端 1 条红（132→131）。

三处均已恢复，恢复后后端 132/132、前端 234/234。

## R-028 点单历史与美食日记（F3-09）：按天往前翻（D-035）（✅ 已验证，2026-10-13）

**改了哪些地方**：后端 `orders.rules.ts` 新增 `parseHistoryQuery` / `historyRange` / `hasEarlier` / `weekdayOf`，`orders.service.ts` 新增 `history()`，控制器新增 `GET /orders/history`；前端 `api/orders.ts` 新增 `HistoryDay` / `OrderHistory` / `fetchHistory` / `useOrderHistory` / `shiftDay`，新增 `pages/order/history/HistoryPage.tsx` + `history.scss`，路由加 `/order/history`，`back-link` 加返回文案，点菜单顶部加整行入口；验收脚本新增 11 条。它同时解决 `RISKS.md` R-19（60 张上限之外看不见）。

### 怎么验

```bash
# 单测
pnpm --dir services/api test                    # 138/138（历史规则 +6）
pnpm --dir apps/mobile test                     # 243/243（历史页 +9）
pnpm --dir services/api exec tsc --noEmit       # exit=0（后端这条是真检查）
pnpm --dir apps/mobile exec tsc -b              # ⚠️ 必须带 -b，见 RISKS R-25
pnpm --dir apps/mobile run lint                 # 6 条警告（与改动前一致）

# 接口
docker compose up -d --build api
pnpm --dir services/api run test:http:orders    # 125/125（新增 11 条）
```

### 实测结果（2026-10-13）

| 项 | 结果 |
| --- | --- |
| 接口：默认窗口 | 200，`days=31`、`from=2026-09-13`、`to=2026-10-13`、每天午晚各一行（`meals.length=2`） |
| 接口：按天铺开 | 昨天（无记录）那两格照样在，`dishCount=0`、`statusLabel="没有安排"`、`state="none"` |
| 接口：有内容的格子 | 今天晚餐带菜名与 `status=PENDING`，今天午餐带菜名与 `ordererCount=1`（两个人点的事都看得出来） |
| 接口：窗口边界 | 这一页最大日 == `to`（明天的安排不进历史——那是本周菜单的事） |
| 接口：往前翻 | `?to=09-13&pageSize=5` → `from=09-09`、`to=09-13`、5 天，且**所有日子都 ≤ 上一页的 from**（不重叠） |
| 接口：到头 | 库里的最早记录就在窗口内 → `hasMore=false`（不让人一直翻空白页） |
| 接口：校验 | `to=2026/10/13` → 400；`pageSize=999` → 400；未登录 → 401；共享关闭 → 吃货 `scope=mine` |
| 浏览器（390×844） | 点菜单顶部入口「📖 点单历史 / 翻翻最近吃过的 ›」（**2026-10-13 起与「自己写一道」并排一行，文案随之改短**，见 R-035）→ 点进去 `/order/history`，页头「09-13 ～ 10-13（31 天，有记录 2 天）」；31 张日卡：10-13 晚餐「【红烧排骨】… · 香辣豆腐 · 蒜蓉粉丝蒸虾 · 【桂圆银耳羹】」+「待确认」+「人数还没定」，10-13 午餐与 10-11 两格都是「没有安排」；底部「再往前没有记录了。」（这个家最早的记录就在窗口里，**按钮该不出现**） |
| 单测/接口 | 后端 138/138、前端 243/243、接口 125/125、后端 `tsc` exit=0、lint 6 条（不变） |

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 验收脚本一条红：`明天午餐=undefined` | **我把测试数据放在了窗口外**：默认窗口的结束日就是今天，而我往"明天午餐"点了一道——它不在这 0～今天这一页里 | 数据改放今天（接口**不让人补点过去的日子**，所以只能用今天）；顺带把这条边界**变成一条断言**（"这一页的窗口到 to 为止"）。**测试数据必须落在被验的窗口内，否则红的是自己的数据不是代码** |
| 紧接着「空白格」那条也红了 | 上一步把"今天午餐"占了，而断言还在假设它空着 | 改成拿**昨天**验空白（这个家的记录都在今天）。**断言不要依赖"某格恰好没被占用"这种巧合** |
| `hasMore` 那条我一开始写成了自证（`X === false ? false : typeof Y === 'boolean'`） | 我为了绕开"造不出更早记录"而把断言写松了——那种写法无论实现对不对都不会红 | 改成**真断言**（必须是 `false`），并把"库里还有更早的"那条路径明确标注**由单测覆盖**（接口不让人补点过去的日子，造不出那种数据）。同 R-027 的处置 |
| 浏览器里 Playwright 的 `click()` 一直超时（`a[href="/order/history"]`、`getByText('点单历史')`、甚至 `force: true` 都不行） | **不是页面坏了**：实测锚点 `pointer-events: auto`、无覆盖层、`elementFromPoint` 命中它自己、坐标点击后 `location.href` 仍是 `/order`——是**自动化桥接的可点击性判定卡住**。用页面内的原生 `link.click()` 派发同一个事件，立即跳到 `/order/history` 且页面正常渲染 31 天 | 改用**页面内真实点击事件**推进（与用户点击触发的是同一个 handler），并在 RUNBOOK 里记下"这不是产品缺陷"。拍照（screenshot）表面后来也卡住了（`surface preparation timed out`），改用 **DOM 结构化读值**作为证据（读出的 31 天、菜名、状态、空态、页尾文案都在上面那张表里） |

### 回归测试

**后端 `tests/orders.rules.test.ts`（新增 6 条）**：区间以 `to` 为终点往前数（含两端）；跨月/跨年也对；`to` 默认今天 + `pageSize` 默认 31；非法日期与越界 `pageSize` 报 400（含边界放行）；`hasEarlier` 的四种情形（有更早/正好到头/库里记录比窗口还晚/一张卡都没有）；`weekdayOf` 按本地日历算（东八区周一不显示成周日）。

**后端 `scripts/verify-orders-http.cjs`（新增 11 条）**：未登录 401；默认窗口 31 天 + 按天铺开 + 午晚各一行；星期标与日期对得上；有内容的餐次带菜名/状态/人数；窗口边界（最大日 == to）；空白格照样占位；按日期区间往前翻且不与上一页重叠；没有更早记录时 `hasMore=false`；`to` 格式错 400；`pageSize` 越界 400；共享关闭时吃货 `scope=mine`。

**前端 `HistoryPage.test.tsx`（新增 9 条）**：按天铺开（有内容显示菜名/人数/状态，没安排明说）；页头说清区间与有记录的天数；**往前翻时下一页的结束日是上一页第一天减一天**（不重叠）；翻页后两页的日子接在一起；到头说"再往前没有记录了"且不给按钮；一条记录都没有时的空态；有内容的格子落到点菜单；共享关闭时说明原因；没有家庭时给引导（不撞 404）。

**反证 3 组都验过会红**：

1. 前端翻页游标不挪一天（`lastPage.from` 直接用）→ 前端 1 条红（"再往前一页要带上前一天的结束日"）；
2. `hasEarlier` 恒真 → 后端 1 条红（"只有库里确实还有更早的餐次才算有"）；
3. `historyRange` 少算一天（改成不含 `to`）→ 后端 2 条红（区间含两端、跨月跨年）。

三处均已恢复，恢复后后端 138/138、前端 243/243。

**已知的覆盖缺口（如实记下）**：`hasMore=true` → 点「再往前一页」这条**浏览器路径**没验到——演示家庭的记录都在窗口内，而接口不让人补点过去的日子，造不出"有更早记录"的数据。该路径由单测（游标算法）与接口验收（`to` 参数翻页、不重叠）覆盖，浏览器只验到"到头"那条分支。

## R-029 列表页的「点这道」（F1-10）（D-036）（✅ 已验证，2026-10-13）

**改了哪些地方**：只动一个组件 + 一份样式——`pages/kitchen/components/DishCard.tsx`（共享卡，厨房页推荐与菜谱小书列表都用它）加「点这道」按钮与置灰态，`pages/kitchen/kitchen.scss` 加样式；新增 `DishCard.test.tsx`（7 条）。**后端零改动**：它走的是既有 `POST /orders/items`（与详情页「想吃这道」同一个接口）。

### 怎么验

```bash
pnpm --dir apps/mobile test                      # 250/250（菜谱卡 +7）
pnpm --dir services/api test                     # 138/138（未动后端，回归）
pnpm --dir apps/mobile exec tsc -b               # ⚠️ 必须带 -b，见 RISKS R-25
pnpm --dir services/api run test:http:orders     # 125/125（未动接口，回归）
```

### 实测结果（2026-10-13）

| 项 | 结果 |
| --- | --- |
| 列表页渲染 | 菜谱小书 12 张卡都带上「点这道」；**按钮在 `<Link>` 之外**（`isInsideLink=false`）——嵌在里面会让点击冒泡进详情页 |
| 默认路径（浏览器） | 在 `/recipes` 点第一张卡的「点这道」→ toast「已加入**今天晚餐**，等掌勺人安排」→ **停在 `/recipes`**（没跳详情）→ 该卡变「已加入」、按钮消失 → 回 `/order` 看 10-13 晚餐，菜确实在（显示为 `×2`，因为之前那次测试已经加过同一道） |
| 带目标路径（浏览器） | 从 `/prep` 第 4 天（10-16）**午餐**那行的「加菜」→ 进 `/recipes` → 点「点这道」→ toast「已加入**周五午餐**，等掌勺人安排」→ 回 `/prep` 看 10-16：午餐是「【桂圆银耳羹】」+「待确认」，晚餐仍是「三丝杏鲍菇」+「已安排」——**目标那一餐落对了**，没落到默认的今天 |
| 置灰 | 点过之后该卡变「已加入」，`queryByRole('button', {name:'点这道'})` 为 null（点不了第二次） |
| 失败不置灰 | mock 失败时 toast 报错，按钮**仍在**、没有「已加入」——那一下没成功，用户该能再点 |
| 测试 | 前端 250/250（+7）、后端 138/138、接口 125/125、`tsc -b` 无新增错、lint 6 条（不变）；反证 3 组都验过会红 |

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 想从备菜计划第 4 天**晚餐**那行进菜谱，点不到「加菜」 | 那行是「已安排」，`canAdd=false` → **按设计不画「加菜」**（F4-03 的口径，不是 bug） | 改从同一行的**午餐**进（它是空的、有加菜）；顺带在实测里确认了"锁定行不给加菜入口"本身是对的 |
| 我第一版断言写成了自证：`expect(sent.meal).toBe(sent.meal === 'DINNER' ? 'DINNER' : 'LUNCH')` | 这是"用被验的值推出被验的值"，无论实现对错都不会红 | 换成真断言：日期必须在**后端下发的 dayOptions 里**、餐次必须是 `LUNCH`/`DINNER`；具体默认哪个由 `nextMealDefaults` 按钟点定，**不钉死**（钉了下午会红，R-027 踩过） |

### 回归测试

**前端 `DishCard.test.tsx`（新增 7 条）**：一次点击落进"下一餐"并 toast 说清哪一餐（日期取自 dayOptions）；**带着「去安排」的目标进来就进那一餐**（`{mealDate:'2026-10-15', meal:'DINNER'}` 原样发出）；加过变「已加入」且按钮消失；没家庭时不画按钮；角色不能点菜时不画按钮；失败报错且不置灰；卡片本身仍是进详情的链接。

**反证 3 组都验过会红**：

1. 忽略带进来的 `plan`、一律用"下一餐" → 前端 1 条红（"带着「去安排」的目标进来时…"）；
2. 去掉能力判定（`mayOrder = true`，谁都画按钮）→ 前端 **5 条红**（含"没加入家庭时不画"与"角色不能点菜时也不画"）；
3. 成功后不 `setAdded(true)`（不置灰）→ 前端 1 条红（"加过之后变成已加入"）。

三处均已恢复，恢复后前端 250/250。

**注**：本项**未新增接口验收用例**——它走的是既有的 `POST /orders/items`（那一条路径已有 20+ 条接口断言，含权限、窗口、状态机）。新增的是**前端行为**（按钮出现条件、目标传递、置灰），所以证据落在单测与浏览器实测上；后端的回归是重跑 `test:http:orders`（125/125）。

## R-030 收藏（F1-09）（D-037）（✅ 已验证，2026-10-13）

**改了哪些地方**：后端新增 `modules/favorites/`（`favorites.rules.ts` 纯规则 + `favorites.service.ts` + `favorites.controller.ts` + `favorites.module.ts`）、Prisma `Favorite` 模型与迁移 `20261012174335_favorites`、`tests/favorites.rules.test.ts`（5 条）、`scripts/verify-favorites-http.cjs`（18 条，新增 `pnpm run test:http:favorites`）；前端新增 `api/favorites.ts`、`pages/recipes/favorites/FavoritesPage.tsx` + `.scss` + `.test.tsx`（6 条），改动 `pages/kitchen/components/DishCard.tsx`（心形按钮 + 7 条测试里的 3 条）、`KitchenPage.tsx` / `RecipeListPage.tsx`（批量取状态）、`MinePage.tsx`（入口）、`router/index.tsx`（`/favorites`）。

### 怎么验

```bash
pnpm --dir services/api test                        # 143/143（收藏规则 +5）
pnpm --dir apps/mobile test                         # 259/259（收藏页 +6、菜卡 +3）
pnpm --dir apps/mobile exec tsc -b                  # ⚠️ 必须带 -b，见 RISKS R-25
pnpm --dir services/api run test:http:favorites      # 18/18（新增）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/favorites   # 401（未带 token）
```

> 改了后端后要 `docker compose up -d --build api` 才生效（本次改动前 `/favorites` 返回 404，重建后回到 401）。

### 实测结果（2026-10-13）

| 项 | 结果 |
| --- | --- |
| 接口（18/18） | 未登录看列表/点收藏都 401；新账号列表空且带 `limit=200`；点一下 `favorited=true` total=1、再点一下 `false` total=0；连点两下回到未收藏**且不留两条记录**；后收的排在前面；`favoritedAt` 可解析；批量状态只回收藏了的、换个人问是空对象（**按人隔离**）、入参不是数组时当没问不炸；收藏不存在的菜 404 且话术可读；空 id/数字 id 400；被拒的请求不改动已有收藏 |
| 列表页心形（浏览器） | `/recipes` 第一张卡的心 `♡` `aria-pressed=false` → 点击 → `❤` `aria-pressed=true`（**写的是真实后端**） |
| 收藏页（浏览器） | `/favorites` 显示「共 1 道（最多 200 道）」+ 那道菜带实心 `❤`；在收藏页点 `❤` → toast「已取消收藏「【桂圆银耳羹】」」→ 页面变空态「还没有收藏的菜」、`article` 数归 0 |
| 双向同步（浏览器） | 取消后回 `/recipes`，那张卡的心**自己变回 `♡`**（状态来自服务端，不是各页各记一份） |
| 入口（浏览器） | 我的页有「❤️ 我收藏的菜 0 道 ›」指向 `/favorites`（数字与刚取消的状态一致） |
| 厨房页（浏览器） | 6 张推荐卡各带一颗心，**没有一颗在 `<Link>` 里**（`favInsideLink=false`），「点这道」按钮同时在 |
| 测试 | 后端 143/143、前端 259/259（31 文件）、接口 18/18、`tsc -b` 沿用 R-25 记录的 7 条既有错误（本项未新增） |

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| `pnpm --dir services/api test tests/favorites.rules.test.ts` 报 `1..144` 且 fail 1 | 参数被**追加**到 `tsc -p tsconfig.test.json && node --test .test-build/tests/*.test.js` 之后，node 又去跑未编译的 `.ts` 源文件——多出的那 1 个是**文件级**报错，143 个真实用例其实全过 | 用 `pnpm --dir services/api test`（不带参数）跑全量；文件级失败要看 `failureType`，别当成断言失败去改代码 |
| `playwright.click()` 点那颗心超时（连 `count()=1` 都确认过） | 与 F3-09 同一种**自动化桥接可操作性卡住**，不是应用缺陷：页内自检显示 `pointer-events:auto`、`elementFromPoint` 命中按钮自身、不在链接内、在视口内、`opacity:1` | 改用页内原生 `btn.click()`（走同一个 React 处理器），状态立即翻转——判断"能不能点"要用页内证据，别把桥接超时记成 bug |
| 收藏页上想用 `button.dish-card__fav` 取消，`querySelector` 返回 null | 收藏页用的是 `.fav-card__fav`（另一套类名），`dish-card__fav` 只属于菜卡 | 先读组件真实标记再写选择器（与"别猜选择器"同一条）；两处按钮类名不同是有意的——两页卡片布局不同 |
| `invalidateQueries({queryKey:['favorites']})` 会连累批量状态查询 | TanStack Query 的 key 是**前缀匹配**，`['favorites']` 命中 `['favorites','list']` 与 `['favorites','status',key]` 两者 | 把两类查询裂成 `['favorites','list']` 与 `['favorites','status',key]`，就地更新的状态不该被列表失效牵连（F1-10 之后的第二例，见 R-029） |
| 用 `isSuccess \|\| isError` 判断"要不要画心" | 把**请求状态**与**能否收藏**混成一件事：已登录用户在心还没加载完时看到的是"不能收藏" | hook 显式返回 `signedIn`（`Boolean(token)`），两处父页面都改用它——"能不能"要有一份明确的判据，别拿传输状态凑 |

### 回归测试

**后端 `favorites.rules.test.ts`（新增 5 条）**：id 非空/去空格/长度上限；空与空白被拒；到上限拒绝新的；**已收藏过的那道永远放行**（满额时也能取消）；上限值本身在合理范围。

**前端 `FavoritesPage.test.tsx`（新增 6 条）+ `DishCard.test.tsx`（+3 条）**：空态与文案；有收藏时列出并显示条数；点心调 `toggleFavorite` 并 toast；失败报错；未登录时不画心（`signedIn=false`）；**心在链接之外**（点了不会进详情页）；已收藏是实心、未收藏是空心且 `aria-pressed` 跟着走。

**反证 2 组都验过会红**：

1. `canFavorite` 去掉 `already` 判断（满额时连取消也拒）→ 后端 1 条红（"已收藏过的那道**永远放行**"），`not ok 79`；
2. 把心从 `<Link>` 外移进 `<Link>` 里 → 前端 1 条红（"已收藏是实心红心、未收藏是空心，且都在链接之外"）。

两处均已恢复，恢复后后端 143/143、前端 259/259。

**注**：**收藏上限（200）没有 HTTP 用例**——构造它需要 200 道菜与 200 次请求，而占用限流窗口会拖累同一次运行里的其他断言。上限的判定落在 `canFavorite` 的纯单测（含上面那组反证）上，接口只验到"到上限时回 409"这条分支的**代码路径存在**；如实记为**未在 HTTP 层覆盖**。

## R-031 家人最爱 / 家人常点（F5-02）（D-038）（✅ 已验证，2026-10-13）

**改了哪些地方**：后端新增 `modules/discover/`（`discover.rules.ts` 纯规则 + `discover.service.ts` + `discover.controller.ts` + `discover.module.ts`）、`tests/discover.rules.test.ts`（12 条）、`scripts/verify-discover-http.cjs`（25 条，新增 `pnpm run test:http:discover`）；前端新增 `api/discover.ts`、`pages/discover/components/FamilyPicks.tsx` + `.test.tsx`（8 条），改动 `pages/discover/discover.scss`（新增区块样式）与 `DiscoverPage.tsx`（挂在「本周菜单」之上）。**后端零 schema 改动**——用的是既有的 `OrderItem` / `MealOrder.status` / `Favorite`。

### 怎么验

```bash
pnpm --dir services/api test                          # 155/155（榜单规则 +12）
pnpm --dir apps/mobile test                           # 267/267（家人最爱 +8）
pnpm --dir apps/mobile exec tsc -b                    # ⚠️ 必须带 -b，见 RISKS R-25
pnpm --dir services/api run test:http:discover         # 25/25（新增）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/discover/family-picks   # 401（未带 token）
```

> 改了后端后要 `docker compose up -d --build api` 才生效（改动前该路由 404，重建后回到 401）。

### 实测结果（2026-10-13）

| 项 | 结果 |
| --- | --- |
| 接口（25/25） | 未登录 401；没家庭 404 且话术可读；新家庭空榜 total=0；**只是点了（PENDING）不算做过**；推到 DONE 后出现并写 `cooked=1`；**同一餐里两人各点一份只算一次**（两餐才 `cooked=2`）；只有人收藏的菜也进榜（`cooked=0, favorites=1`）；做过两次的排在只被收藏一次的前面；两人收藏同一道 `favorites=2`；**取消掉的餐不算做过**；共享关掉后吃货 `scope=mine` 且**完全没参与过的那道不出现**、自己参与过的仍在、自己收藏的仍在；同一时刻掌勺人仍看全量；`limit=1` 只回一道但 total 是全量；`limit=0` 与 `limit=999` 都 400；自由菜品（没有菜谱）不进榜 |
| 发现页（浏览器，掌勺人） | 「家人最爱」区块渲染 3 行：`1 【桂圆银耳羹】 做过 1 次`、`2 【红烧排骨】… 做过 1 次`、`3 三丝杏鲍菇 1 人收着`——**按信号强度排**（做过的在前），每行都带理由，前三名带名次 |
| 点一行（浏览器） | 页内可操作性自检五项通过（`pointer-events:auto`、`elementFromPoint` 命中自身、在视口内），页内原生点击后落到 `/recipes/jis-d5bf044025d6a803e0e1`（**榜单是入口不是终点**） |
| 共享关掉（浏览器，吃货） | 页面显示「家里关了共享，现在只算你自己做过和收着的菜。」；榜单为空时显示「还没有信号：做过的菜和收藏的菜都会出现在这里……」——**不编内容**；他自己收藏一道后刷新，出现 `1 三丝杏鲍菇 我收着`（**收藏那句分口径**：不是"1 人收着"） |
| 测试 | 后端 155/155、前端 267/267（32 文件）、接口 25/25、`tsc -b` 沿用 R-25 的 7 条既有错误（本项未新增）、lint 6 条（不变） |

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 接口第一版三条红：`推到 PLANNED 失败：404 Cannot POST /api/orders/2026-10-13-LUNCH/status` | 状态流转的真实路径是 `/orders/meals/:mealKey/status`（我在脚本里漏了 `meals/` 段） | 按控制器里的 `@Post('meals/:mealKey/status')` 改正；**路径要从控制器读，不要凭记忆写** |
| `取消掉的餐不算做过` 那条**假绿**：加菜用"昨天"→ 被 400 拒（`parseMealDate` 只放行今天起 7 天），餐根本不存在，而断言"榜单里没有它"照样通过 | 断言写了结论，却没验**前提成立**（条目真的写进去了、餐真的被取消了） | 改成两段：先断言「加点 201 + 取消 200」（准备条件），再断言它不进榜；并改用**未来**的日期（`dateKeyOf(2)`）。**这类"前提没成立所以结论凑巧为真"的假绿，与自证断言是同一个病** |
| `共享关掉后吃货看不到别人参与的那道` 第一版用 dishA 断言，红了 | dishA 在午餐（小满没参与）与晚餐（**小满参与过**）都有，`some: { userId }` 会把整道菜带回来——**闸门按餐算，不是按菜算** | 另造一道**只由妈妈一个人做**的菜（`dateKeyOf(1)` 午餐，小满全程没参与）再断言；同时补一条"自己参与过的仍在"（两条都指向同一个闸门，一正一反） |
| `自由菜品不进榜` 的准备条件红：往"今天晚餐"加菜回 409 | 那一餐已经推进到 DONE，加菜被正确地拒掉（**不是 bug**） | 改用第三天午餐（`dateKeyOf(3)`）：今天两餐已成定局、明天午餐给了"小满没参与的那道"、明天晚餐被取消过（取消后能加，但会把整餐拉回 PENDING，与取消断言打架） |
| 后端单测第一轮报编译错 `has no exported member 'rankLabel'` | 我从 rules 里删掉了那个暂时用不上的话术函数，但测试文件还在 import 它 | 同步删掉测试里的引用与那段 case（**删导出要连调用处一起看**）；修完反证才真正开始生效 |
| 反证 1 注入后 `pnpm --dir services/api test` 输出为空、退出码 2 | 那次的红其实是**编译错**（上一行那条），反证根本没跑到 | 先修编译错，确认反证的红来自**断言**（`not ok 68 - 做过几次：按餐去重`）才算数 |

### 回归测试

**后端 `discover.rules.test.ts`（新增 12 条）**：`parsePicksLimit` 默认值与 5 种非法值；同一餐里两份只算一次；两餐算两次；"最近做过"取最近且与写入顺序无关；没做过的不在表里（是"没有"不是"0 次"）；喜欢数按人去重；做过比收藏重；做两次 + 一人收藏压过做两次；没信号的菜不进榜；同分顺序确定（正序与逆序输入结果一致）；收藏多但没做过的排在做过一次的后面。

**前端 `FamilyPicks.test.tsx`（新增 8 条）**：每行带理由（做过几次 + 几人收着）；只做过没人收藏时不编收藏；`scope=mine` 时给出说明且收藏那句说「我收着」（并断言**不出现**「1 人收着」）；没信号时不编内容；点一行进那道菜的详情（断言路由真的到了 `/recipes/<id>`）；名单超过一屏时说还有多少道并给出两条出路；没加入家庭时给出去处且**不去请求榜单**；取不回来时报错并可重试、不显示假内容。

**反证 2 组都验过会红**：

1. `countCooked` 改成数条目（不按餐去重）→ 后端 1 条红（`not ok 68 - 做过几次：按餐去重`）；
2. `DiscoverService` 去掉共享开关的两层过滤（一律按全家算）→ 接口 1 条红（「共享关掉后，自己完全没参与过的那道菜不在自己的榜单里」）。

两处均已恢复，恢复后后端 155/155、接口 25/25。

**注**：**`limit` 上限（24）之外还有一个"榜单最多几道"的展示层判断**（页脚"还有 N 道"）已在接口里用 `limit=1` 覆盖；**前端榜单的名次只画前三**（第 4 名起就是列表），这条属展示取舍，由单测的"超过一屏"用例与浏览器实测覆盖。**未在 HTTP 层覆盖**的是"菜谱在两次查询之间被删掉"那条防御分支（服务层有 `flatMap` 跳过，但没有构造这个竞态的用例），如实记为未覆盖。

## R-032 采购清单（F7-01）（D-039）（✅ 已验证，2026-10-13）

**改了哪些地方**：后端新增 `modules/shopping/`（`shopping.rules.ts` 纯规则 + `shopping.service.ts` + `shopping.controller.ts` + `shopping.module.ts`）、`tests/shopping.rules.test.ts`（14 条）、`scripts/verify-shopping-http.cjs`（27 条，新增 `pnpm run test:http:shopping`）；前端新增 `api/shopping.ts`、`pages/shopping/ShoppingPage.tsx` + `.scss` + `.test.tsx`（9 条），改动 `router/index.tsx`（`/shopping`）、`pages/back-link.ts`（白名单）、`pages/prep/PrepPage.tsx` + `prep.scss`（入口）。**零 schema 改动**（用既有 `MealOrder` / `OrderItem` / `Recipe.ingredients`）。

### 怎么验

```bash
pnpm --dir services/api test                          # 170/170（清单规则 +14）
pnpm --dir apps/mobile test                           # 276/276（采购页 +9）
pnpm --dir apps/mobile exec tsc -b                    # ⚠️ 必须带 -b，见 RISKS R-25
pnpm --dir services/api run test:http:shopping         # 27/27（新增）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/shopping-list   # 401（未带 token）
```

> 改了后端后要 `docker compose up -d --build api` 才生效（改动前该路由 404，重建后回到 401）。

### 实测结果（2026-10-13）

| 项 | 结果 |
| --- | --- |
| 接口（27/27） | 未登录 401；没家庭 404 且话术可读；没点菜时空清单 `dishCount=0`；**还在收集中的（PENDING）不算**；「选好了」（PLANNED）之后才进清单；`from/to/days` 与 `meals` 都在；每样食材带 `from`；**共用食材只出现一条**且 `from` 列出两道菜；用量合成一句话；按拼音排序；自由菜品列在 `missing` 且不进配料；`dishCount` 含待补的；`days=1` 时**只在明天出现的食材不进清单**（用"明天独有"的食材验，不是共用那样）；`days=0` / `days=99` 都 400；共享关掉后吃货 `scope=mine` 且只由别人参与的那一餐不出现、掌勺人仍看全量 |
| 采购页（浏览器） | 15 样食材按拼音排（八角、白砂糖、冰糖、陈皮…）；**三样显示「用量没写」**（白砂糖/料酒/生抽，不编"适量"）；**「花椒 = 3-4颗」原样保留**（不算 3.5）；每样都带"（哪几道菜）"；页头「10-13 起 3 天：2 餐定了菜单，共 3 道菜」；页脚说清只算已安排/正在做 |
| 勾选（浏览器） | 勾第一个：`checked=true`、行加 `is-packed`、名字 `text-decoration: line-through`、进度 `0/15 → 1/15`；**再点一次取消**回到 `0/15`（勾错能改） |
| 没有配料表的菜（浏览器） | 「这几道菜没有配料表，要自己记一下：」+「妈妈牌糖醋排骨」单独一层（它不进上面的 15 样，但不会消失） |
| 入口（浏览器） | 备菜页「7 天共 14 餐，还有 12 餐空着。**看要买什么 →**」→ 点击落到 `/shopping`，返回按钮是「← 返回备菜计划」（指向 `/prep`） |
| 测试 | 后端 170/170、前端 276/276（33 文件）、接口 27/27、`tsc -b` 沿用 R-25 的 7 条既有错误（本项未新增）、lint 6 条（不变） |

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 单测把 `3-4颗` 拆成了「值 3、单位 `-4颗`」 | 正则 `^(\d+)\s*(.*)$` 只截第一个数字，后面的 `-4颗` 全被当成单位——**求和的场景下会算出荒谬结果** | 加一层"数字后紧跟 `-~～—–`/`到`/`至` 一律不认"的判断，区间原样保留；并补 `2~3个`、`5—6片`、`3到4个` 三条用例钉住。**这是单测第一次运行就抓到的真 bug，不是我事后想到的** |
| 验收脚本报「days=1 时共用食材不出现」红 | 我拿**共用食材**（银耳）验窗口边界，可它在**今天那道**菜里也有——它出现在 days=1 的清单里是**对的** | 改成用"**明天那两道菜独有**的食材"（干莲子/红糖/红枣/南瓜）来验，并先断言"找得到独有食材"（否则这条边界根本没验） |
| 验收脚本报「掌勺人仍看全量」红，且 `meals=[]` | 我把"只由妈妈参与的那一餐"排在了 `dateKeyOf(3)`——**已经在默认 3 天窗口之外**，掌勺人看不到它是正确的 | 挪到窗口内的第二天晚餐，并补一条准备条件断言（点好 201 + 确认 200）。**测试数据必须落在被验的窗口内**（F3-09 踩过同一个坑，这是第二次） |
| 第一版脚本里留了一段"先按 id 猜、再重查名字"的乱写与一个占位函数 | 我边写边改，没把前面的废码删掉 | 清掉，改成一次循环里同时收集 `id` 与配料表（`nameToId` 直接用），**写完就删废码**，别留"以后可能用得上"的壳 |

### 回归测试

**后端 `shopping.rules.test.ts`（新增 14 条）**：食材名只去空白不做同义词归并；`parseAmount` 认得 4 种形状、7 种认不得（含 4 种区间写法）；同单位求和；求和结果不带多余小数（`0.1 + 0.2 → 0.3`）；单位不一致不跨单位求和（并断言结果里**不出现** `3`）；能合的合、认不出的原样列；一处都没写 → `null`；同样写法去重；同名食材跨菜合并且 `from` 列全；排序与输入顺序无关；空名丢弃；自由菜品照样列出。

**前端 `ShoppingPage.test.tsx`（新增 9 条）**：每样显示用量与"为哪几道菜买"；没写用量时说「用量没写」且**不出现**「适量」；说明按哪几天哪几餐算；勾选改进度与样式类、再点取消；没有配料表的菜单独列出；菜单没定时说清原因并给出路（去备菜计划）；`scope=mine` 时说明；没家庭时给出去处且**不发请求**；取不回来时报错并可重试。

**反证 2 组都验过会红**：

1. `mergeAmounts` 跨单位强行求和（"2朵 + 1袋 = 3"）→ 后端 1 条红（`not ok 3 - 单位不一致：各自原样列出，**不跨单位求和**`）；
2. 服务层把 PENDING 也放进清单 → 接口 1 条红（「还在收集中的那一餐（PENDING）不算」）。

两处均已恢复，恢复后后端 170/170、接口 27/27。

**注**：**"没写用量的食材"那条接口断言没有真正覆盖**——本次抽到的菜谱都写了用量，脚本里那条走了 `else` 分支并**显式打印了"⚠️ 未真正覆盖"**（不伪装成通过）。该分支由 `mergeAmounts` 的单测（`''`/`'  '` → `null`）与浏览器实测（白砂糖/料酒/生抽三样显示「用量没写」）覆盖。**"菜谱在两次查询之间被删"那条防御分支同样未在 HTTP 层覆盖**（与 R-031 同一类缺口，如实记着）。

## R-033 信息架构改版：采购清单进冰箱第一屏、发现页收干净（D-040）（✅ 已验证，2026-10-13）

**改了哪些地方**：`pages/fridge/FridgePage.tsx` 整体重写（原先是写死的示例页）+ 新增 `pages/fridge/fridge.scss` + 新增 `pages/fridge/FridgePage.test.tsx`（10 条）；`pages/discover/DiscoverPage.tsx` 撤掉三格假数字；`pages/discover/components/FamilyPicks.tsx` 撤掉两个入口胶囊（+ `discover.scss` 清对应样式）；`pages/discover/components/WeekPlan.tsx` 撤掉「去点菜单」；`pages/shared.scss` 删除 4 组死样式（`.stats` / `.aicta` / `.grid2` / `.quad`）；两处测试更新 + `DiscoverPage.test.tsx` 新增守门用例。**后端零改动**——冰箱页直接复用 `GET /shopping-list`（F7-01 的接口）。

### 怎么验

```bash
pnpm --dir apps/mobile test                       # 287/287（冰箱页 +10、发现页守门 +1）
pnpm --dir apps/mobile exec tsc -b                # ⚠️ 必须带 -b，见 RISKS R-25（本条仍 7 条既有错误）
pnpm --dir apps/mobile run lint                   # 6 warnings / 0 errors（不变）
# 浏览器：http://127.0.0.1:5173/fridge 与 /discover
# 方案对比预览（实现依据，已按最终形态更新）：python3 -m http.server 8766 --directory docs/ui-preview → /ia-nav/index.html
```

### 实测结果（2026-10-13，浏览器实测）

| 项 | 结果 |
| --- | --- |
| 冰箱页块高（用户的核心诉求） | **采购一行 63px**，**冰箱主体 317px**——"冰箱才是主题"落到了数值上（第一版采购块是整块预览，被用户当场否掉） |
| 采购一行 | 文本「🛒 要去买什么 / 10-13 起 3 天 · 共 15 样」+ 有未配料表菜时的 `!` 记号 + ›，`href=/fridge → /shopping`；**不铺开任何食材**（`shopHasList=false`） |
| 冰箱主体 | 标题「冰箱里有什么」+「还没做」标签；四个存放区骨架（常温/保鲜/冷藏/冷冻）各写"食材会列在这里"；说明将来会长什么样 |
| 假数据清零 | 冰箱页无 `.stats / .aicta / .grid2 / .quad`（`ghostStyled=false`）；发现页 `hasStats=false`，`85 / 12 冰箱食材 / 私房菜` 全不在 |
| 发现页胶囊 | 5 → 2：实测只余「常用组合 →」「备菜计划 →」（跟着「本周菜单」卡走） |
| 点进去 | 那一行进 `/shopping` 且带 `from=/fridge`（返回能回冰箱，单测断言 `probe == '/shopping|/fridge'`） |
| 三行状态 | 加载「正在算…」、出错「暂时打不开，点进去重试」、空「这几天还没定菜单」——**三种都只占一行**，冰箱主体始终在位（单测逐条验） |
| 测试 | 前端 287/287（34 文件）、`tsc -b` 7 条既有错误（未新增）、lint 6 条（不变）；反证 2 组都验过会红 |

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 第一版把采购做成**整块预览**（标题 + 由来 + 三样 + 按钮） | 我按"清单要显眼"直接做成内容块，但这一页的主题是**冰箱** | 用户当场指出后改成**一行入口**（63px），主体让给冰箱（317px）。教训：**"显眼"不等于"占地方"**——一行也能显眼（带品牌色图标 + 样数 + 箭头） |
| 冰箱页测试两条红：`共 5 样 →` / `10-13 起 3 天 · 共 3 样` 找不到 | ① 数字是插值，DOM 里被拆成多段文本节点；② 更根本的是**我先 await 静态标题、再断言数据相关的那句**，断言跑在数据到达之前 | ① 用函数匹配器把 `textContent` 拼起来比；② **await 那一句本身**（`findByText` 带重试）而不是 await 旁边那句静态文案。这是本轮第二次踩"断言时机"（第一次在冰箱页第一版），已归为一类：**断言要等"它自己那部分数据"** |
| 反证 2 第一次注入后报 `Tests no tests` | 我用 `{false && (` 硬塞了一段 JSX，把文件写坏——**那是编译失败，不是反证生效** | 改成语法正确的写法重新注入，看到真正的断言红（`expected <span class="stock__zone-name">… to be null`）才算数。**"红"要看清是断言红还是编译红**（R-031 也踩过同一个坑） |
| 全套测试偶发一条红（AI 抽屉的「换一批」） | 单独跑 18/18、全套连跑两次 286/286 → **偶发**，且不在本轮范围内（读代码看是两个可疑写法：魔法数 `calls <= 5`、`[].every()` 恒真） | 不去动它（范围外），但记了 **R-28** 说明可疑根因与建议改法，并如实写清"本轮没修" |

### 回归测试

**新增 `FridgePage.test.tsx`（10 条）**：主体是冰箱（四区骨架 + 未来说明）；采购只占一行且**不铺开食材**；点那行进 `/shopping` 且带来源；没定菜单/取不回来/加载中都**只占一行**且冰箱主体完整；有未配料表的菜只给一个记号不铺开；`scope=mine` 说明；没家庭时不发请求；**一个假数字都没有**（逐个断言 `12/3/8/在库/临期/品类/小油菜/今日先吃/存放位置/拍照识别` 皆不在，且「还没做」必须明说）。

**新增 `DiscoverPage.test.tsx` 守门用例（1 条）**：`.stats` 不存在、`私房菜/冰箱食材/临期` 不在、入口胶囊恰好是 `['常用组合 →', '备菜计划 →']`——**这条守的是"别哪天又把假数字加回来"**。

**更新 2 条旧断言**：`FamilyPicks.test.tsx` 的"给出路"改为"不再挂收藏/点菜入口"；`WeekPlan.test.tsx` 的"两个出口"改为"只留备菜计划"。

**反证 2 组都验过会红**：

1. 把三格假数字加回发现页 → 守门用例红（`expected <div class="stats">…(3)</div> to be null`）；
2. 把采购块重新铺开成三样预览列表 → 冰箱页红（`expected <span class="stock__zone-name">… to be null`）。

两处均已恢复，恢复后前端 287/287。

**注**：本项**未新增后端/接口用例**——它只重组前端信息架构，数据仍走 F7-01 已验收的 `GET /shopping-list`（27 条断言那一套）。冰箱页对"很多样（比如 30 样）"的展示只验证了"仍是一行"（样数进不去 DOM 的内容区），没有造 30 样的数据；**如实记为未覆盖**（口径上它不影响这一行的形态：行高由 CSS 定，与样数无关）。

## R-034 AI 入口的快问/示例每次打开现生成、各条路各发自己的 schema（D-041）（✅ 已验证，2026-10-13）

**改了哪些地方**：后端 `ai.client.ts` 的 `ChatRequest.json?: boolean` → `jsonSchema?: unknown`（`response_format` 直接发调用方给的那份；`structured` 判定随之改）；`ai.service.ts` 两条 `chatJson` 调用各自传 `PICKS_SCHEMA` / `PROMPTS_SCHEMA`；`ai.rules.ts` 的 `PROMPTS_SCHEMA` 从"定义了没人用"移到 `PICKS_SCHEMA` 旁边并补注释。前端 `api/ai.ts` 的 `useAiPrompts`：`staleTime: 30 分钟` → `0`，新增 `refetchOnWindowFocus: false`。测试：`ai-sheets.test.tsx` 新增「每次打开都重新生成一批」（跨两次挂载数请求数），并把旧用例的 `toBeLessThanOrEqual(1)` 收紧为 `toHaveLength(1)`。stub 上游 `ai-stub-upstream.cjs` 记录并暴露 `schemaName`（新增只读 `GET /__received`），接口脚本 `verify-ai-http.cjs` 据此断言"各发各的 schema"。

### 怎么验

```bash
# 1) 后端单测（规则/服务，含 parsePrompts 与 schema 相关）
pnpm --dir services/api test                      # 170/170
pnpm --dir services/api exec tsc --noEmit         # exit=0（后端这条是真检查）

# 2) 接口验收（stub 上游）：stub 会把每次请求实际带的 schema 名记下来
node services/api/scripts/ai-stub-upstream.cjs &  # 127.0.0.1:18990
# 让容器把 AI_API_BASE 指向 stub（host.docker.internal:18990）后：
pnpm --dir services/api run test:http:ai          # 28/28

# 3) 前端
pnpm --dir apps/mobile test                       # 288/288（本项 +1）
pnpm --dir apps/mobile exec tsc -b                # ⚠️ 必须带 -b，见 RISKS R-25（仍 7 条既有错误）
pnpm --dir apps/mobile run lint                   # 6 warnings（不变）

# 4) 真网关连打三次：应当是三批不同的短句
#    （POST /api/ai/prompts，带登录 token）
```

### 实测结果（2026-10-13）

| 项 | 结果 |
| --- | --- |
| 根因复核 | `PROMPTS_SCHEMA` 在 D-032 的提交（`3643157`）里**没有任何引用**：`git show 3643157:services/api/src/modules/ai/ai.service.ts \| grep PROMPTS_SCHEMA` 为空；客户端当时对所有结构化调用硬发 `PICKS_SCHEMA` |
| stub 断言 | 28/28，含「提示词那条路发的是**自己的** schema（prompts）… 实际 `schemaName=["prompts"]`」与「推荐那条路仍发 picks」 |
| 反证 | 把 service 改回 `jsonSchema: PICKS_SCHEMA` → 该断言**红**（`actual ["picks"]`）；恢复后 28/28（改回→红→再改回，两次都留着输出） |
| 真网关 | `/ai/prompts` 连打三次返回三批不同内容（如 `['今天想清淡点','孩子也能吃','冰箱有剩青菜','想喝点热汤']` / `['清淡点，孩子也吃','冰箱有剩青菜','想吃面，越快越好','天热没胃口']` / `['清淡点，孩子也吃','冰箱有剩青菜','想吃番茄炒蛋','今晚想喝汤']`），每次约 8 秒 |
| 浏览器（核心诉求） | 重新打开抽屉时 **XHR 记录到各发一次 `/ai/prompts`**（1→2 次），每次 200（约 8.7s）；界面 5 条快问**全部取自该次返回的 18 条**（`shownSubsetOfBatch=true`）、**0 条**落在写死池子里；「问 AI」侧同理（3 条示例取自该次返回的 12 条）；两次打开的两批**互不相同** |
| 前端测试 | 288/288（34 文件）；反证：把 `staleTime` 改回 `30 * 60_000` → 新用例红（`expected 2, received 1`），恢复后绿 |

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 浏览器里第一次读到的 5 条快问**全在写死池子里**，差点记成"前端还在兜底" | 我只等了 6 秒，而这次生成要 **7.9 秒**——兜底先渲染、AI 那批还没到 | 改成轮询等待"出现不在池子里的句子"；但更该记的是：**这条读值本身无法区分"兜底"与"AI 恰好说了相似的话"**，所以真正作数的证据是**请求记录（XHR 是否发出、返回了什么）+ 界面值是否为该批次的子集**，而不是"我读了一眼觉得像/不像" |
| 先前用 `window.fetch` 记请求，什么都没记到 | axios 走 **XHR**，不是 fetch | 改成在 `XMLHttpRequest.prototype.open/send` 上装记录器；同理"请求发生了没有"要用对通道看，不能凭界面现象反推 |
| 文档里 D-032 有一条"真网关实测通过"，与用户看到的现象矛盾 | 那次**碰上了网关拒绝 `response_format` 的分支**（去掉它重试后模型自由作答，恰好正常）；接受分支下必失败 | 验收要**对"两条分支都能过"负责**：stub 记录实际 schema 名就是为此（stub 上游从不拒绝 `response_format`，专门守住"我们发的是什么"这一层） |
| `PROMPTS_SCHEMA` 曾经重复定义（我插入时落在两处） | `TS2451 Cannot redeclare` | 删掉重复；**并意识到"有这个常量"不等于"它在被用"**——死代码比错代码更安静（错代码会挂，死代码只让功能悄悄走兜底） |

### 回归测试

**后端**：170/170（含新增/调整的 `parsePrompts`、`chatJson` 相关；比 D-032 的 120 条多出来的部分是这两轮陆续加的规则/服务用例，**其中一条"只比两个 schema 常量、不验接线"的用例被删掉换成 stub 实测**——那是假安心，占着数字不干活）。**接口**：stub 28/28（新增 3 条 schema 断言）。**前端**：288/288。

**新增 1 条**（`ai-sheets.test.tsx`）：「每次打开都重新生成一批（用户 2026-10-12：「不然都是这几个推荐和问题」）」——同一个 `QueryClient` 跨两次挂载，断言 `/ai/prompts` 请求数 `1 → 2`；反证（`staleTime` 回 30 分钟）会红。

**收紧 1 条**：旧用例的 `toBeLessThanOrEqual(1)` → `toHaveLength(1)`（原写法把 0 也当通过，等于半个断言）。

**注**：真网关的三次调用只验了"三批不同"（内容不同即可），**没有**断言"一定包含某词"——真模型写什么不该被测试规定（D-032 踩过这条）。

## R-035 点菜单两个入口并排一行（D-043）（✅ 已验证，2026-10-13）

**改了哪些地方**：前端 `pages/order/OrderPage.tsx` 把「点单历史」（F3-09）与「自己写一道」（F3-10）两条整行入口包进 `.order-shortcuts` 容器（并排一行、各占半行），说明文案随之改短；`pages/order/order.scss` 新增 `.order-shortcuts`（flex + gap + stretch，承接原本挂在两条入口上的外边距）与 `.order-shortcuts > *`（各占半行 + `white-space: normal`），并从 `.order-history-link` / `.order-freedish` 上撤掉 `width: calc(100% - ...)` 与各自的 `margin`。**后端与接口零改动。**

### 怎么验

```bash
# 前端
pnpm --dir apps/mobile test                      # 289/289（本项 +1）
pnpm --dir apps/mobile exec tsc -b               # ⚠️ 必须带 -b，见 RISKS R-25（仍 7 条既有错误、未新增）
pnpm --dir apps/mobile run lint                  # 6 warnings（不变）

# 浏览器（dev server 在跑）：看两卡是否同一行、窄屏是否还溢出
# http://127.0.0.1:5173/order
```

### 实测结果（2026-10-13）

| 项 | 结果 |
| --- | --- |
| 并排 | 390×844：两卡 `y` 相同（左 `x=16`、右 `x=200`，宽 174 / 175，高均 **63px**）——同一行，各半宽 |
| 不溢出 | 两卡均 `scrollWidth == clientWidth`（172 / 172）。**改之前**右卡是 `217 > 172`，文字跑到卡外 |
| 窄屏 | 320px：说明文字换两行，两卡**同高 80px**（`align-items: stretch` 生效，不会一高一矮）；仍无溢出 |
| 行为不变 | 点「点单历史」→ `/order/history`；点「自己写一道」→ 抽屉打开（菜名 / 日期 / 餐次 / 备注 / 「加进点菜单」按钮齐全） |
| 文案 | `翻翻这阵子家里都吃过什么` → `翻翻最近吃过的`；`菜谱库里没有的菜，写个名字就能点` → `写个名字就能点` |
| 测试 | 前端 289/289；反证 1 组会红（把 `.order-shortcuts` 容器改回普通 `div` → `expected null to be truthy`），恢复后 289/289 |

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 改半行后右卡文字溢出卡外 | 「自己写一道」是 `<button>`，浏览器默认 `white-space: nowrap`；`<a>`（点单历史）继承 `normal` 所以只有按钮出事 | `.order-shortcuts > *` 统一 `white-space: normal`。**同类元素用不同标签时，默认值要分开看** |
| 第一轮验收"看着还行" | 只量了容器高度与 `x` 坐标（都正确），差点收工 | 补量 `scrollWidth` 才发现溢出（`217 > 172`）；**截图看起来"挤"容易被当成窄屏正常表现，溢出必须量** |
| 新增用例第一次红（`expected null to be truthy`） | 断言写在数据到达之前——`findByRole` 等的是元素，我先用 `document.querySelector` 直接找容器 | 先 `await findByRole` 拿到入口元素，再断言其 `parentElement` 是那个容器 |

## R-036 AI 调用层迁移到 pi-ai（D-044）（✅ 已验证，2026-10-13）

**改了哪些地方**：新增 `services/api/src/modules/ai/ai.pi.loader.ts`（ESM 桥）、`ai.pi.runtime.ts`（配置 → pi-ai provider/model，含 `GATEWAY_COMPAT`）、`ai.pi.rules.ts`（消息/工具形状转换与失败分类）；`ai.client.ts` 内部重写（对外签名与话术一字未改）；`services/api/package.json` 加 `@earendil-works/pi-ai@1.2.0`；`pnpm-workspace.yaml` 的 `allowBuilds` 补 protobufjs / @google/genai（拒绝）+ pi-ai 相关；stub 上游加 `STUB_REJECT_SCHEMA_ONCE=1`；验收脚本加"摘掉 schema 补发一次"断言与相应的 schema 断言放宽。

### 怎么验

```bash
# 1) 后端单测与类型（每条都要看退出码，别只用管道看输出——本轮踩过整段被吞掉）
pnpm --dir services/api test; echo "exit=$?"           # 185/185
pnpm --dir services/api exec tsc --noEmit; echo "exit=$?"   # 0（后端这条是真检查）

# 2) 镜像要真的重建（代码改了不重建，跑的还是旧镜像：本轮踩过，见"踩过的坑"）
docker compose build api; echo "exit=$?"               # 0，且输出里要有 "Image cook-api Built"
docker run --rm --entrypoint sh cook-api:latest -c "grep -c 'await run(false)' /app/dist/modules/ai/ai.client.js"  # ≥1
docker inspect cook-api-1 --format '{{.Image}}'        # 与 docker images --no-trunc 的 cook-api:latest 一致

# 3) 接口验收（stub 上游，含"拒绝 schema 后补发"这条偶发路径）
node services/api/scripts/ai-stub-upstream.cjs 18990 &          # 普通模式
STUB_REJECT_SCHEMA_ONCE=1 node services/api/scripts/ai-stub-upstream.cjs 18990 &  # 拒绝模式（验重试）
AI_API_BASE=http://host.docker.internal:18990/v1 AI_API_KEY=stub-key AI_MODEL=stub-model \
  docker compose up -d --force-recreate api
pnpm --dir services/api run test:http:ai               # 29/29（拒绝模式）/ 28/28（普通模式）

# 4) 真网关端到端
docker compose up -d --force-recreate api             # 回到 .env 里的真配置
# 提示词 / 推荐 / 流式问答三条路各打一次（浏览器里带 token，或用 RUNBOOK 的脚本）

# 5) 前端
pnpm --dir apps/mobile test                            # 289/289
pnpm --dir apps/mobile exec tsc -b                     # ⚠️ 必须带 -b，见 RISKS R-25（仍 7 条既有错误）
```

### 实测结果（2026-10-13）

| 项 | 结果 |
| --- | --- |
| 后端单测 | **185/185**（新增 `ai.pi.rules` 12 条：工具/消息/工具结果形状、非法 JSON 参数、失败分类；`ai.retry` 3 条：什么样的 400 才该摘掉 schema 重试） |
| 后端类型 | `tsc --noEmit` exit 0 |
| 镜像 | `docker compose build api` exit 0、`Image cook-api Built`；容器镜像 ID 与 latest 一致（`1d0b0c4d…`） |
| 接口验收 | stub 普通模式 **28/28**；拒绝模式 **29/29**（多一条"摘掉 schema 补发一次"）。日志侧证据：`上游不支持结构化输出（400）… 去掉 response_format 重试一次` |
| 反证 | 去掉补发（判断保留、`await run(false)` 删除）→ 重建镜像后 **推荐与提示词两条路双双 502**，那条断言也红（`（没有补发）`）；恢复后 29/29 |
| 真网关（端到端） | 提示词 **17.7s** 返回 18 快问 + 12 示例（「一个人吃简单点」「秋天润一润」…）；推荐 **13.6s** 返回 5 道（薏米红豆粥/凉拌海带丝/番茄炒蛋…）；流式问答 **10.8s / 95 段 / 4 次工具调用**（读安排→翻菜谱×2→核对）**/ 2 条建议**，且模型自己避开了"已做好"的那一餐 |
| 浏览器复核 | 抽屉里 5 条快问（「西芹拌豆干吧」「鸡肉粥再来一次」…）**全部来自 AI 现生成，0 条落在写死池** |
| 前端 | 289/289；`tsc -b` 沿用 7 条既有错误（未新增） |

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 容器启动即 `ERR_PACKAGE_PATH_NOT_EXPORTED`（pi-ai），服务起不来 | **ESM 桥只铺了一半**：`ai.pi.runtime.ts` 里 `import { createModels, createProvider }` 是**值导入**，被编译成 `require`；类型导入（`import type`）才会编译后消失。D-042 里预警过这座桥，落地时漏了这个文件 | 所有 pi-ai 的**值**都改成从 `loadPiAi()` 拿；补一条检查：`grep -rn "from '@earendil-works/pi-ai" src/ \| grep -v "import type"` 必须为空 |
| 真网关 `/ai/prompts` **502**（迁移后第一次验证） | 我在迁移时**有意去掉了**"网关拒绝 response_format 就摘掉重试"那一层，理由是"pi-ai 会如实报错，那层猜测是脆弱来源"。但网关拒绝是**常态**（8 次里 5 次），这条路立刻变成用户可见的失败 | 把重试加回来（判据也收紧：只认错误体里提到 response_format / unavailable now，别的 400 不重试），并给 stub 加 `STUB_REJECT_SCHEMA_ONCE=1` 把这条偶发路径变成可确定验证的一条。**教训：迁移不是"顺便简化"的机会，行为等价的边界要显式列出来再逐条决定** |
| 验收"29/29 通过"但容器日志里没有任何重试告警 | **镜像没更新**：`docker compose build` 那次实际**失败**了（编译错误），而我用 `2>&1 \| tail` 看输出、没看退出码，于是验收跑在旧镜像上 | ① 构建/测试命令一律看**退出码**（`; echo "exit=$?"`），不只看输出；② 验收前核实"运行的镜像 ID == latest 镜像 ID"；③ 用镜像里的**特征串**（`grep -c 'await run(false)'`）确认代码真的进包了 |
| 反证第一次没变红 | 注入的是 `if (false && failure?.kind === …)`，这让 TS **无法收窄** `failure` → 6 个编译错误 → 构建失败 → 还是旧镜像在跑 | **"红"要分清是断言红还是编译红**（这是本项目第三次踩：R-031、R-033 各一次）。改成"判断保留、只删补发动作"（类型合法、行为=不重试），构建 exit 0 后才看到断言红 |
| 一条**通过的**断言却写着"（没有补发）" | detail 字符串用了 `retry?.schemaName ?? '（没有补发）'`，而补发成功时 `schemaName` 恰好是 **null** → `??` 把它当"没有值" | 用 `retry ? … : '（没有补发）'` 显式判空。**断言通过 ≠ 说明文字是对的**：一条绿断言配一句反向说明会误导下一个读日志的人 |
| 断言按 `system` 分组找"同一条路的补发"，找错了路 | 被拒的那条请求（推荐）的 `system` 里没有稳定标记（`picks`/`id=` 都不挨着），被误判成"提示词那条路" | 改成按 `user` 内容分组——同一条路的补发就是同一份请求体去掉 schema，`user` 必然一致 |

### 回归测试

**新增 `tests/ai.pi.rules.test.ts`（12 条）**：工具声明（OpenAI `function` 包装 → pi-ai 平铺；形状不对要抛**能看懂**的错）、助手消息（工具参数 字符串→对象；usage/stopReason/provider/model 齐备；非法 JSON → 空对象）、工具结果（从助手消息按 id 找回 `toolName`；找不到给占位名）、system 不进消息列表、工具调用反向转换（对象→原始 JSON 字符串，下游按字符串解析）、失败分类（超时/HTTP/连接/正常）。

**新增 `tests/ai.retry.test.ts`（3 条）**：认得出网关那种拒绝（含截断措辞）；**认不出就别重试**（模型名写错、消息格式错、空详情一律不重试——否则拿用户额度反复试一个真问题）。

**反证（1 组）**：去掉补发 → 推荐与提示词双双 502，且那条断言变红。恢复后 29/29。

**注**：`pi-agent-core` **没有**引入（理由见 D-044 第 1 条：它是状态化 Agent + 自动工具循环，会把 `runToolLoop` 现有三道闸门搬进框架语义——那是行为改变）。所以本项目的"工具循环"仍是我们自己的代码，pi-ai 只负责"发消息、收正文与工具调用、重放历史（含思维链）"。

## R-037 推荐里的菜名点得进详情、返回时抽屉原样还在（D-045）（✅ 已验证，2026-10-13）

**改了哪些地方**：新增 `apps/mobile/src/stores/ai-suggest-session.ts`（这一场会话的状态：open / hint / picks / added / quickHints）；`apps/mobile/src/pages/discover/components/AiSuggestSheet.tsx` 的会话状态整体改用该 store，菜名换成 `<Link to={/recipes/:id} state={{from:'/discover'}}>`；`apps/mobile/src/pages/discover/DiscoverPage.tsx` 的 `suggestOpen/startSuggest/closeSuggest` 改用 store；`apps/mobile/src/pages/discover/discover.scss` 加 `.ai__pick-main` 链接样式。**后端一行未改。**

### 怎么验

```bash
# 1) 这个文件（21 条）
pnpm --dir apps/mobile exec vitest run src/pages/discover/components/ai-sheets.test.tsx; echo "exit=$?"   # 21/21

# 2) 全量前端与类型（tsc 必须带 -b，见 RISKS R-25）
pnpm --dir apps/mobile test; echo "exit=$?"                    # 291/291
pnpm --dir apps/mobile exec tsc -b; echo "exit=$?"             # exit 2，7 条既有错误（未新增，且都不在本轮改动文件里）

# 3) 浏览器真流程（前端 :5173、后端 :3000 都在跑）
#    发现页 → 点「AI 帮你想」→ 点一条快问 → 等推荐（真网关 10～20s）→ 点菜名 → 详情里点「← 返回发现」
#    → 断言：抽屉仍开着，菜名/理由/序号、输入框内容、快问那一排全部原样
```

### 实测结果（2026-10-13）

| 项 | 结果 |
| --- | --- |
| 新增用例 | **2 条**：① 「点菜名进详情，返回后抽屉还开着、推荐原样（会话状态活过路由跳转）」；② 「关掉抽屉再打开是干净的一次（点菜名那条路不背这个锅）」 |
| 这个文件 | **21/21**（改前 19/21 红） |
| 全量前端 | **291/291**（34 个文件；改前 289，本轮 +2） |
| 前端类型 | `tsc -b` **exit 2、7 条既有错误**（R-25 记录在案），本轮改动文件**零错误**——用 `grep -E "AiSuggestSheet\|ai-suggest-session\|DiscoverPage\|ai-sheets.test"` 核对过 |
| 反证 | 把推荐改回组件内 `useState`（**同一挂载期内照常工作**）→ 那条"返回后推荐原样"的断言精确变红：`Unable to find an element with the text: 番茄炒蛋`，红在**返回之后**那一步，且抽屉本身仍开着。恢复后 21/21。**这是真反证（断言红，非编译红）** |
| 浏览器（真网关） | 点开抽屉 → 5 条快问来自 AI → 点「来点辣的」→ **14s** 返回 4 道（红油大刀耳片 / 香辣魔芋 / 鱼香肉丝 / 西红柿黄瓜汤，各带理由）→ 点「红油大刀耳片」→ 详情页 URL `/recipes/jis-d49cd9e33196bfa063fb`、返回入口显示**「← 返回发现」**（说明 `from` 带到了）→ 点返回 → `/discover`，抽屉标题「AI 帮你想」在、4 道菜名+理由+序号 1~4 在、4 个「点这道」在、输入框仍是「来点辣的」、5 条快问原样 |
| 顺手修掉 | 测试文件里 4 处 `vi.useFakeTimers({shouldAdvanceTime:true})` → `freezeClock()`（只假 `Date`），见"踩过的坑"与 `RISKS.md` R-31；整文件耗时 1727ms → 865ms |

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 新用例红在 `ReferenceError: Toaster is not defined` | 新加的 `renderDiscoverWithDetail()` 渲染了 `<Toaster />`，而文件只导入了 `toast` | 补 `import { Toaster, toast } from '@/components/ui/toast'` |
| 断言 `Found multiple elements with the text: AI 帮你想` | 发现页那个**入口按钮**与**抽屉标题**文案相同，`findByText` 抓到两个 | 入口按钮改按角色查（`findByRole('button', {name: /AI 帮你想/})`），抽屉标题限定 `{ selector: '.sheet__title' }` |
| 「点菜名那条路」用例**单跑绿、连跑红**，红在 `.adm-mask` 是 `null` | 同文件前一条用例的 `vi.useFakeTimers()` **默认连 `requestAnimationFrame`/`performance` 一起打桩**，react-spring 帧循环停摆 → 抽屉永久停在 `translate(0,100%)`、遮罩（靠弹簧 `onStart` 挂载）永不出现 | 抽 `freezeClock()` = `useFakeTimers({toFake:['Date']})` + `setSystemTime`；**只假 Date**。详见 `RISKS.md` R-31 |
| 反证第一版**红早了**（红在导航前的 `findByText('番茄炒蛋')`） | 把 `picks` 换成 `useState(null)[0]` 连**同一挂载期内的写入**都没了，隔离不出"跨路由存活"这个性质 | 改成保留"同一挂载期照常工作"的最小改动（`useState` + `setLocalPicks` 在 `onSuccess`/`ask` 里照常调用），于是红的正好是返回之后那一步 |
| 浏览器点按钮连续两次超时（`Timeout waiting for locator .today__ai`） | 桥的 Playwright click 偶发挂起（`RISKS.md` R-026 同类）。现场核实过：按钮可见、`pointer-events: auto`、中心点命中的是它自己的子 `span`——**不是被遮挡** | 改走 `dom_cua.get_visible_dom()` 拿 ref 再 `dom_cua.click({node_id})`，一次成功 |
| 页内 `evaluate` 里写了 `as HTMLButtonElement` 报 `Unexpected identifier 'as'` | 传给页面上下文的是**纯 JS**，不是 TS | 页面上下文里的脚本一律写纯 JS（类型断言只留在测试源码里） |

### 回归测试

**新增 2 条**（`apps/mobile/src/pages/discover/components/ai-sheets.test.tsx`）：

1. **跨路由存活**：发现页 + 详情页探针（真 `<Routes>`），开抽屉 → 问一批 → 点菜名 → 落详情（并断言 `from` 是 `/discover`）→ 点返回 → 抽屉标题在、推荐与理由在、`useAiSuggestSession.getState().open === true`；
2. **关掉再开是干净一次**：点遮罩 → `open` 变 false 且 `picks` 被清 → 再点入口 → `open` 为 true 且旧推荐不在。

**反证（1 组）**：把 `picks` 改回组件内 `useState`（同一挂载期照常工作）→ 第 1 条在"返回之后"精确变红；恢复后 21/21。

**测试文件的两处配套改动**：① `beforeEach` 加 `useAiSuggestSession.getState().close()`——store 是**模块级**的，不重置会把上一条的推荐带进下一条（组件会误判自己"续上"、连 AI 那批都不去要），三条既有用例因此假红；② `freezeClock()` 取代 4 处默认全假的假定时器（见上表与 `RISKS.md` R-31）。

## R-038 「家人最爱」排版：每行都给名次 + 菜名理由同行（D-046）（✅ 已验证，2026-10-13）

**改了哪些地方**：`apps/mobile/src/pages/discover/components/FamilyPicks.tsx`（名次不再只给前三；撤掉 `.picks__body` 那层）；`apps/mobile/src/pages/discover/discover.scss`（`.picks__name` 加 `flex: 1 1 auto` + `min-width: 0`，`.picks__reason` 加 `flex: 0 0 auto`，删掉 `.picks__body` 规则）。**后端一行未改，数据口径一行未改。**

### 怎么验

```bash
pnpm --dir apps/mobile exec vitest run src/pages/discover/components/FamilyPicks.test.tsx; echo "exit=$?"   # 10/10
pnpm --dir apps/mobile test; echo "exit=$?"                    # 293/293
pnpm --dir apps/mobile exec tsc -b; echo "exit=$?"             # exit 2，7 条既有错误（R-25），本轮文件零错误
```

浏览器（391×844 与 320×844 各看一次）：`.picks__item` 每行都有 `.picks__rank`；各行的 `.picks__pic`、`.picks__name`、`.picks__reason` 的 **x 坐标各自一致**（即同一条竖线），且 `.picks__reason` 的右边缘不超出 `.picks__item`。

### 实测结果（2026-10-13）

| 项 | 结果 |
| --- | --- |
| 新增用例 | **2 条**：① 「每一行都有名次（不是只有前三名），第 4 行起也在**同一条竖线**上」；② 「菜名与理由在同一行里（菜名吃掉中间空档、理由贴行尾），不再上下两行留白」 |
| 这个文件 | **10/10**（改前 8 条） |
| 全量前端 | **293/293**（34 个文件；改前 291，本轮 +2） |
| 前端类型 | `tsc -b` **exit 2、7 条既有错误**，本轮两个文件（`FamilyPicks.tsx` / `discover.scss`）零错误 |
| 反证 ① | 名次恢复 `rank <= 3 && …` → 那条红：`expected [ '1','2','3','（缺名次）','（缺名次）' ] to deeply equal [ '1','2','3','4','5' ]`（缺的正是第 4、5 行）；恢复后 10/10 |
| 反证 ② | 菜名/理由包回 `.picks__body`（上下两行）→ 同行那条红：`expected <span class="picks__body">…(2)</span> to be <a class="picks__link" …(3)>…(2)</a>`；恢复后 10/10 |
| 浏览器几何（391×844，真数据 5 行） | 图片 x **全 64**、菜名 x **全 113**、理由 x **全 313**（行尾 359）；名次列宽 20px、图片 40px |
| 浏览器几何（320×844） | 菜名可用宽 120px，5 行菜名均不截断；理由 x **全 242**、不换行（高 <20px） |
| 最坏情况（390 与 320 各测） | 菜名「番茄土豆炖牛腩煲」+ 理由「做过 12 次 · 3 人收着」：391 下菜名 126px **不截断**、理由右边缘 355（< 行右 359）；320 下菜名压到 55px 才截断，理由仍在框内（截的是菜名，不是把理由挤出去） |

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 第 4 行起整体左移 28px | 名次是 `flex: 0 0 auto` 的**定宽列**，只给前三名时第 4 行没有这个占位块 | 每行都给名次；用"各行的图片/菜名 x 坐标是否一致"来量，而不是只看某一行 |
| 只给 `.picks__name` 加 `flex: 1` 还不够 | 原来是"名字/理由上下两行"，空档留在**列方向**：不撤掉 `.picks__body` 那层，怎么调 flex 右侧都还是空的 | 撤掉包裹层，让两者成为同一 flex 行的兄弟；断言直接盯"`.picks__body` 不存在 + 名字的下一个兄弟是理由" |
| jsdom 算不了布局 | 与 R-035 同一处境 | 守**决定布局的结构**（谁是谁的父/兄弟），真正的几何用浏览器当场量（上表两档宽度 + 最坏情况） |

### 回归测试

**新增 2 条**（`FamilyPicks.test.tsx`）：① 5 行数据下逐行读 `.picks__rank`，断言 `['1','2','3','4','5']`；② 断言 `.picks__name` 与 `.picks__reason` 的父节点都是 `a.picks__link`、`.picks__body` 不存在、且名字的下一个兄弟就是理由。

**反证（2 组，各自独立）**：见上表——两组都只让**对应的那一条**红，互不干扰。

## R-039 界面细节统一（D-047）（✅ 已验证，2026-10-13）

**改了哪些地方**：`pages/shared.scss`（`.today__shake, .today__ai` 公共规则加 `border: 1px solid transparent`，`.today__ai` 只改 `border-color`）；`pages/shopping/shopping.scss`（`.shop__check` 自绘 + `:focus-visible`，`.shop__from` 缩进 24→28px）；`pages/recipes/favorites/favorites.scss`（`.favorites__summary`/`.favorites__grid` 各带 `margin-inline`）；`pages/order/history/history.scss`（`__summary`/`__scope`/`__more-wrap` 各带 `margin-inline`）；四个测试文件加断言（含三斜线 node 类型引用）。**后端一行未改，纵向间距与配色未改。**

### 怎么验

```bash
pnpm --dir apps/mobile test; echo "exit=$?"           # 298/298
pnpm --dir apps/mobile exec tsc -b; echo "exit=$?"     # exit 2（既有错误从 7 降到 2）
```

浏览器（391×844）：发现页两个按钮 `width` 相等、缝的中点在卡片中线上；采购清单勾选框 `appearance: none`、20×20、圆角 5px，勾上是品牌色 + 白对勾；收藏页网格左右各 16px；**全站 12 页**的「标题文字起点 vs 首个内容块左边缘」delta 全为 0。

### 实测结果（2026-10-13）

| 项 | 结果 |
| --- | --- |
| 新增断言 | **8 条**：发现页 1（边框宽度一致 + 只准改颜色）、采购清单 2（自绘四要素；真 checkbox 仍在且勾选加 `is-packed`）、收藏页 1（摘要/网格各带边距、容器不得加横向 padding）、点单历史 1（三个裸块带边距、容器不得加 padding），加上配套的导入与三斜线引用 |
| 全量前端 | **298/298** |
| 前端类型 | `tsc -b` **exit 2、2 条**既有错误（`CombosPage.test` / `PrepPage.test`，与本轮无关）——**从 7 条降到 2 条**：新增的三斜线引用顺带修掉 `corner-art.test` 那 5 条 `node:fs`/`node:path`/`process` 错误 |
| 反证 | **四条各自精确变红**：① 公共规则去掉透明边框 → 发现页那条红；② 去掉 `appearance: none` → 勾选框那条红；③ 去掉 `.favorites-page` 的块边距…… 实测因**注释里照抄了写法而假绿**（见"踩过的坑"），剥注释后才真红；④ 历史页 `__scope` 改回 `margin: 0 0 10px` → 对齐那条红 |
| 按钮几何（391） | 修前 159 / 161（差 2px、缝偏左 1px）；修后四档宽度（320/360/391/414）**全部 `diff=0`、`gutterOffset=0`、`sameHeight=0`** |
| 全站对齐（391） | 12 个页面 delta 全 0：发现 16/16、订单 16/16、冰箱 16/16、我的 16/16、收藏 16/16、点单历史 16/16、采购清单 16/16、备菜计划 16/16、常用组合 16/16、打卡墙 16/16、家庭 16/16、菜谱 16/16 |
| 勾选框（采购清单） | `appearance: none`、20×20、`border-radius: 5px`、`border-width: 1.5px`、未勾 `rgb(255,251,242)`；第二行注释文字起点 59 == 菜名文字起点 59（缩进对齐） |
| 收藏页 | 网格 x=16、right=375（左右各 16），三张卡 x=16/201.5/16 |
| 点单历史 | `__summary`/`__day`/`__more-wrap`/`__end` 全部 x=16、宽 359（**`__end` 嵌在 `__more-wrap` 里，不能再给边距——给了就是 32，实测踩过**） |

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 样式断言**假绿** | 正则取到的块**含注释**，而注释里照抄了 `.card` 的写法 `margin: … var(--spacing-page) …` → 真 margin 改回贴边也照样匹配 | 断言前先剥注释；注释里不照抄被断言的写法 |
| `import css from './x.scss?raw'` 得到**空串** | scss 走 Sass 插件编译，`?raw` 在这条管线里不返回源文（探测：`typeof → 'string'`、`length → 0`） | 回到 `node:fs` 读文件；文件顶部加 `/// <reference types="node" />` |
| 给容器加 `padding-inline` 后**标题比正文多缩一格** | `.pscreen` 里的 `.ptitle`/`.psub` **自带** `padding-inline: var(--spacing-page)` —— 容器再加一层就是 32px | 改回本项目的既有约定：**横向边距由块自己带**（`.card` 就是这么写的）；并把"容器不得加横向 padding"写成断言 |
| 历史页 `__end` 缩进成 32px | 它嵌在 `.history__more-wrap` 内（两者二选一渲染），父子都给了边距 | 只给父级；断言名单里**去掉** `end` 并写明原因 |
| 给 `__scope` 之类的裸块加边距时先量到"没生效" | 量的是**元素盒子** x，而缩进写在 `padding-left` 上——文字起点才对得上 | 量文字用 `Range.selectNodeContents(firstChild).getBoundingClientRect()`，不看元素盒 |

### 回归测试

**新增 8 条**：`DiscoverPage.test.tsx` 1 条（两按钮边框宽度一致，且「AI 帮你想」只准改颜色、「摇一道」不得自带边框）；`ShoppingPage.test.tsx` 2 条（自绘四要素：`appearance: none` + 圆角 + SVG 对勾 + `:focus-visible`；真 `<input type="checkbox">` 仍在且勾选后父级带 `is-packed`）；`FavoritesPage.test.tsx` 1 条（摘要/网格各带 `margin-inline`、容器**不得**加横向 padding）；`HistoryPage.test.tsx` 1 条（三个裸块带 `margin-inline`、容器不得加 padding）+ 三个文件的导入与三斜线引用。

**反证（4 组）**：见上表——每组只让对应那一条红。

## R-040 菜谱小书标题上间距统一（D-048）（✅ 已验证，2026-10-13）

**改了哪些地方**：`apps/mobile/src/pages/recipes/recipes.scss` 的 `.recipes-heading h1`——`margin: 12px 0 8px` → `margin: 0 0 8px`。一个值。**其余样式、后端一行未改。**

### 怎么验

```bash
pnpm --dir apps/mobile exec vitest run src/pages/recipes/recipes.test.tsx; echo "exit=$?"   # 9/9
pnpm --dir apps/mobile test; echo "exit=$?"                    # 299/299
pnpm --dir apps/mobile exec tsc -b; echo "exit=$?"             # exit 2（2 条既有错误）
```

浏览器（391×844）：`/recipes` 首屏，量「`.page-back` 底边 → `h1` 顶边」应为 **0**（改前 12）。

### 实测结果（2026-10-13）

| 项 | 结果 |
| --- | --- |
| 改前（各页对照） | 菜谱页 **12px**；收藏页 / 点单历史 / 备菜计划 / 常用组合均为 **0px**（`h1` 是 `.recipes-heading` 里返回链接的兄弟） |
| 改后 | 菜谱页 **0px**；`h1` 顶边 y=53.5（改前 71.5，正是那 12px）；副标题与 h1 的间距仍 8px（未动） |
| 新增断言 | **1 条**：`.recipes-heading h1` 的上边距必须为 0（读 scss、先剥注释再匹配） |
| 全量前端 | **299/299** |
| 前端类型 | `tsc -b` exit 2、**2 条**既有错误（`CombosPage.test` / `PrepPage.test`），本轮未新增 |
| 反证 | 把 `margin` 改回 `12px 0 8px` → 那条红：`expected 'h1 { margin: 12px 0 8px; …' to match /margin\s*:\s*0\s/`；恢复后 9/9 |

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 第一轮在 1280×720 的桌面视口下量，看不出这 12px 的对比 | 桌面视口宽（`.recipes-page` 有 `max-width: 760px`），y 坐标与手机不同，且没有"别的页面"作参照 | 切到 391×844（与用户设备一致）并**逐页取同一组 y 坐标对照**，才定位到"只有本页多 12px" |

### 回归测试

**新增 1 条**（`recipes.test.tsx` 的「标题带」组）：读 `recipes.scss`、剥注释后断言 `h1` 的 `margin` 以 `0` 开头。**反证（1 组）**：改回 `12px` → 精确变红；恢复后 9/9。

## R-041 冰箱库存（M6：F6-01~F6-05）与底部抽屉的封顶 + 拖拽（D-050 / D-051）（✅ 已验证，2026-10-13）

**改了哪些地方**：

- **后端（新模块）**：`prisma/schema.prisma` 加 `FridgeItem`（+ `Family`/`User` 的反向关系）+ 迁移 `20261013034902_fridge_items`；新增 `src/modules/fridge/`（`fridge.rules.ts` / `fridge.service.ts` / `fridge.controller.ts` / `fridge.module.ts`）并挂进 `app.module.ts`；`tests/fridge.rules.test.ts`；`scripts/verify-fridge-http.cjs` + `package.json` 的 `test:http:fridge`。
- **前端**：新增 `api/fridge.ts`、`pages/fridge/ingredients.ts`（48 样预设）、`pages/fridge/components/FridgeStock.tsx`、`components/FridgeItemSheet.tsx`、`public/img/ingredients/`（48 张 PNG + README）；`FridgePage.tsx` 把原来的骨架整段换成真实库存；`pages/fridge/fridge.scss`。
- **抽屉（`components/ui/BottomSheet.tsx` + `ui.scss`）**：面板 `max-height: 88vh` + 新增 `.sheet__shell` 外壳（标题固定、内容自滚）；新增跟随手指下拖关闭（触摸与鼠标两入口共用一套判定）；拖关收尾**不清 transform**，改 `visibility: hidden`；外壳 ref 换成 `useCallback` 稳定身份。

### 怎么验

```bash
# 后端
cd services/api && pnpm run test; echo "exit=$?"            # 195/195
cd services/api && pnpm exec tsc --noEmit; echo "exit=$?"   # exit 0
docker compose build api && docker compose up -d --force-recreate api
# 容器里必须是刚建的镜像，且镜像里要有本轮代码的特征串（R-030 的教训：只看 "构建完成" 不算）
docker inspect --format '{{.Image}}' "$(docker compose ps -q api)"
docker images --no-trunc --format '{{.ID}} {{.Repository}}' | grep -m1 cook-api
docker exec "$(docker compose ps -q api)" sh -lc 'grep -rl "已经记了一条" dist/ | head -3'
docker compose exec -T api node scripts/verify-fridge-http.cjs; echo "exit=$?"   # 33/33

# 前端
pnpm --dir apps/mobile test; echo "exit=$?"                 # 321/321
pnpm --dir apps/mobile exec tsc -b; echo "exit=$?"          # exit 0（输出里仍有 2 条既有错误：CombosPage.test / PrepPage.test）
pnpm --dir apps/mobile run dev                              # http://127.0.0.1:5173/fridge
```

浏览器（391×844，也可 360×640 / 320×568）：

1. 冰箱页「＋ 记一样」→ 抽屉应**完整在屏内**（量 `.adm-popup-body` 的 `top >= 0`），内容区可滚（`.sheet__body` 的 `scrollHeight > clientHeight`），滚到底能点到「记进冰箱」；
2. 抽屉内 48 张预设图**都要真的加载出来**（`img.complete && naturalWidth > 0`，不看 DOM 有没有 `<img>`）；
3. 点「鸡蛋」→ 名字/一盒/冷藏自动填好、**不提交**；点「今天」→ 日期填成今天；提交后列表里出该条并带红色「今天到期」；
4. 拖抽屉往下：小幅拖（<110px）弹回、大幅拖（>110px）关闭；松手那一刻面板**不能露回顶部**。

### 实测结果（2026-10-13）

| 项 | 结果 |
| --- | --- |
| 后端单测 / 类型 | **195/195**；`tsc --noEmit` exit 0 |
| 镜像核实 | 容器镜像 ID == latest 镜像 ID；镜像内 `grep` 到本轮特征串（`dist/modules/fridge/fridge.service.js`） |
| HTTP 验收 | **33/33**：401/404、空板子、按区录入（含数量/保质期/备注）、重复录入 409、同名不同区允许、坏日期/坏区/空名 400、编辑（换区 + 清空数量成 null）、改名撞车 409、过期与临期标签、概览数字、`soon` 排序、共享关掉对他人的条目 403、删除、跨家庭隔离 |
| 前端全量 | **321/321**（冰箱页 17 条 + 录入抽屉 9 条 + 抽屉 6 条新增） |
| 前端类型 | `tsc -b` exit 0；仅 2 条既有错误（与本轮无关） |
| 48 张图 | 浏览器实测 48/48 **全部加载**（`naturalWidth` 非 0），单张 152×152、共 516KB |
| 抽屉封顶（三档屏） | 面板 top 101 / 77 / 68（屏高 844 / 640 / 568）——**全部在屏内**；内容可滚；滚到底「记进冰箱」底边 824 / 620 / 548，都在屏内 |
| 拖拽时间线（浏览器） | `translateY(80px)` → `translateY(160px)` →（松手）`translateY(100%)` → 500ms 后 `visibility: hidden`——**没有回到顶部那一下** |
| 冰箱完整流程 | 点「鸡蛋」填好 名字/一盒/冷藏 → 「今天」= 2026-10-13 → 列表出「鸡蛋 一盒 今天到期」（带红标、概览「有 1 样该先吃」）→ 点行改到「冷冻」并改数量「半盒」→ 改成过去日期显示「过期 2 天」→ 「拿出来了」删除后回到「冰箱还是空的」 |
| 搜索 | 「番茄」命中「西红柿」（别名）、「豆腐」按名命中、搜不到时说「常用食材里没有「…」——直接写在下面就行，一样的。」 |
| 反证（抽屉） | **9 组各自精确变红**：高度不封顶 / 外壳去掉 `min-height: 0` / 内容区不滚 / 拖多远都不关 / 不跟手（只在松手写一次）/ 去掉起手阈值 / 横划也抢 / 上划也抢 / 输入框里也拖；另加"回到先 `reset()` 再 `close()` 的老写法"（红在 `expected { visibility: '' } to deeply equal { visibility: 'hidden' }`） |
| 反证（冰箱） | **11 组各自精确变红**：空态那句话、每行预设图、`is-attention` 标记、未记保质期样数、别名命中、按别名搜索、空名可提交、保质期默认填、快捷按钮全按今天、成功不收起抽屉、失败也收起抽屉 |

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| **每个冰箱请求都 400**（`property name should not exist`） | 控制器用了 class DTO，而全局 `ValidationPipe` 是 `whitelist + forbidNonWhitelisted`；**没有 class-validator 装饰器的 class 会被整类剥空**，于是任何字段都"不该存在" | 本项目既有约定：控制器用**纯 interface**，校验写在 `*.rules.ts`；控制器里留了 ⚠️ 注释防复发 |
| 保质期**差一天**（存 10-15、读回来是今天） | 该列是 MySQL `DATE`（存 UTC 零点），而日期是本地时区构造的 | 统一用 `orders.rules` 的 `dateOnly`（`Date.UTC`）写、`dateKey`（`getUTC*`）读；`daysUntil` 也改成与"服务器本地日历今天"比 |
| 「今日先吃」里「过期 1 天」排在「过期 3 天」前面 | `soon` 直接用了过滤顺序，没排序 | 复用同一个 `order` 比较器（临期优先 → 有日期的按日期 → 没日期的 → 名字） |
| **抽屉内容顶出屏幕**（882px 内容 / 844px 屏） | 面板贴底放、**没有任何高度上限**，内容多高就顶多高（实测 `top` 为负） | `max-height: 88vh` + `.sheet__shell`（`min-height: 0`）+ `.sheet__body` 自滚 |
| 拖拽**完全没反应**，控制台无报错 | 抽屉内容是**弹簧跑起来之后**才挂到 DOM 上的，`useEffect` 里 `shellRef.current` 还是 null，而依赖 `shown` 不再变 → **监听永远挂不上**（R-031 同类） | 改用 **ref 回调**挂载手势（节点挂上/卸下各一次） |
| 松手后「**瞬间回到最高点再收回去**」 | 两个位移来源打架：`reset()` 清掉 inline 像素值的瞬间，弹簧那 **0%（=完全打开）** 的百分比值立刻生效 | 拖关收尾**不清 transform**，改 `visibility: hidden` 再走正常关闭 |
| 上面修完**还是**会弹回 | **内联箭头 ref** 在每次重渲染时被 React 当作新 ref：卸一次、挂一次，清理里的 `reset()` 又把面板露出来（`close()` 自己就触发重渲染） | 外壳 ref 换成 `useCallback` 稳定身份；并把"拖关不清样式"写成显式豁免 |
| 反证时"撤掉一层防护"却仍然绿 | 两层防护互相遮蔽（稳定 ref 与"不清样式"任一都能挡住症状），只撤一层看不出问题 | 反证要**撤到只剩一层**再验，或者干脆换回"整段老写法"验；最终用"回到先 reset 再 close"这组验到真红 |

### 回归测试

**前端新增 15 条**：`FridgePage.test.tsx` 8 条（空态与入口位置、四区与空格、顺序照接口、过期与临期分开、全过期不说"0 样快到期"、未记保质期样数、内置图 vs 中性占位、共享关掉的口径）+ 改造 2 条旧骨架断言为真数据断言；`FridgeItemSheet.test.tsx` 9 条（48 张图与名字一一对应、点预设填好不提交、别名与中性占位、搜名字/别名/搜不到、空名不能提交、保质期快捷且不默认填、提交的载荷与收尾、409 透传、编辑走 PATCH 与删除）；`bottom-sheet.test.tsx` 6 条（高度封顶、内容区自滚、拖够远关闭、拖不够弹回、三件"不抢"、输入框里不拖）。

**后端新增 10 条**（`fridge.rules.test.ts`）：四区、名字/数量/备注解析、保质期解析（含 2026-02-31 拒绝）、日历天算术、三种状态与文案、attention 边界、`toView`。

**反证**：冰箱 11 组、抽屉 9 组，逐组只让对应断言红；另对"拖关弹回"单独验了老写法会红。

## R-042 全局 AI 助手：对话里真的写冰箱 + 回执卡可撤 + 会话历史（D-053，F16-10）（✅ 已验证，2026-10-13）

**改了哪些地方**：

- **后端**
  - `prisma/schema.prisma` 加 `AiAction`（`familyId` / `actorId` / `kind` / `summary` / `undoData`(JSON) / `undoneAt` / `targetId`）+ 迁移 `20261013052525_ai_actions`；`User`/`Family` 加反向关系。
  - 新增 `src/modules/ai/ai-action.rules.ts`（**纯函数**：`planUndo` 四条判定、`readUndo` 只认形状、`removedItemKey`、`describeFridgeItem`、`undoLabel`）、`ai-action.service.ts`（走 `FridgeService` 写库 + 记 `AiAction` + `undo`/`recent`/`runPlan`）。
  - `ai.tools.ts` 加四个工具（`read_fridge`/`add_fridge_items`/`update_fridge_item`/`remove_fridge_item`、`FRIDGE_ADD_MAX = 8`）；`ai.service.ts` 注入两个服务、加 `receipts` 事件与四段工具执行、系统提示词按 A/B/C 分档重写；`ai.controller.ts` 加 `GET /ai/actions`、`POST /ai/actions/:id/undo`（**POST 不用 DELETE**：撤销可能是"重建"）。
  - `scripts/ai-stub-upstream.cjs` 加冰箱分支（照真实模型"先读再动"两轮）；`scripts/verify-ai-actions-http.cjs` + `package.json` 的 `test:http:ai-actions`。
- **前端**
  - 新增 `components/ai/AiAssistantBall.tsx`（悬浮球）、`AiAssistantSheet.tsx`（抽屉）、`AiReceiptCard.tsx`（回执卡 + 「撤」）、`ai-assistant.scss`；`stores/ai-assistant-session.ts`（多场会话 + `persist`）、`stores/ai-assistant.rules.ts`（`wireMessages`/`pruneTurns`/`conversationTitle`/`chatTimeLabel`）。
  - `layouts/TabLayout.tsx` 挂球与抽屉（**任意页都在**）；`api/ai.ts` 加 `AiReceipt`、`onReceipts` 事件分派、`useUndoAiAction`；`api/auth.ts` 的 `logout()` 里 `clearAll()`（隐私）。

### 怎么验

```bash
# 后端
cd services/api && pnpm run test; echo "exit=$?"            # 217/217
cd services/api && npx tsc --noEmit; echo "exit=$?"         # exit 0
docker compose build api && docker compose up -d --force-recreate api
docker inspect --format '{{.Image}}' "$(docker compose ps -q api)"   # 与 cook-api:latest 的 ID 相同
docker compose exec -T api grep -c removedItemKey /app/dist/modules/ai/ai-action.rules.js   # 新代码真的进镜像了

# HTTP 验收（走真路：/ai/chat/stream + stub 上游，不是造记录）
#   先把 stub 起在 18990，并让 API 指向它（.env 里是真实上游；这一行只覆盖本次容器）
node services/api/scripts/ai-stub-upstream.cjs 18990 &
AI_API_BASE=http://host.docker.internal:18990/v1 docker compose up -d --force-recreate api
cd services/api && pnpm run test:http:ai-actions; echo "exit=$?"   # 30/30

# ⚠️⚠️ 验收做完**必须复原**，并停掉 stub —— 这一步漏掉就是 2026-10-13 那次的真实故障：
#   容器还指着 stub，用户点开「问 AI」拿到的永远是那两句写死的台词（"我看看菜谱库里有什么。"），
#   看着像"AI 坏了/没接上"，其实是**验收环境没退干净**。
docker compose up -d --force-recreate api                   # 用 .env 里的真实上游重建
docker compose exec -T api printenv AI_API_BASE              # 必须等于 .env 里的 AI_API_BASE
pkill -f "ai-stub-upstream.cjs"                              # stub 只该在验收期间存在
# 再用真实请求确认一次（回答应当与问题相关、且带家庭上下文，而不是固定句子）
#   cd services/api && node -e '…POST /ai/chat {messages:[{role:"user",content:"肉怎么去腥？一句话"}]}…'
# **不要**在验收后"忘记复原"就交给用户：他手上那个界面是不会自己变回来的。

# 前端
pnpm --dir apps/mobile exec vitest run; echo "exit=$?"      # 347/347
pnpm --dir apps/mobile exec tsc -b; echo "exit=$?"          # 仅 2 条既有错误（CombosPage.test / PrepPage.test，与本轮无关）
pnpm --dir apps/mobile run dev                              # http://127.0.0.1:5173/fridge
```

浏览器（悬浮球在任意页右下角，让开 Tab 栏）：

1. 点悬浮球 → 抽屉里给三条**动作式**示例（"记一下冰箱里有酸奶"）；
2. 说一句"记一下冰箱里有苹果和豆腐" → 出现一句"正在看冰箱里有什么…"（不是干等光标）→ 回执卡列出**两笔**、每笔一个「撤掉」；
3. **抽屉不关**，底下的冰箱页就该多出这两样（缓存已作废）；
4. 点某一笔的「撤掉」→ 那行划掉并显示"已撤掉"、弹一句"已撤销：…"，冰箱页那条跟着消失；
5. 收起抽屉 → 切到别的 Tab → 再点悬浮球：对话、回执、按钮都还在；
6. **刷新整页**（F5）：对话与回执仍在（落盘），点「以前的对话」能看到多场、可翻回去、可单场删除。

### 实测结果（2026-10-13）

| 项 | 结果 |
| --- | --- |
| 后端单测 / 类型 | **217/217**；`tsc --noEmit` exit 0 |
| 镜像核实 | 容器镜像 ID == latest；镜像内 `removedItemKey` 出现 2 次（新代码确实进去了） |
| HTTP 验收 | **30/30**（真路）：普通问答不受影响；一句"记一下"真写库且**只回成功的那些**；批量里一条失败不带走另一条；唯一条约束仍守着；撤「增」→ 真删；撤「删」→ 按原样重建；**用户又自己记回来了 → 如实说"还在，没被删"**；撤「改」→ 写回原值且**不碰用户改过的另一个字段**；409 已经撤过 / 403 家里别人 / 403 别家 / 404 不存在 / 401 未登录 |
| 前端全量 | **347/347**（助手 20 条 + 会话规则 6 条为新增） |
| 前端类型 | 仅 2 条既有错误（与本轮无关） |
| **浏览器完整闭环** | 说"记一下冰箱里有苹果和豆腐" → 回执卡两笔 → 冰箱页**不刷新**就从 4 样变 6 样 → 再写"两盒鸡蛋" → 回执「撤掉」→ 点击 → 行划掉、toast「已撤销：鸡蛋 · 一盒 · 冷藏」、冰箱页回到 6 样（无鸡蛋） |
| **DB 与界面一致** | 查库确认：苹果/豆腐在、鸡蛋已删；`AiAction` 里 `fridge.create 鸡蛋` 的 `undoneAt` 非空 |
| 刷新持久化 | 刷新后冰箱页 6 样、`localStorage` 里 2 场对话；「以前的对话 · N」入口可翻旧账 |
| 悬浮球命中区 | 连测两次 `getBoundingClientRect` 完全相同（动画在内层，命中区静止） |
| 反证 | 前端 **6 组各自精确变红**：`undone:false` 也划掉 / 没回执也画卡 / 撤错那一笔 / 新对话把旧场也清掉 / logout 不清历史 / 回执不作废冰箱缓存；**后端 6 组**：`removedItemKey` 猜一个键、`wireMessages` 不截断、`pruneTurns` 不剪空格（规则层与组件层各验一次）、不落盘、`planUndo` 各分支 |

### 踩过的坑

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| **不管问什么都答同一句**（"我看看菜谱库里有什么。我看看菜谱库里有什么。今晚就这两道吧…"），没报错、配置也没动过 | **验收环境没退干净**：为了走 stub 验收，容器被临时覆盖了 `AI_API_BASE` 指向本地 stub，验收后没复原——真实模型一次都没被调用过 | 先 `docker compose exec -T api printenv AI_API_BASE` 核对；复原见上面"验收做完必须复原"那块（重建 + 核对 + 停 stub + 真请求复验）。**症状一眼可辨**：stub 是固定台词，真实回答一定与问题相关 |
| 让它"把牛奶拿掉"，**删掉的却是苹果**，牛奶还在冰箱里 | stub 从工具结果里取 id 用了 `[^\n]*`——而工具结果是 `JSON.stringify` 过的，`\n` 是**两个字符**不是换行，正则一路跨过好几条记录 + 贪婪量词取到**最后一条** | 先 `JSON.parse` 解开那层 JSON，再按行找名字**完全相等**的；并加了反证证明旧写法确实取到苹果 |
| "那条又回来了时撤销" → 用户看到「已经记了一条，直接改它就行」 | 撤「删除」时按 `targetId` 查现状，而那个 id 就是**被删掉那条**、必然查不到 → "用户又记回来了"的分支永远走不到，撤销照重建走、撞唯一约束 | 撤「删除」改按**同名同区**查（与唯一约束同一个键）；补 `removedItemKey` 纯函数与回归测试 |
| 单测全绿但用户点「撤」是坏的 | 纯函数两边都用假数据（规则没错，**喂给它的现状错了**） | 所以有 `verify-ai-actions-http.cjs` 走真路；这正是不只写单测的理由 |
| AI 说"记好了"、库里有，**冰箱页却没变** | react-query 的 `staleTime: 30s`：写入是真的，但页面那份缓存以为自己是新的 | 收到 `receipts` 时 `invalidateQueries(['fridge'])`；补了一条带 `useFridge` 探针的回归测试（数它取了几次） |
| 发出去的消息 **11 条**（后端上限 10） | 写成"截十条历史 + 追加这一句" | 新问的这句**一起过筛**（同一个 `wireMessages`）；单测算出 11 条抓红 |
| 浏览器**点不到悬浮球**（Playwright 等 not-stable 超时） | 起伏动画套在**按钮**上 → bounding box 永远在动 | 动画挪到内层 `.ai-ball__inner`，命中区静止；顺带这是真实可用性问题（拇指落点会飘） |
| 抽屉里的按钮全点不动（Playwright） | 后台标签页 rAF 不跑 → antd-mobile 弹簧永远"不稳定"（已知环境事实，非产品 bug） | 验收用页内真实 DOM `click()`，按**结果**（回执/DB/列表）判定，不按"点击返回成功" |
| `logout` 不清 AI 历史 | 首版没连起来 | 显式 `clearAll()` + 一条测试（对话里有这家冰箱的内容，换个人登录就看见别人家里有什么） |

### 回归测试

**后端新增 20 条**：`ai.actions.test.ts` 19（`planUndo` 四种 kind × 三种意外、`removedItemKey` 六种坏形状、`describeFridgeItem`、`undoLabel`）+ `ai.tools.test.ts` 改造（按名断言四个工具都在、写工具的描述必须说"会真的写库"）。
**前端新增 26 条**：`ai-assistant.test.tsx` 20（回执卡是证据 / 没回执不画卡 / 撤对那一笔 / 划掉留着 / `undone:false` 照实说 / 409 透传 / 跨页 / 跨刷新 / 新对话留旧场 / 翻回旧场 / 剪空格 / 十条上限 / 删单场 / logout / 只发 id / 缓存作废 / B 档没被带跑 / 失败留住用户那句）+ `ai-assistant.rules.test.ts` 6。

**反证**：后端 6 组、前端 6 组，逐组精确变红（清单见上表）。

## R-043 AI 覆盖全应用 CRUD + 自建菜谱（D-054：F1-11 / F1-12 / F16-10 扩展）（✅ 已验证，2026-10-13）

**改了哪些地方**：

- **后端 · 自建菜谱（F1-11 / F1-12）**
  - `prisma/schema.prisma`：`Recipe` 加 `familyId`（**null = 全局库**）与 `createdById`；迁移 `20261013063836_user_recipes`。
  - 新增 `recipe.rules.ts`（**纯函数**：`canWriteRecipe` / `writeRefusal` / `parseRecipeCreate` / `parseRecipePatch` / `buildSearchText` / `sourceLabel`）、`recipe-write.service.ts`（create/update/remove/**restore**，只对自家自建放行）、`optional-auth.guard.ts`（带令牌就挂 userId、没带/过期当匿名**不抛错**——公共读不能因为没登录就挂）。
  - `builtin-recipe.provider.ts`：`visibility`（匿名只看全局库；登录后全局库 + 自家）、`summary` 下发 `origin`/`sourceLabel`/`mine`、排序 `familyId desc`（自己家的排最前）、**详情也做可见性检查**（防越权）。
  - `recipes.controller.ts`：读接口 `OptionalAuthGuard`，POST/PATCH/DELETE 走 `JwtAuthGuard` + `RecipeWriteService`。
- **后端 · AI 十二个新工具（D-054 第一节那张表）**
  - `ai.tools.ts` 加声明与解析器（`readMenuAdds` / `readDiners` / `readMealStatus` / `readMealTarget` / `readComboDraft` / `menuText` / `comboText`）。
  - `ai-action.rules.ts` 加七个 kind、`MenuOrderSnapshot`/`ComboSnapshot` 等上下文、`planUndo` 的菜单与组合分支、`menuUndoTarget`（纯函数）、`undoLabel`（**状态流转回空串 = 不可撤**）、`actionKindLabel`。
  - `ai-action.service.ts` 加 `addMenuItems` / `removeMenuItem` / `setDiners` / `setMealStatus` / `repeatMeal` / `createCombo` / `updateCombo` / `removeCombo` / `addComboToMeal`（**全走用户自己那套服务**，不另写写入逻辑）。
  - `combos.service.ts` 加 `restore`（撤销"删组合"）；`combos.module.ts` 导出服务；`ai.module.ts` 引 `OrdersModule` / `CombosModule`；`ai.service.ts` 加 12 段工具执行 + `menuRows` + 提示词改写。
- **前端**
  - 新增 `pages/recipes/MyRecipesPage.tsx`（`mine=1` 列表 + 空态引导）、`RecipeFormPage.tsx`（新建/编辑共用；**只发改过的字段**；删除走 ConfirmDialog）、`components/RecipeOriginBadge.tsx`（来源徽标）；`RecipeDetailPage` 显示来源与上传人、`mine` 时才给编辑/删除；`DishCard` 带徽标；`MinePage` 加「我的菜谱」入口；路由加 `/recipes/mine`、`/recipes/new`、`/recipes/:id/edit`。
  - `api/recipes.ts`：类型补 `origin`/`sourceLabel`/`mine`/`createdBy`，加 `create/update/delete` 与三个 mutation hook。
  - `api/ai.ts` 加 **`invalidateAfterAiWrite`**（六个域的缓存作废，回执与撤销共用）；`AiAssistantSheet` 的回执处理改调它（**修掉用户报的"AI 加完菜谱列表不刷新"**）；`AiReceiptCard` 见 `label === ''` 不画「撤」。

### 怎么验

```bash
# 后端
cd services/api && pnpm run test; echo "exit=$?"            # 268/268
cd services/api && npx tsc --noEmit; echo "exit=$?"         # exit 0
docker compose build api && docker compose up -d --force-recreate api
docker inspect --format '{{.Image}}' "$(docker compose ps -q api)"   # 与 cook-api:latest 相同
docker compose exec -T api grep -c restoreMenuItem /app/dist/modules/ai/ai-action.service.js

# HTTP 验收（真路：/ai/chat/stream + stub；先把 stub 起在 18990 并让容器指向它，见 R-042 的同一段）
cd services/api && pnpm run test:http:ai-actions; echo "exit=$?"   # **55/55**
# ⚠️ 做完照 R-042 的三步复原：容器重建回 .env 的上游、printenv 核对、pkill stub，并用真实请求确认一次

# 自建菜谱的接口（可脱离 AI 单独验）
# 登录后：POST /recipes（建）、PATCH /recipes/:id（只改传了的字段）、DELETE /recipes/:id
#        GET /recipes?mine=1（只看自家）、GET /recipes/:id（别人家的自建 → 404）

# 前端
pnpm --dir apps/mobile run test; echo "exit=$?"             # 385/385
pnpm --dir apps/mobile run typecheck; echo "exit=$?"        # 仅 2 条既有错误（CombosPage/PrepPage 测试，与本轮无关）
```

### 本轮抓到的三个真问题（都只有真机/真模型能撞出来）

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| **撤"AI 新建的菜谱"永远被拒**，提示"这道你自己改过了" | `recipeTouched` 拿**整份 `undoData`** 去比菜谱快照，而 `undoData` 里有个 `recipeId` 键——快照里当然找不到它，于是每次都判成"改过"。**单测全绿**（没有一条用 service 真写的形状当夹具） | 比 `undo.after`（那份快照）；`RecipeCreateUndo` 补上 `after` 字段把真相写进类型；补两条**用真实形状**当夹具的测试，并做了反证（改回去 → 恰好那两条红） |
| **在我的菜谱页用 AI 加完菜谱，背后列表不刷新**（用户反馈） | 回执处理只作废了 `['fridge']`（D-053 时代只有冰箱）；AI 现在能写六块 | 作废清单收成 `invalidateAfterAiWrite` 一处、两条路共用；补一条带 `useRecipes` 探针的回归测试（**数它真取了几次**，不断言"调了 invalidate"） |
| 验收里明说"今天午餐"却被加到**晚餐**；撤菜撤到了别的餐 | stub（扮演模型）把日期/餐次写死、并按正则第一个匹配取餐次 | stub 里补齐"从用户那句话里理解日期/餐次"的解析（`menuDateForStub` / `parseMenuForStub` / 目标餐次取句尾那个词）；**产品侧无改动**——这是验收脚手架不够真 |

> 这一轮最有价值的一条经验：**单测用自编的假数据，是会把"形状不匹配"这类 bug 全放过去的**。凡涉及"写进去的东西要被另一段代码读回来"（`undoData`、工具结果文本、接口下发字段），夹具必须逐字段抄自真实写入点，或者干脆走真路验收。

**回归测试**：后端由 218 → **268**（新增 `ai.menu.actions.test.ts` 42 条：菜单/餐次/组合的撤销判定、`menuUndoTarget`、`menuText`/`comboText`、五个解析器；`ai.actions.test.ts` 补 10 条：**用 service 真写的形状**验菜谱三件与收藏）。
**前端由 347 → 385**（子代理交付 37 条 + 我补的缓存回归 1 条）。
**反证**：后端本轮做了三组——四处撤销门槛（状态/归属/人数/定局）逐个失效 → 恰好 5 条红且不误伤；`recipeTouched` 改回旧写法 → 恰好 2 条红；前端缓存清单换回"只有冰箱" → 恰好 1 条红（新加那条）。

### 验收在开发库里留下了什么（清点命令）

验收脚本与浏览器实证会**真的建账号、建家庭、写库**——这些行不会自动消失。清点（根密码在仓库根 `.env`，**不要打进文档或对话**）：

```bash
cd /Users/aihf/Downloads/work/cook && PW="$(grep '^MYSQL_ROOT_PASSWORD=' .env | sed 's/^MYSQL_ROOT_PASSWORD=//' | tr -d '"')"
docker exec cook-mysql-1 mysql -uroot -p"$PW" --default-character-set=utf8mb4 -t -e "
SELECT '家庭' 项, COUNT(*) 数 FROM cook.Family UNION ALL SELECT '账号', COUNT(*) FROM cook.User
UNION ALL SELECT '点单', COUNT(*) FROM cook.OrderItem UNION ALL SELECT '餐次', COUNT(*) FROM cook.MealOrder
UNION ALL SELECT '冰箱', COUNT(*) FROM cook.FridgeItem UNION ALL SELECT 'AI操作', COUNT(*) FROM cook.AiAction
UNION ALL SELECT '打卡', COUNT(*) FROM cook.CheckIn UNION ALL SELECT '组合', COUNT(*) FROM cook.Combo
UNION ALL SELECT '收藏', COUNT(*) FROM cook.Favorite UNION ALL SELECT '自建菜谱', COUNT(*) FROM cook.Recipe WHERE origin='user';"
# 落在哪些家庭（看冰箱最直观）：
docker exec cook-mysql-1 mysql -uroot -p"$PW" --default-character-set=utf8mb4 -t -e "
SELECT f.name 家, COUNT(*) 条 FROM cook.FridgeItem i JOIN cook.Family f ON f.id=i.familyId GROUP BY f.id;"
```

**结论（2026-10-13 清点）**：213 家庭 / 487 账号 / 496 点单 / 350 餐次 / 83 冰箱 / 168 条 AI 操作 / 62 打卡 / 10 组合 / 17 收藏 / 1 道自建菜谱。**全部落在脚本与浏览器实证自建的家庭里**（脚本：`AI 验收家` / `点单验收家` / `冰箱验收之家` / `组合验收家` / `最爱验收家`；浏览器：`小满一家`、账号 `uimama87722824`/`uibaba87722824`、`uimama87756154`/`uibaba87756154`——后者的 6 条冰箱与那道「外婆的红烧肉」就是浏览器实证留下的），**唯一非测试账号 `mama_20261012`（小艾的家）名下一条没有**。所有查询都按 `familyId` 隔离，正常登录看不到这些，放着不影响使用，只影响开发库体积。清理属**不可逆操作**，须用户明确授权后再动。

## R-044 自建菜谱配图 + 全家共享 + 返回链（D-055；含一条隐私 bug 的处置）（✅ 已验证，2026-10-13）

**改了哪些地方**：

- **前端 · 卡片布局（`kitchen/kitchen.scss`、`kitchen/components/DishCard.tsx`）**
  - `.dish-card` 改**列向 flex**；`.dish-card__link` 从 `height: 100%`（**就是它把「点这道」裁掉了**）改成 `flex: 1`；`.dish-card__pic { flex: none }`。
  - 删掉 `.dish-card__name { min-height: 36px }`；`.dish-card__calories` 带 `margin-bottom`，`.dish-card__body` 的 `padding-bottom` 归零。
  - 「看做法」从卡片里挪出来，做成独立 `<Link>`（带同样的 state），与「点这道」并排进 `.dish-card__actions`。
- **前端 · 我的菜谱页（`recipes/recipes.scss`）**：`.my-recipes .recipes-grid / .recipe-status` 补 `margin: 16px var(--spacing-page) 0`（原来网格没有栏距，卡片贴着屏幕边）。
- **前端 · 详情页（`recipes/recipes.scss`）**：`.recipe-detail__heading` 改列向 flex + `gap: 12px`，子元素 margin 归零（原来 12/10/0/14 不匀）。
- **前端 · 选词（新 `recipes/components/SuggestField.tsx`、`RecipeFormPage.tsx`、`recipes.scss`）**：品类/菜系去掉原生 `datalist`，改成输入框 + 可点小词（常用词 + 库里实际值，上限 12）；两个字段上下各一行。
- **前端 · 配图（`RecipeFormPage.tsx`、`api/recipes.ts`、`recipes.scss`）**：新增配图那一格（预览框 + 「选一张图/换一张」+「不用这张」）；选图走 `shrinkImage`（与打卡同一套 1600px/JPEG 0.85）；`RecipeDraft.image` 是**只在换图时才带**的可选字段。
- **前端 · 返回链（`pages/back-link.ts`、`RecipeDetailPage.tsx`）**：新增 `readCarry`；详情页的「编辑」把当前 state 塞进 `carry` 交给编辑页，编辑页回详情时原样交还（返回按钮与保存后跳转两处都带）。`labelFor` 让编辑页显示「返回这道菜谱」而不是干巴巴「返回」；新建完跳详情带 `from: '/recipes/mine'`。
- **后端 · 配图（`recipes/recipe-write.service.ts`、`recipe.rules.ts`、新 `media/image.rules.ts`）**：`storeImage` 把 dataURL 存进**公开桶**（内容哈希命名）；`parseRecipePatch` 加 `allowEmpty`（只换图也算有效改动）；写操作返回补 `mine`。
- **后端 · 隐私（`recipe.rules.ts`、`builtin-recipe.provider.ts`）**：`canWriteRecipe` 加 `createdById` 判据、新增 `canReadRecipe`；列表可见性条件补"个人菜谱（familyId 空 + createdById 我）"，详情改用同一个 `canReadRecipe`。
- **后端 · AI 撤销**：`RecipeRemoveUndo.recipe` 补 `image/imageKey/imageHash/imageStoredAt`，`ai-action.service` 删除时一并快照，`restore` 写回（撤"AI 删菜谱"后照片还在）。
- **测试**：新增 `tests/recipe.rules.test.ts`（14 条：三种归属 × 四种身份的读/写判据、字段解析、搜索文本、来源标签）；`RecipeFormPage.test.tsx` 补 6 条（配图三条 + 建议词两条 + 自由输入一条）；`back-link.test.ts` 补 2 条（carry 与原样读回）。

### 怎么验

```bash
# 后端
cd services/api && pnpm run test; echo "exit=$?"            # 282/282
cd services/api && npx tsc --noEmit; echo "exit=$?"         # exit 0
docker compose build api && docker compose up -d --force-recreate api
docker inspect --format '{{.Image}}' "$(docker compose ps -q api)"   # 与 cook-api:latest 相同
docker compose exec -T api grep -c canReadRecipe /app/dist/modules/recipes/recipe.rules.js

# HTTP 验收（真接口 + 真 MinIO；不需要 stub）
pnpm --dir services/api run test:http:recipe-image; echo "exit=$?"     # **14/14**（配图：存取/假图被拒/只换图/越权）
pnpm --dir services/api run test:http:recipe-sharing; echo "exit=$?"   # **9/9**（建第二个家庭成员，验"全家共享"）

# 前端
pnpm --dir apps/mobile run test; echo "exit=$?"             # 394/394
pnpm --dir apps/mobile run typecheck; echo "exit=$?"        # 仅 2 条既有错误（CombosPage/PrepPage 测试，与本轮无关）
```

**隐私 bug 的手工探针**（想再确认一次时直接用；脚本已在仓库里，`verify-recipe-sharing` 覆盖了其中的正路）：

```bash
# 注册一个不建家庭的账号 → 建一道菜 → 自己改（应 200）→ 陌生人与未登录看它（都应 404）
node -e "..."   # 见本轮处置记录；核心是 GET /recipes/<id> 应回 404 而不是 200
```

### 本轮抓到的真问题

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| **「点这道」按钮从来没显示过**（用户报"卡片下面空白大"） | `.dish-card__link { height: 100% }` 独占整卡高度，把同级按钮挤出卡外，被 `overflow: hidden` 切掉 | 改列向 flex，链接 `flex: 1`；同时去掉 `min-height` 让菜名下的空隙消失 |
| **没加入家庭的用户建的自建菜谱漏给所有人看、他自己却改不了** | 读/写判据只判 `familyId`，而"个人菜谱"的 `familyId` 也是 null，被当成公共菜谱 | 判据补 `createdById`（三种归属），读/写共用一对函数；列表条件与详情都改 |
| 我的菜谱 → 详情 → 编辑 → 返回详情 → 再返回落到菜谱小书 | 详情页的「编辑」没把来源带下去，链条断了 | 新增 `readCarry`，中间页收着再交还 |

> **这一轮最值得记的一条**：`canWriteRecipe` / 可见性这两条判据此前**一条单测都没有**，所以那个隐私 bug 从交付起就存在、一路走到"我想到去试一下没家庭的情况"才被发现。**权限判据没有测试，等于没有实现**——它的错误永远不会以"报错"的形式出现，只会静静地少拦一个人。

**回归测试**：后端 268 → **282**（新增 `recipe.rules.test.ts` 14 条）；前端 385 → **394**（`RecipeFormPage` +6、`back-link` +2、`DishCard` 相关结构未改断言）。
**反证**：两组——还原旧的读/写判据 → **恰好 2 条红**（两条"个人菜谱"用例），不误伤；把配图从 payload 里去掉 → **恰好 2 条红**（两条配图用例）。

## R-045 AI 看图：对话图片附件 + 冰箱拍照识别（D-056：F16-05 / F16-04）（✅ 已验证，2026-10-13）

### 起手要看的前提

```bash
# ① 模型真的看得见图吗（先验前提——不成立的话后面全白做）
#    同一句话问两次：带图应答得出来、不带图应明说"没看到图片"
# ② 变量名别记错：是 AI_API_BASE（不是 AI_BASE_URL），另有 AI_MODEL / AI_API_KEY
docker compose exec api sh -c 'echo $AI_API_BASE $AI_MODEL'
```

### 两条真模型验收（**都要花钱、都要等**，但这是唯一能证明"图真到了它眼前"的办法）

```bash
cd services/api
pnpm run test:http:ai-vision     # 10 项：上传/去重/假冒图片/字节一致/跨家 404/带图问答
pnpm run test:http:fridge-scan   # 12 项：草稿形状/ **不写库** /描述不进数量备注/认不出不乱写/看图后仍能调工具
```

**`verify-fridge-scan-http.cjs` 里两个刻意的设计**（改动它之前先读这段）：

- **用它自己画的两张 PNG**：一张"有食材"（番茄 + 一板鸡蛋 + 一把葱，用 `groceriesPng()` 手搓）、一张纯色块。前者用来验"认出东西之后"的每一条断言，后者用来验"认不出时一样都不写"。
  **为什么必须两张**：只有纯色块时模型会老老实实答"认不出"，`items` 是空数组——而"每条名字非空、区在四区之内"这类断言在**空数组上必然通过**，看着绿其实什么都没验（本次自查发现的盲区，已经因此改过一轮：第一次写错了 attachmentId，用纯色块去跑"有食材"那一段，12 项里红了一项才发现）。
- **`callRetry` 只重试 5xx**（最多三次、退避 2.5s / 5s）：上游偶发 502 会让验收自己红（见 RISKS R-41），而"红不再意味着代码坏了"是最坏的结果。**400/403/429 一律原样冒出来**，不重试。

### 手工探针：识别结果里有没有混进外观描述

```bash
# 用一张真有食材的图跑一遍，打印 items（看 amount/note）
node /tmp/probe-notes.cjs   # 本轮用过的临时脚本；要点是 amount 只该有"三个/6枚"这种
```

**判据**：`amount` 里该只有数目与单位；`note` 里该只有包装上读得到的字。出现「灰色蛋托中可见六枚」这种就是在描述外观——**那是静默入库的通道**（界面上原来不显示备注），提示词与界面两处都要堵。

### 前端两条交互的验收点

```bash
pnpm --dir apps/mobile run dev      # :5173
pnpm --dir apps/mobile run test     # 425 条
```

1. **AI 助手发图**：点悬浮球 → 点「＋」→ 出现「拍一张 / 从相册选」两颗（`#ai-attachment-camera` 带 `capture="environment"`、`#ai-attachment-album` 不带）→ 选一张 → 待发缩略图出现 → 一个字不打直接点「说」也能发（**只有图的消息不能丢**）。
2. **点图看大图**：点对话里的缩略图 → 全屏层出现（`z-index: 1100` 高过 antd-mobile 的 Popup 1010；**父节点必须是 `body`**——留在抽屉里会被面板的 `transform` 关成半屏）→ 点哪儿都关。
3. **刷新后图还在**：F5 → 重开抽屉 → 那一轮的文字与图都还在（图是**按 id 重新取的**，不是落盘的 base64；`performance.getEntriesByType('resource')` 里能看到 `/ai/attachments/<id>/photo`）。
4. **冰箱拍照入库**：冰箱页 → 「📷 拍照」→ 两个入口 → 选图 → 等识别 → **先核对清单**（名字/数量/备注/区都能改，"猜的"那个标记要看得见）→ 点「都记进去」→ 面板收起、冰箱页出现新条目。

### 本轮实测的关键数字（浏览器，真实后端 + 真模型）

| 验的是什么 | 证据 |
| --- | --- |
| 模型真看得见图 | 喂一张自画的"冰箱照"（3 蛋 + 2 番茄 + 牛奶 + 酸奶标签）→ 答「图里是 4 样：3 个鸡蛋、2 个西红柿、1 盒牛奶、2 盒酸奶」 |
| 「＋」居中修好了 | 按钮中心 `(35, 814.26)` 与图标中心 **坐标完全相同**（修前：全角 `＋` 的墨迹偏左 3.7px、偏下 2.7px） |
| 两个来源入口各自绑对控件 | `#ai-attachment-camera` 有 `capture="environment"`、`#ai-attachment-album` 为 null；label 的 `for` 一一对应 |
| 刷新后图还在 | 重载后 `turnCount=8`、`imageCount=1`、`naturalWidth=1024`、`missingCount=0`，且 `resource` 里有一次新的 `/ai/attachments/.../photo` |
| 全屏层是全屏 | 视口 391×844 下 `.photo-viewer` 也是 391×844、`zIndex=1100`、`parentElement === document.body`、`body.overflow=hidden` |
| OCR 认完**没写库** | 识别出三条（番茄/鸡蛋/小葱）后面板仍停在 review；点了「都记进去」冰箱才从 6 → 8（冷藏）与 0 → 1（常温） |
| 静默通道已堵 | 同一张"有食材"的图重跑：`amount` = 「三个」/「6枚」、`note` = null（改前是「灰色蛋托中可见六枚」） |

### 本轮抓到的真问题

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| **用户报**：「这个加号没有居中」 | 文字 `＋`（U+FF0B）墨迹不在字形框中心，实测偏左 3.7px、偏下 2.7px | 换 `PlusIcon` 矢量描边图形 |
| **用户报**：「叉号没有居中」 | 文字 `×`（U+00D7）同理，实测偏下 3.4px | 换 `CloseIcon`；三处（全屏/待发区/冰箱清单）一起换 |
| **用户报**：「图片需要能点击全屏看」 | 原先是 `<a target="_blank">`——打包成 App 后没有新标签页，点了等于没反应 | 应用内全屏层（portal 到 body、点哪儿都关、打开时锁滚动） |
| **用户报**：「需要能拍照或者从相册选两种」 | 只有一个 `accept="image/*"` 时进相机还是进相册由系统决定，部分安卓 WebView 只进相册 | 抽 `PhotoSource` 两个控件两入口（带/不带 `capture`） |
| **我自己改出来的回归**：每问一句就把之前的对话冲掉 | `beginTurn` 里漏了 `...active.turns`（只在加附件参数时手误删掉） | 补回并在源码里留 ⚠️ 注释；**现有用例「发给模型的只有最近十条」当场抓到**（期望 12 条实际 2 条） |
| **模型把外观描述塞进备注** | 备注在审核界面不显示 → 静默入库 | 提示词收紧（数量只写数目单位、备注只写包装上的字）+ 界面把备注摆出来能改 |
| 验收脚本"绿得侥幸" | 纯色块让 `items=[]`，"每条名字非空"在空数组上必然通过 | 加一张能认出来的图，并补一条"这条草稿里每一条都有名字"（`length > 0`） |
| 验收脚本自己会红 | 上游偶发 502 | `callRetry` 只重试 5xx（见 RISKS R-41） |

> **这一轮最值得记的一条**：`beginTurn` 那个 `...active.turns` 漏得毫无痕迹——它不会报错，只会让"聊到第三句它就不记得第一句了"，而**抽屉里也只剩最后一句**。抓到它的是**已有的**那条条数断言。这正是单测值的钱：手改一行、五秒钟发现，而不是等用户用两天后说一句"它好像有点健忘"。

**回归测试**：后端 282（不变，本轮未加后端单测）；前端 394 → **425**（`ai-attachment` +12、`fridge-scan` +10、`photo-source` +6、`ai-assistant.rules` +3）。
**反证三组**：① 改坏 `wireMessages`（只看文字）+ 禁掉"只有图也能发" → **恰好 5 条红**；② 让识别完立刻入库 + 一条失败就整批不留 → **恰好 5 条红**；③ 把全屏层换回 `<a target="_blank">` → **恰好 3 条红**。

## R-046 口味与健康档案（D-057：F8-01 / F8-02 + F5-03 过滤 + F3-08 提醒）（✅ 已验证，2026-10-13）

### 验收脚本

```bash
cd services/api
pnpm run test:http:taste     # 22 项：档案读写/部分更新/全家视角/点菜提醒/推荐过滤（含真模型）
```

**三条最容易写错的断言，改脚本前先读**：

- **「菜名里有'鱼'但配料里没有鱼 → 不提醒」**：这一条是判据的核心（鱼香汁那种味型）。写成"不提醒"之前它先红过一次——第一版实现按子串匹配，把「鱼香大虾」的「鱼香汁」当成了鱼。修法是 `DECEPTIVE_COMPOUNDS`（见 taste.rules）。
- **「提醒按全家算，不按点菜那个人」**：爸爸（没写档案）点含花生的菜**仍要**收到"妈妈过敏"的提醒。这条我最初写反了（写成"爸爸不该收到"），跑出来才发现是测试错了、代码是对的。
- **「一个人都没写过档案时，一句提醒都没有」**：这条要**单独建一个空档案的家**才能验——上面那个家里妈妈写过，验不出"不假装有保护"。

`callRetry` 同时处理 429（全局限流 60/分，连跑两遍会自己打到自己）与上游 5xx（见 R-41）。

### 手工探针

```bash
# 有档案的人：看 AI 推荐里有没有他过敏的东西
# 判据在服务端，所以最直接的办法是跑上面那条验收（它会逐条回查配料表）
```

### 本轮实测的关键证据

| 验的是什么 | 证据 |
| --- | --- |
| 判据只看配料表 | 鱼香大虾（配料含"鱼香汁"）对鱼过敏者**不提醒**；真含鱼的菜照样拦 |
| 推荐过滤真的生效 | 妈妈过敏「花生、虾」时推荐 5 道，逐条回查配料表**零命中**；反证（去掉过滤）后模型立刻推出「上海油爆虾（青虾…）」 |
| AI 能写档案 | 对话里说「我不吃辣，而且对花生过敏」→ 库里 `spicyLevel: 0`、`allergies: ["花生"]`，并留一条 `taste.update` 回执（可撤） |
| 每轮对话都带上 | 写完之后那句回答里主动提到"以后推荐菜和点菜提醒都会自动避开花生、按不辣来" |
| 提醒不拦人 | 点含过敏原的菜仍然 201（进得去），只是返回里带 `tasteWarning` |

### 本轮抓到的真问题

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| **对鱼过敏的人看不到鱼香菜** | 子串匹配把「鱼香汁」当成了鱼（味型 vs 食材） | `DECEPTIVE_COMPOUNDS` 挖掉这类词；只收有实测证据的词 |
| **容器起不来、反复重启** | `OrdersService` 注入了 `TasteService`，但 `OrdersModule` 没 import `TasteModule` | 补 imports。**教训：注入新服务要检查宿主模块的 imports，`tsc` 管不到依赖注入** |
| 一条断言把默认值当成了类型 | 测试里 `note: null` 的默认值把参数推成 `null` 型 | 显式标注参数类型（真实契约） |

**回归测试**：后端 282 → **314**（`taste.rules` 27、`ai.actions` 的口味撤销 8）；前端 425 → **433**（`TastePage` 8）。
**反证**：去掉 F5-03 过滤 → 验收里"推荐零命中"那条立刻红（推出含虾的菜），其余 21 条不受影响。

## R-047 手边食材能做什么（D-058：F5-04 / F6-07）（✅ 已验证，2026-10-13）

### 怎么跑

```bash
# 后端（改过代码要先重建镜像 —— 见 R-30）
docker compose build api && docker compose up -d --force-recreate api
docker compose exec -T api sh -c "grep -c cookable dist/modules/fridge/fridge.service.js"   # 确认新代码进镜像

# 单测与验收
pnpm --dir services/api test                       # 352/352
pnpm --dir services/api run test:http:cookable     # 35/35

# 前端
pnpm --dir apps/mobile run test                    # 447/447
pnpm --dir apps/mobile run dev                     # http://127.0.0.1:5173/fridge
```

### 验收脚本覆盖什么

`verify-cookable-http.cjs` 从 401 / 404 起，到**反证组**结束：空冰箱不推荐（0 道，不是随便给几道）→ 只放调料时 `usable=0` 且报"跳过 3 样"→ 记 6 样后默认用整个冰箱 → **核对 `have` 是真的**（拿前 5 道去 `/recipes/:id` 取真实配料表逐样比对，11 处全属实；这是**独立查证**，不是拿接口的话自证接口）→ `missing` 里不许出现调料 → 「差 0 样」排在「差 1 样」前面 → **一页里不出现两道同名菜** → 只勾土豆时"番茄炒蛋"不得出现在不用买里 → 五花肉≠猪肉（白菜猪肉饺子仍把"猪肉"列进还差）→ 蛋清≠鸡蛋 → 别名认得出（写"西红柿"配得上"番茄"）→ 切法认得出（写"猪肉"能对上"猪肉末"的麻婆豆腐）→ `maxMissing` / `limit` 生效与超限 400 → 过敏的菜被排掉且 `filteredOut` **只数本来会出现的那几道** → 共享关掉后吃货只看自己放的 → 跨家庭互不可见。

### 本轮实测的关键证据

| 验的是什么 | 证据 |
| --- | --- |
| 默认就用整个冰箱 | 真实冰箱 12 样（含调料 1 样）→ 「44 道能用上 · 调料 1 样没算」，**没有先勾选** |
| "用上了什么"是真的 | 逐行核对配料表（11 处），「用上了 胡萝卜、牛奶、鸡蛋」全部属实 |
| 结果分两档 | 同一页里「不用买」（无第二行）与「差 1 样」+「还差 金针菇」并存 |
| 取消勾选后标签还在 | 取消「番茄」→ 标签**仍在**且可点回来；结果里不再有任何一道说"用上了番茄" |
| 「只看不用买的」 | 44 道 → 9 道，9 道徽章**全部**是「不用买」 |

### 本轮抓到的真问题

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| **反证怎么改都全绿** | 靶子「回锅肉」差得太多**没进结果**，断言被"没这道菜就跳过"短路成 true | 换「白菜猪肉饺子」（非调料配料只有白菜+猪肉）；规矩见 R-45 |
| **改了代码却不生效** | 别名表顺序敏感：同名出现在两组时**后写的覆盖先写的** | 加单测禁止组间重叠；`canonicalName` 改成"先查表再剥词" |
| **取消勾选后标签消失、再也点不回来** | 可选列表取自"当前这次请求的 pantry"（它当然不含刚取消的那两样） | 标签改用一个独立的"整个冰箱"请求（同一缓存键，不多发请求） |
| 同一 tick 连点多个标签只生效一次 | 非函数式更新把 `pickedList` 闭包在同一份旧数组上 | `setPicked(current => …)` |
| 列表里连着三行「番茄炒蛋」 | 库里 33 行重名（不同来源的同一道菜） | `rankMatches` 按菜名去重，留最好做的那一份 |

**回归测试**：后端 317 → **352**（`pantry.rules` 30 条）；前端 433 → **447**（`FridgeCookable` 15 条）。
**反证**：去切法剥离 → "麻婆豆腐不用买"那条**精确变红**；把五花肉并进猪肉 → "还差 猪肉"变红（`missing=[]`）；前端把可选标签改回"当前请求的 pantry" → 取消勾选那条变红。

### 注意

- **限流 60 次/分（按 IP）**：连跑两遍验收脚本会把自己打到 429（表现为页面「暂时算不出来」——**那是限流，不是功能坏了**；脚本里有 `settleThrottleWindow()` 会自动等窗口）。
- 匹配规则**刻意不认品类**（五花肉≠猪肉），所以会有保守的"多说要买一样"，这是设计而非缺陷（见 R-44）。

## R-048 采购清单与库存比对（D-059：F7-02）（✅ 已验证，2026-10-13）

### 怎么跑

```bash
# 后端（改过代码要先重建镜像 —— 见 R-30）
docker compose build api && docker compose up -d --force-recreate api
docker compose exec -T api sh -c "grep -c 'stockLabel' dist/modules/shopping/shopping.rules.js \
  && grep -c 'stockRows' dist/modules/shopping/shopping.service.js"   # 确认新代码进镜像

# 单测与验收
pnpm --dir services/api test                        # 364/364
pnpm --dir services/api run test:http:stock-match    # 19/19
pnpm --dir services/api run test:http:shopping       # 27/27（F7-01 回归）

# 前端
pnpm --dir apps/mobile run test                      # 456/456
pnpm --dir apps/mobile run dev                       # http://127.0.0.1:5173/shopping
```

### 验收脚本覆盖什么

`verify-stock-match-http.cjs` **自带一份菜单**（自己建家庭、加菜、确认那餐），从 401 起：冰箱空时清单**一条都不扣**（`stockEmpty=true`，这是"还没记冰箱"不是"没效果"）→ 记一样真有的（鸡蛋 99个）→ **从"要买的"里拿掉**（`needsBuy=false`、`verdict=enough`）且那句话里给出**家里有多少**（用户要能核对是不是他记的）→ **计数自洽**（`toBuy + covered === items.length`）→ 家里不够时给出**真减出来的**"还要买 1个" → **单位对不上就算不清**（`半盒` vs `2个` → `unknown`、`remaining=null`）→ 算不清的**单独计数**（`unsureCount`）→ 冰箱那侧没写量也算不清 → 别名认得出（记"西红柿"抵掉"番茄"）→ **反证：五花肉不算猪肉**（那道菜仍把"猪肉"列进要买的）→ **正对照：同一张清单里 `白菜` 确实被认出来了**（证明上一条不是因为比对整个没生效）→ 共享关掉后吃货的清单里**没有**妈妈记的库存（`scope=mine`、`covered=0`）、掌勺人仍看全量。

**用法陷阱（脚本先撞上）**：一份菜单要**先把菜全加进去、再确认一次**（`POST /orders/meals/:mealKey/status`）。一菜一确认时第二次 `POST /orders/items` 会 409——**那是接口对的**（那餐已经"已安排"，不该再改），是脚本顺序错了。

### 本轮实测的关键证据

| 验的是什么 | 证据 |
| --- | --- |
| 算得清的真的扣掉了 | 真实清单 26 样 → 「买到 0/24」+「家里有 2 样，不用买」 |
| 算不清的**没有**编号 | 豆腐（要 `600g`，家里记"两盒"）与胡萝卜（要 `1个`，家里记"一小把"）都显示「家里有 …，够不够看一眼」，**没有**"还要买" |
| 算不清的单独提醒 | 那条线写「（2 样的量要自己看一眼）」，两行都带 `is-unsure` 样式 |
| 名字与用量分得开 | 像素量过：`.shop__name` 与 `.shop__amount` 间距 8px，`stockLabel` 独占一行（见下"抓到的问题"） |

### 本轮抓到的问题

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| **正对照是空的** | `五花肉` 那一组想同时验"不认品类"与"比对没失效"，但那张清单里**根本没有要五花肉的条目** | 换**同一张清单**里的 `白菜` 当正对照（先确认那道菜配料表里真有它） |
| 编出了「家里有 半盒，还要买 2个」 | 没有"单位不一致就算不清"这道守卫 | 补守卫；**反证**：拿掉它 → 19/19 掉到 17/19 |
| 注释说"后端拼句子"、实现却在前端拼 | 实现与注释相反 | 后端加 `stockLabel`，前端 `stockLine()` 只透传 |
| **`豆腐600g` 贴在一起** | `.shop__covered-item` 是纯 block，两个 span 之间没有间距（"要买的"那些行有 flex+gap，这里漏了） | 补 `display:flex; gap:4px 8px; align-items:baseline`，与 `.shop__label` 对齐 |

**回归测试**：后端 352 → **364**（`shopping.rules` 新增 12 条）；前端 447 → **456**。
**反证**：拿掉"单位不一致即算不清" → 验收 19/19 → **17/19**，打印出被编出来的减法结果。

### 注意

- **限流 60 次/分（按 IP）**：连跑 `test:http:stock-match` 与 `test:http:shopping` 会互相挤到 429（表现为页面「暂时算不出来」——**那是限流，不是功能坏了**）。
- 「家里有」的那组**默认收起来**：全部都不用买时改为正面摊开（`shop__covered-all`），冰箱空时另给一句解释 + 去 `/fridge` 的链接（`stockEmpty`）。

## R-049 帮我决定（D-060：F5-05）（✅ 已验证，2026-10-13）

### 怎么跑

```bash
# 后端（改过代码要先重建镜像 —— 见 R-30）
docker compose build api && docker compose up -d --force-recreate api
docker compose exec -T api sh -c "grep -c '能用上' dist/modules/discover/decide.rules.js"   # 确认新代码进镜像

# 单测与验收
pnpm --dir services/api test                      # 386/386
pnpm --dir services/api run test:http:decide       # 23/23

# 前端
pnpm --dir apps/mobile run test                    # 470/470
pnpm --dir apps/mobile run dev                     # http://127.0.0.1:5173/discover
```

### 验收脚本覆盖什么

`verify-decide-http.cjs` **自带全部前置数据**（自己注册、建家庭、记冰箱、配口味档案），不依赖别的验收留下的东西。从 401 / 404 起：空冰箱**照样给一道**但 `fridgeEmpty=true`（明说没照冰箱挑）→ 一条真信号都没有时那句话是"库里挑的"（**不编理由**）→ **冰箱里只有调料时绝不说"用上了冰箱里的…"** → 记番茄鸡蛋后能挑出 `ready` 档 → **独立核对**（自己重新取配料表 + 自带一份调料/别名表）：凡是说"正好能做这道"的，非调料配料必须**真的**都在冰箱里；凡是说"只差 X"的必须**真的只差那一样** → `exclude` 真生效（连着 8 次给 8 道不同的菜）→ 把 20 道都排除后**仍然给一道** → **有人对鸡蛋过敏时挑出来的 10 道一道都不含鸡蛋**，且**仍然挑得出菜**（正对照：不是把功能关掉就算过滤通过）→ 共享开着时吃货看全家的冰箱、关掉后 `scope=mine`、**掌勺人仍看全量**。

### 本轮实测的关键证据

| 验的是什么 | 证据 |
| --- | --- |
| 挑得出"一样都不用买"的 | 真实冰箱（番茄、鸡蛋、胡萝卜、牛奶、黄瓜、豆腐……）→ 「番茄炒蛋」，理由「冰箱里的 番茄、鸡蛋正好能做这道」 |
| 每次都换 | 连点四次「换一道」：香奶胡萝卜鸡蛋羹 → 酸辣黄瓜 → 凉拌黄瓜 → 麻辣豆腐 |
| 菜名点进详情、返回后**原样还在且不重挑** | 点「番茄炒蛋」→ 详情（返回按钮写"返回发现"）→ 返回：抽屉开着、仍是「番茄炒蛋」、理由不变 |
| 「就它了」真进菜单 | toast「已把「番茄炒蛋」加进午餐」+ 按钮换成「已经加进菜单了」（再点不到） |
| 关掉再开是干净的一场 | 重开 → 「蒜香黄瓜」（上一轮的"已加入"没有留下） |
| **菜不会自己变** | 打开后连读 6 次（间隔 700ms）：6 次都是「番茄炒蛋」（修 StrictMode 双挂载那条 bug 的现场复验） |

### 本轮抓到的三个真问题

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| **说出"缺了一样却正好能做"** | `ready` 与 `near` 共用同一句"正好能做这道" | `near` 改说"能用上 + 只差 X"；单测钉住"差一样时不许出现'正好能做'" |
| **抽屉里的菜一秒后自己变成另一道** | StrictMode 的"挂载→卸载→再挂载"让组件 state 重置，于是**问两次**，后回来的结果覆盖了先显示的 | "问过了"的标记挪进 store（活过重挂载） |
| **抽屉打开后只有引导语、菜永远不出现** | 修上一条时把"打标记 + 发请求"放在**渲染期**，store 变更把那次渲染整个丢弃了 | 挪进 effect |

**回归测试**：后端 364 → **386**（`decide.rules` 21 条 + F5-05 新增的那条）；前端 456 → **470**（`DecideSheet` 13 条 + 发现页 2 条）。
**反证**（两组都确认会精确变红、且只红该红的那条）：① 拿掉口味过滤 → 「10 道一道都不含鸡蛋」变红；② 把 `near` 档也写成"正好能做" → 6 条独立核对变红，打印出"缺干海木耳却说正好能做"。

### 注意

- **限流 60 次/分（按 IP）**：这条验收自己就要发几十个请求，连跑两遍必然打到 429（脚本里有 `settleThrottleWindow()` 会自动等窗口）。
- 验证"菜不会自己变"这件事**必须在浏览器里做**：jsdom 不跑 StrictMode，所以那类问题单测看不到（这也是它当初能溜过去的原因）。

## R-050 「帮我决定 + AI」合并成一个入口（D-061，用户 2026-10-13 提出重复后合并）（✅ 已验证，2026-10-13）

### 怎么跑

```bash
# 只动了前端（后端这一次没改，容器不用重建）
pnpm --dir apps/mobile run test                    # 473/473
pnpm --dir apps/mobile run dev                     # http://127.0.0.1:5173/discover
```

### 这次改了什么（验收要看的就是这些）

| 改动 | 怎么看 |
| --- | --- |
| 卡上**两条**出路、等宽并排 | 两个按钮各 160px（`flex: 1` 平分），不再有第三个按钮 |
| AI 收进「帮我决定」抽屉、**默认收着** | 打开抽屉只看到一道菜 + 一行"都不合意？说说想吃什么" |
| 展开/收起的**过渡动画** | 展开：面板透明度 0 → 1 且箭头转 180°；收起：面板播完 `today-ai-out` 才从 DOM 消失 |
| 展开按钮**明显** | 22×22 的圆形矢量图标（浅橙底 + 描边），不再是 12px 裸字符 |
| 两个动作按钮**几何一致** | 顶边、高度、圆角、内边距完全相同（实测都是 top 722 / height 45 / radius 14px） |
| 会话状态**活过路由跳转** | 点 AI 推荐的菜名 → 详情 → 返回：上面那道菜还在、**AI 那半仍展开**、推荐原样 |

### 实测证据（浏览器，真实数据）

| 验的是什么 | 证据 |
| --- | --- |
| 两按钮等宽 | `🎲摇一道` 160px / `✨帮我决定` 160px |
| 动作按钮几何一致 | 两个都 top=722、height=45、radius=14px、padding=10px 14px（**修前**：320/314、999px/14px） |
| 展开动画 | 动画中 `opacity=0` + `animationName=today-ai-in`，结束后 `opacity=1` |
| 收起动画 | 收起后 300ms 内面板**仍在 DOM**（`animationName=today-ai-out`、`opacity=1`），再等 100ms 才卸载 |
| 箭头 | 22×22、`border-radius: 50%`、背景 `rgba(224,123,57,0.13)`、`transition-property: transform` |
| AI 那半真能用 | 输入"想吃酸的，两个人" → 真网关返回 5 道（鱼香肉丝 / 番茄炒蛋 / 糖醋脆皮茄子 / 凉拌紫甘蓝 / 山楂银耳汤），**上面那道菜仍在** |
| 往返保持原样 | 点「鱼香肉丝」进详情（返回按钮写"返回发现"）→ 返回：`aiOpen=true`、5 条推荐原样、上面仍是「蒜香黄瓜」 |

### 本轮抓到的问题

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| **两个按钮没对齐**（用户指出） | 「就它了」借用菜谱详情页的 `.recipe-button`，带进 `margin-top: 12px` 与 `border-radius: 999px` | 这一对不借用别处的类：几何写在公共规则里，各自只准改颜色；加规则级回归用例 |
| **展开按钮不明显**（用户指出） | 12px 裸字符 `⌄`，无底色 | 22px 圆形矢量图标 + 展开时旋转 180° |
| **展开没有过渡**（用户指出） | 面板直接挂载/卸载 | 两段动画；收起时面板留在 DOM 播完再卸载（`closing` + `AI_EXIT_MS`） |
| **注释渲染成了可见文字** | 我在 **JSX 子节点**位置写了 `//`（那个位置只有 `{/* */}` 合法） | 改注释写法；**lint 与单测都不会报这类问题**，只有看渲染结果才会发现 |

**回归测试**：前端 470 → **473**（新增：几何一致性、下半默认收着、上半空了下半仍可用）。
**反证**：把 `margin-top: 12px` 加回 `.decide__take` → 「几何完全一致」那条**精确变红**。

## R-051 最近录入（D-062：F6-06）（✅ 已验证，2026-10-13）

### 怎么跑

```bash
# 后端（改过代码要先重建镜像 —— 见 R-30）
docker compose build api && docker compose up -d --force-recreate api
docker compose exec -T api sh -c "grep -c 'addedLabel' dist/modules/fridge/fridge.rules.js"   # 确认新代码进镜像

# 单测与验收
pnpm --dir services/api test                    # 395/395
pnpm --dir services/api run test:http:fridge     # 37/37

# 前端
pnpm --dir apps/mobile run test                  # 476/476
pnpm --dir apps/mobile run dev                   # http://127.0.0.1:5173/fridge
```

### 验收脚本覆盖什么（F6-06 那四条）

最近录入**按记的时间倒序**（最后记的那样必须排第一）→ 每条都带「什么时候记的」那句话、刚记的算"刚刚" → 每页最多 8 条且 `recentTotal` 与总数一致 → 每条带**谁记的**。

### 本轮实测的关键证据

| 验的是什么 | 证据 |
| --- | --- |
| 默认收着 | 那条线写「最近记的 8 样（一共 12 样）」、`aria-expanded=false`、`.recent__list` 不在 DOM |
| 展开后按时间倒序 | 8 行依次是 李子 / 小土豆 / 胡萝卜 / 小葱 / 鸡蛋 / 番茄 / 苹果 / 豆腐（都是今天记的，倒序） |
| 四列对齐 | 像素量过：名字吃掉空档（left 34）、数量右缘 295、时间 303–326、谁 334–357，三行完全一致 |
| 箭头与过渡 | 22×22 圆形、展开时旋转（与「都不合意？」同一套语汇） |
| 空冰箱不画 | 空冰箱时那一行不在 DOM |

### 本轮抓到的问题：反证**又一次是空着的**（比上次更隐蔽）

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| 把服务端改成**完全不排序**，验收**照样 37/37 全绿** | MySQL 没有 `ORDER BY` 时的返回顺序**碰巧**就是插入顺序（`[familyId, zone, name]` 索引给的顺序），于是"最后记的排第一"在没排序时也成立 | 把最后记的那一样放进**自然顺序会排在最后**的位置（`冷冻` 区 + 名字靠后），改完再跑反证：柠檬排到第二条，那条精确变红 |
| 单测里"未来的时间"我给写成了"今天" | 实现与注释想说的相反 | 未来的时间一律"刚刚"（时钟偏差造出的行不该有别的说法） |

**回归测试**：后端 386 → **395**（`fridge-recent` 9 条）；前端 473 → **476**（最近录入 3 条）。
**反证**：服务端 `recent` 去掉排序 → 37/37 → **36/37**（"最后记的柠檬"排到第二条）。

### 注意

- **写"排序"类断言时先问一句"不排序的话它会不会也成立"**——会的话，靶子要摆成"错误的实现必然给出不同顺序"（R-45 的补充）。
- 那句话（"今天/昨天"）在**请求那一刻**算好，跨午夜不会自己变（R-48，已知取舍）。

## R-052 冰箱页两块降高（D-063，用户选定方案 B）（✅ 已验证，2026-10-13）

**改了什么**：四区 2×2 铺开 → 一行段控 + 选中那格全宽两列；菜竖排 12 道 → 横滑 5 张卡。

**怎么验的（每一步都有实测输出）**：

1. `pnpm --dir apps/mobile run dev`，浏览器开 `http://127.0.0.1:5173/fridge`（391×844）。
2. **量高**（`getBoundingClientRect`，在真实页面上量，不看截图估）：

   | 部位 | 改前 | 改后 | 预览承诺 |
   | --- | --- | --- | --- |
   | 「冰箱里有什么」 | 791 | **378** | 370 |
   | 「能做点什么」 | 828 | **266** | 259 |
   | 做菜块顶边 | 969（首屏外） | **566** | 547 |

3. **逐区域对照预览**（预览里的标注是实现约束，不能"看着差不多"）：

   | 区域 | 真机 | 预览 | 差 |
   | --- | --- | --- | --- |
   | 段控行 | 30 | 31 | −1 |
   | 分区面板 | 195 | 195 | 0 |
   | 食材行高 | 32 / 37 | 32 / 37 | 0 |
   | 菜品卡 | 157 | 158 | −1 |

   逐区域都在 **1px** 内；整块差的 8px 是 `.pscreen` 的 gap。第一版差 **29px**，逐区域查出四处：食材图 28→26、名字与第二行**没给 `line-height`**（默认 1.6，一行多 3px、五行 15px）、最近录入内边距 7→5、`.recent` 的 margin/padding 12/10→10/8。

4. **交互**：点「常温」→ 两样换过来、选中的那颗换过来；点「冷冻 空」→ "冷冻格里没有东西。"；展开「最近记的 8 样」→ 8 行。
5. **跨路由保状态**：选「常温」+ 展开最近 → 点一道菜进详情 → 返回 → **仍然选中「常温」、最近仍展着**（第一版这里是跳回「冷藏」的，见 R-49）。
6. **横滑**：容器 327px / 内容 781px，滚到 300 后第 4~5 张可见；`overflow-y` 为 auto 但 `scrollHeight === clientHeight`（159），**没有裁切**。
   （末尾那块**当天下午就改过**：当时「› 还有 40 道能做」不是链接，用户看过之后要求做成真入口，见 R-054。）
7. **长名字**：库里最长的「超级下饭的番茄炒蛋.西红柿炒鸡蛋」当时实测 **2 行 32px**（`-webkit-line-clamp:2`）。
   （**已改**：同一次反馈后改成**一行 16px + 省略号**，见 R-054——两行会被一条长名字把整条横滑条每张卡都撑高。）
8. `pnpm --dir apps/mobile run test` → **481/481**；`tsc -b` 只剩既有的 2 条（CombosPage/PrepPage）；lint **9 warnings / 0 errors**（基线未变）。
   （后续两刀之后：前端 **502/502**、`tsc -b` 干净、lint 基线未变，见 R-053 / R-054。）

**踩到的坑**：

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| 选中「常温」→ 进菜谱详情 → 返回，**跳回「冷藏」** | 状态放在组件 `useState`，路由跳转让冰箱页整个卸载 | 移进 `stores/fridge-view.ts`（同 `today-session` 的做法） |
| 六个用例红："找不到鸡蛋" | store 是**模块级**的，上一个用例点了「冷冻」，下一个打开还是冷冻 | `beforeEach` 里 `useFridgeView.setState({ zone: null, recentOpen: false })` = "重新打开这一页" |
| 块高比预览多 29px | 四处：图 28→26、**没给 line-height**（默认 1.6 每行多 3px）、最近录入内边距、`.recent` 间距 | 逐区域对照后按预览约束收齐 |

### 注意

- **预览里的数字是实现约束**：改完要**逐区域**对照，差 20px 以上一定是漏了具体某一处，要查出是哪一处而不是"差不多就行"。
- **`line-height` 不写就是 1.6**：一排小字里每行多 3px，两列五行就多 15px——这类"没写在任何一处"的尺寸最容易被漏。
- 这一刀**只锁了 3D 冰箱的位置与高度**（分区面板那格，205px），**3D 本身没做**（M17 / F17-01~F17-06）。

## R-053 采购清单编辑与一键补货（D-064：F7-03 + F7-05）（✅ 已验证，2026-10-13）

用户「继续做吧」→ 做 F7-03（勾选持久化 / 增减条目 / 分组）与 F7-05（一键补货进冰箱）。**这两条是一件事的两半**：在超市勾掉买到的，回来一键记进冰箱。

### 落地了什么

| 层 | 位置 | 内容 |
| --- | --- | --- |
| 表 | `prisma/schema.prisma` | `ShoppingCheck`（`familyId + name` 唯一，7 天过期）+ `ShoppingExtra`（自加条目，带 id 可删） |
| 规则 | `shopping.rules.ts` | `aisleOf`/`AISLE_ORDER`（六组货架，覆盖真实语料 **91.4%**）、`isBuyable`（12 种"水"的写法）、`aisleZone`（补货分区）、`checkFresh`（7 天 TTL）、`parseExtraName/Amount` |
| 接口 | `shopping.controller.ts` | `POST /shopping-list/check`、`POST /shopping-list/extras`、`DELETE /shopping-list/extras/:id`、`POST /shopping-list/restock`（200）；`GET` 的返回多出 `aisles`/`checkedNames`/`checkedCount` |
| 前端 | `api/shopping.ts`、`ShoppingPage.tsx` | 勾选乐观更新（只合并这一样）、按货架分组渲染、自加条目表单、末尾 ✕ 删自加条目、「把这 N 样记进冰箱」 |

### 验证步骤（按这个顺序跑）

1. **后端单测**：`pnpm --dir services/api run test` → **414/414**。
2. **后端 HTTP 验收**：先 `docker compose build api && docker compose up -d --force-recreate api`，等健康检查，再
   `pnpm --dir services/api run test:http:shopping-edit` → **30/30**；
   `pnpm --dir services/api run test:http:cookable` → **39/39**（含新增的 4 条 `offset` 翻页）。
   - 两个脚本都有 `settleThrottleWindow()`：全局限流 60 次/分，连跑第二遍会撞 429，脚本会自己等窗口。
3. **前端**：`pnpm --dir apps/mobile run test` → **502/502**；`npx tsc -b` 干净；`pnpm run lint` **9 warnings / 0 errors**（基线未变）。
4. **浏览器**（dev :5173，391×844）：勾一下 → 立刻划掉 → **刷新后勾还在**；按货架分组的标题与行都在；加一条「垃圾袋」→ 出现在「其他」那一组；勾上后点「把这 1 样记进冰箱」→ toast + 冰箱页真的多了那一样。

### 注意

- **勾选的真相在服务端**（`checkedNames`），`checkedCount` 也由后端给——前端不自己数，两边各数一遍必然有一边先改。
- **乐观更新只合并这一样**：整体替换缓存会在"连点好几样"时把先回来的响应写回去（"我点了它怎么又没勾上"）。
- **补货的数量留空**是刻意的：清单上的"2个"是**菜谱要多少**，不是买回来多少。
- **验收断言要确认前提成立**：见 R-52（"跳过保留勾"那条第一版永远不可能通过）。
- 勾选 **7 天自动过期**，读的时候顺手删（`checkFresh`）。

## R-054 「能做点什么」菜名单行省略 + 末尾块改成真入口（D-063 修订）（✅ 已验证，2026-10-13）

用户看过 D-063 的落地效果后提：「这块不要换行，用省略吧，这个更多也不好看还不能点击，需要实现和优化」。

### 改了什么

1. **菜名单行省略**：`.cook__card-name` 的 `-webkit-line-clamp: 2` → `white-space: nowrap` + `text-overflow: ellipsis` + `overflow: hidden`（三件套缺一个就变成硬截断），并补 `title` 属性。实测长名字那一格 **32px → 16px**（不再把整条横滑条每张卡都撑高）。
2. **末尾那块是入口**：`128px` 卡（与菜卡同宽同圆角、品牌色浅底），写**总数**（`45 道能做 / 看全部 ›`），`<Link to="/fridge/cookable?…">`——把当前口径（`ingredients` / `maxMissing`）一起带过去。
3. **新页 `/fridge/cookable`**（「能做点什么」完整列表）：竖排一行一道（图 + 名字 + 用上了什么 + 还差什么 + 徽章），一次 12 道、`再看一页（还有 N 道）`、翻到底说"能做的都在这里了"。
4. **后端 `offset` 分页**（`COOKABLE_OFFSET_MAX = 1000`，默认 0 → **老调用方一个字的代码都不用改**）。

### 验证步骤

1. `pnpm --dir services/api run test` → **414/414**（新增 `parseCookableOffset` 与 `parseCookableLimit` 的边界）。
2. `pnpm --dir services/api run test:http:cookable` → **39/39**（新增：两页不重叠、翻页不改总数、翻到最后一页给得出剩下那道、`offset=-1` → 400）。
3. `pnpm --dir apps/mobile run test` → **502/502**。
4. 浏览器：横滑条末尾 `plateHref=/fridge/cookable`；点进去 12 行、**组内顺序与横滑条前 5 道一致**；「再看一页（还有 33 道）」→ 24 行、**零重复**、剩 21 道；开「只看不用买的」→ 地址变 `?maxMissing=0`（12 道）；从那一页点进菜谱详情、返回后**筛选还在**、底部 Tab 仍高亮「冰箱」。

### 注意

- **姓名格高 16px** 是这一刀的验收数字（改前长名字 32px）。
- 末尾那块写的是**总数**不是"还剩多少"：它是入口，说的是"点进去一共有多少"。
- 筛选走 **URL**（不是 store）：URL 本来就是"这一页看到的东西"的地址，顺带让筛选活过路由跳转、也能直接分享这一屏。
- 这一页与冰箱页那块**是同一份结果**（同接口同顺序），点进去不会换一批菜。
- **`/fridge/cookable` 已加入返回白名单**（`back-link.ts`），否则从它点进菜谱后的返回按钮会退到冰箱页。
- 已修正 R-052 第 7 条：长名字**不再是 2 行 32px**，现在是 1 行 16px + 省略号。

## R-055 「我的」页收口 + 口味与忌口改弹窗（D-066：F2 / F8）（✅ 已验证，2026-10-13）

用户连着提了四处：「口味与忌口和我的设置中的重复了，保留我的设置中的」「口味与忌口中"我"那块怎么没法点击」「下面又有一堆菜单，太乱了，优化下」「改一改不要在下面，使用弹窗」「顶部返回和下面 tip 的间距和其他页都不一致」。

### 改了什么

| 处 | 改前 | 改后 |
| --- | --- | --- |
| 口味与忌口入口 | 独立成节 + 「我的设置」里一行（那行还点不动） | **只在「我的设置」里一个入口**，接上真链接，副标题写实时状态 |
| 「改一改」 | 挂在页尾的一段（点它时在首屏之外：`top≈803` / 可视区 768 → 屏幕上毫无变化，用户以为"点不动"） | **BottomSheet 抽屉**（滑出 + 遮罩 + 可下拖关掉），点下去立刻看得见 |
| 「AI 设置」整节 | 两行带箭头、点了没反应（AI 是部署时 `.env` 配的，D-009，界面改不了） | **整节下线** |
| 消息提醒（M10） | 带箭头（点不动） | 保留一行，**去掉箭头 + 「还没做」标签 + 压淡** |
| 设置行 | `div` + 手搓 `role/tabIndex/onKeyDown` | `<Link>`（浏览器语义兜住键盘/读屏/新标签） |
| 口味页间距 | **全站唯一漏了 `.pscreen` 的页面**（返回键 `top=0`，别页 18） | 补上 `.pscreen`，逐像素与其它页对齐 |

### 验证步骤

1. `pnpm --dir apps/mobile run test` → **507/507**（口味页 +3：抽屉弹出/标题与已选态/"先不改"不发请求；我的页 +2：口味入口唯一、设置里不画点不动的箭头）。
2. `npx tsc -b` → 只剩既有 2 条（CombosPage / PrepPage）；`pnpm run lint` → **9 warnings / 0 errors**（基线未变）。
3. 浏览器（dev :5173，391×844）：
   - 我的页**5 节 → 3 节**、整页 1315px → **998px**、`a[href="/taste"]` 只有 1 条；
   - 点「改一改」→ 抽屉实测 `101 → 844`（高度 743）、标题「改一改」、已选词（微辣/花生/牛奶/蟹/香菜）都带选中态；
   - 点「先不改」→ 抽屉收起（`.adm-popup-body` 消失）、**停在 /taste、不发请求**；
   - 口味页返回键 `top=18 / bottom=54`、页头 `54→108`——与 `/shopping`、`/fridge/cookable` 实测值**完全相同**。

### 注意

- **"点了没反应"要先量位置再改代码**：这次功能是好的，反应在屏幕外（R-54）。浏览器验收要读元素的 `getBoundingClientRect()` 并与可视区（视口 − 底栏）比，不能只断言"DOM 里有没有"。
- 抽屉里的小节标题**不再自带左右栏距**（`.sheet__body .section-title { padding-inline: 0 }`）：内容区已有 16px，两处都加就是 32px，比抽屉外同款小节明显内缩。
- 抽屉用的是 antd-mobile `Popup`，**不带 `role="dialog"`**——本项目所有抽屉都如此（FridgeItemSheet 的测试同样按类名断言）。给共享 `BottomSheet` 补弹层语义是另一件事，本次没做。
- 截图在抽屉打开时偶发 `surface preparation timed out`（本项目已知的桥接问题，与页面无关）：改用 DOM 结构化读值当证据（与 R-028 那次同一手法）。

## R-056 后端部署到服务器 + 数据迁移（✅ 已验证，2026-10-14）

**目标环境**：`120.48.142.161`（百度云北京 · CentOS Linux 8.4 · x86_64 · 2 核 / 1.9 GB / 40 GB）。地址、端口、绑定与 `.env` 清单见 `MAP.md`「部署」一节；本条只记**怎么做**与**踩到的坑**。

### 0. SSH 通道（前置，本机网络封禁出站 22）

本项目所在网络**封掉所有出站 22 端口**（连 github/gitee 的 22 都超时，443 正常），所以服务器上 `sshd` 同时监听 22 与 **2222**，本机走 2222：

```bash
ssh cook            # 别名在 ~/.ssh/config.d/cook（Port 2222、仅密钥登录）
```

- 改端口时**必须把 `Port 22` 一起写上**：CentOS 默认 `#Port 22` 是注释状态，只加 `Port 2222` 会让 22 停止监听（可能影响控制台 smartterm）。
- root 已改为**仅密钥登录**（`PasswordAuthentication no` + `PermitRootLogin prohibit-password`）；改之前先验证密钥能进再关密码，否则会把自己锁在外面。

### 1. 服务器清理与准备

```bash
# 停掉用户自装的服务（openclaw 是 root 用户级 systemd 单元，不是系统服务）
export XDG_RUNTIME_DIR=/run/user/0
systemctl --user stop openclaw-gateway.service && systemctl --user disable openclaw-gateway.service
loginctl disable-linger root
systemctl stop alist.service && systemctl disable alist.service
# openclaw 的两个容器占着 3000 端口，必须停掉并取消自启
docker update --restart=no openclaw-qq openclaw-wechat && docker stop openclaw-qq openclaw-wechat

# Docker 已装（docker-ce 26.1.3）但没启动
systemctl enable --now docker

# 无 swap 的 1.9 GB 机器跑 MySQL 有 OOM 风险，加 2 GB 兜底
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab && sysctl -w vm.swappiness=10
```

**不要停**：`sshd`、`NetworkManager`、`getty`/`serial-getty`（控制台恢复通道）、以及百度云的 `has-agent` / `bcm-agent`（停了会影响控制台，包括 smartterm 这条后路）。

### 2. 传代码

`rsync` 在本机是 openrsync（参数受限），用 tar over ssh 更稳：

```bash
cd <项目根>
tar czf - --exclude='node_modules' --exclude='dist' --exclude='.env' --exclude='.git' \
  docker-compose.yml services/ | ssh cook 'mkdir -p /opt/cook && tar xzf - -C /opt/cook'
ssh cook 'find /opt/cook -name "._*" -delete'      # 清掉 macOS 的 AppleDouble 元数据
scp .env cook:/opt/cook/.env                        # .env 单独传，内容不回显
```

### 3. 服务器 `.env` 要改的项

见 `MAP.md` 清单。生成强密码**在服务器上做**，通过环境变量传给改写脚本，**全程不打印值**（密钥不进对话记录）：

```bash
export NEW_MYSQL_ROOT_PW=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-28)
# …同法生成 MYSQL_PASSWORD / MINIO_ROOT_PASSWORD / JWT_SECRET（JWT 用 -base64 48）
# 再用一段 python 按键名替换 /opt/cook/.env，只回显「改了哪些键」不回声值
chmod 600 /opt/cook/.env
```

- **`MAIL_TRANSPORT=smtp` 必设**，且**必须挂在 `api` 服务上**——见下方「坑 1」。
- `MEDIA_BASE_URL` 写公网地址，写错则全站图片打不开。
- `CORS_ORIGIN` 要含 `http://localhost`（APK WebView 的 Origin）。

### 4. 构建

```bash
cd /opt/cook && docker compose build
```

**坑 2：服务器直连 Alpine 官方源拉不到 APKINDEX**（`apk add` 直接报 `no such package: ca-certificates`）。已在两个 Dockerfile 里加 `ARG ALPINE_MIRROR`（默认仍是官方源，不影响本机构建），服务器 `.env` 设 `ALPINE_MIRROR=https://mirrors.aliyun.com/alpine`。Docker Hub 拉基础镜像慢（`node:24-alpine` 约 3 分钟），daemon.json 里已有国内 registry mirror。

### 5. 数据迁移

**MySQL**（`cook` 库，20 张表约 3.66 MB）：

```bash
# 本机导出（--single-transaction 不锁表）
docker exec -e MYSQL_PWD="$ROOT_PW" cook-mysql-1 \
  mysqldump -uroot --single-transaction --routines --triggers --default-character-set=utf8mb4 cook > cook-dump.sql

# ⚠️ 必做：改写库里的绝对地址。OrderItem.recipeImage 冗余存了完整图片 URL（561 处），
#    Recipe.image 也有 4 处 —— 不改写则这些图在服务器上全部指向 127.0.0.1 打不开。
sed -i '' 's|http://127.0.0.1:9000|http://120.48.142.161:9000|g' cook-dump.sql

# 服务器导入（密码从容器自身环境变量取，不落命令行）
docker exec -i cook-mysql-1 sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" cook' < cook-dump.sql
```

**MinIO**（`cook-media` 600 + `cook-checkins` 18 个对象，13.6 MB）——整卷搬，不走 mc：

```bash
# 本机打包（⚠️ 排除 .root_user / .root_password：那是 MinIO 持久化的根凭据，
#   带过去会和服务器新密码冲突；凭据应由服务器 .env 注入）
docker run --rm -v cook_minio-data:/data -v /tmp:/backup alpine:latest \
  tar czf /backup/minio-data.tgz -C /data --exclude=./.root_password --exclude=./.root_user .

# 服务器解包（⚠️ 卷要用 compose 标签创建，否则每次 up 都告警「not created by Docker Compose」）
docker volume create --label com.docker.compose.project=cook \
  --label com.docker.compose.volume=minio-data --label com.docker.compose.version=2.27.0 cook_minio-data
docker run --rm -v cook_minio-data:/data -v /opt/cook/migration:/mnt alpine:latest tar xzf /mnt/minio-data.tgz -C /data
```

### 6. 启动与验证

```bash
cd /opt/cook && docker compose up -d
docker compose ps                                   # 三个容器都应 healthy/running
curl -s http://127.0.0.1:3000/api/health             # {"status":"ok","name":"yushan-api",...}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9000/cook-media/recipes/<某个真实 imageKey>
```

**行数比对**（`information_schema.table_rows` 是估算值，必须用 `COUNT(*)`）：

```sql
SELECT 'Recipe' t, COUNT(*) c FROM `Recipe` UNION ALL SELECT 'OrderItem', COUNT(*) FROM `OrderItem` …
```

两侧结果应逐表一致。唯一可能不一致的是 `RefreshToken`（活库导出后还会新增会话）。

### 注意（本次踩到的坑，按代价排序）

1. **`MAIL_TRANSPORT` 等发信变量原先被挂在 `mysql` 服务上，等于从没生效**——读它们的是后端进程。后果：`.env` 里写了 `smtp` 也无效，API 容器仍走 `console` 默认值并**把重置链接回给调用方**（R-16）。已移到 `api` 服务。**方法教训**：验证安全设置不能只看到"配置里写了"，要**在容器内 `docker exec <容器> env | grep XXX` 确认变量真的到了读它的那个进程**，再用**真实存在的数据**打一次接口（我第一次用不存在的邮箱测，服务提前返回、根本没走到发信分支，测试无效）。
2. **库里有绝对地址**：`OrderItem.recipeImage` 冗余存完整图片 URL（561 处）。迁移前必须 `sed` 改写，否则历史点单卡全部无图。`MAP.md` 里"图片地址由运行时拼 `MEDIA_BASE_URL`"的说法只对 `Recipe.imageKey` 成立。
3. **Alpine 官方源在国内服务器不可直接用**，见「坑 2」。
4. **端口别裸奔**：compose 原本把 `3306:3306` 映射到 `0.0.0.0`，安全组一放开就是公网裸库。已改成 `${MYSQL_BIND:-0.0.0.0}` 形式（默认值不变），服务器 `.env` 设 `127.0.0.1`；MinIO 控制台 9001 同理。9000 必须公网可达（图片走它）。
5. **`docker compose config` 会打印含密钥的完整配置**，要过滤后再输出。
6. **`GROUP_CONCAT` 默认 1024 字符**会截断生成的长 SQL（表多时少几张表且不报错），先 `SET SESSION group_concat_max_len=1000000`。
7. **Prisma 存 UTC，MySQL 的 `NOW()` 是本地时间**（容器 `TZ=Asia/Shanghai` 差 8 小时）。按时间删测试数据要用 `UTC_TIMESTAMP()`，否则 `ROW_COUNT()` 为 0、看着像删成功了其实没删。

## R-057 Android 打包与模拟器验收：出 APK、装进去、逐条验 R-13（F14-01，✅ 已验证，2026-10-14）

配套决策见 `DECISIONS.md` **D-067**（为什么这么选、六个装上去才看得见的问题）。本条只记**怎么跑**。

### 0. 一次性环境准备

**JDK 21**（Gradle 8.14.3 不支持 JDK 25/26）：

```bash
# 清华 Adoptium 镜像；sha256 与官方 GitHub release 对照过（3623…9998）
curl -LO https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/aarch64/mac/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12.1_1.tar.gz
# 解出来放到 ~/Library/Java/JavaVirtualMachines/temurin-21.0.12.1.jdk/Contents/Home
# ⚠️ 必须补 Info.plist（见 D-067 §一），否则 /usr/libexec/java_home 找不到
```

**Maven 镜像**（`dl.google.com` 握手失败时用）：`~/.gradle/init.d/aliyun-mirrors.gradle`，仓库外，不进版本控制。

**签名**（一次性，密钥不入库）：

```bash
keytool -genkeypair -v -keystore apps/mobile/android/keystore/yushan-release.jks \
  -alias yushan -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Yushan, OU=Cook, O=Yushan, C=CN"
# 密码写进 ~/.gradle/gradle.properties（仓库外）：
#   YUSHAN_KEYSTORE_FILE / YUSHAN_KEYSTORE_PASSWORD / YUSHAN_KEY_ALIAS / YUSHAN_KEY_PASSWORD
```

### 1. 出包

```bash
export JAVA_HOME="$HOME/Library/Java/JavaVirtualMachines/temurin-21.0.12.1.jdk/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

pnpm --dir apps/mobile run build          # web 资源 → dist/
pnpm --dir apps/mobile exec cap sync android   # 同步进 android/app/src/main/assets/public
cd apps/mobile/android
./gradlew assembleDebug                   # 20MB，带 DevTools 端口
./gradlew assembleRelease                 # 19MB，已签名（缺签名会提前报错，见 D-067 §五）
```

**改动 web 代码后必须重跑 `cap sync`**，否则 APK 里还是旧的网页资源（改了半天没生效就是这个）。

### 2. 模拟器

```bash
emulator -avd Medium_Phone_API_37.0 -no-snapshot-save -no-boot-anim &
adb wait-for-device && while [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" != 1 ]; do sleep 3; done

# 后端与图片走宿主：模拟器里 127.0.0.1 是模拟器自己，用 reverse 把宿主端口映射进去
adb reverse tcp:3000 tcp:3000
adb reverse tcp:9000 tcp:9000

adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.yushan.cook/.MainActivity
```

**AVD 名字是 `Medium_Phone_API_37.0`**（不是 `.ini` 文件名 `Medium_Phone`，后者会报 `Unknown AVD name`）。

### 3. 看 APK 里的真实界面（WebView 没有可访问性树）

`uiautomator dump` 在 WebView 上**只能拿到一个空节点**，看不到任何页面内容。要"看"APK 里渲染了什么，连它的 DevTools 协议：

```bash
PID=$(adb shell pidof com.yushan.cook | tr -d '\r')
adb forward tcp:9222 localabstract:webview_devtools_remote_$PID
curl -s http://127.0.0.1:9222/json/list     # 列出页面目标
# 然后连 webSocketDebuggerUrl 跑 Runtime.evaluate（脚本见 /tmp/cdp.mjs、/tmp/drive.mjs 的做法）
```

- **`adb forward` 会在 app 重启后失效**（socket 名带新 PID），要重新转发；
- **release 包不开这个端口**——这是**正确的安全行为**，不是 bug；验 release 包只能靠截图与 `adb input`。
- 派发真实输入：**触摸事件要带 `id` 字段**（`touchPoints:[{x,y,id:1}]`），不带的话 `touchmove` 送不到（第一次就是这么假绿的）。鼠标用 `Input.dispatchMouseEvent`。

### 4. R-13 五条怎么验

| # | 怎么验 | 判据 |
| --- | --- | --- |
| ① | 在二级页（如 `/taste`）按 `adb shell input keyevent KEYCODE_BACK`；再在弹层开着时按一次；再在根页面按一次 | 分别：回上一页 / 只关弹层（路径不变）/ 退到桌面（`dumpsys window \| grep mCurrentFocus` 变成 launcher） |
| ② | `am force-stop` 后连拍冷启动（`screencap` 每 0.3s 一张） | 逐帧都是首屏米色，没有白帧 |
| ③ | 聚焦一个输入框，读 `innerHeight` 与焦点框的 `getBoundingClientRect()` | 视口变小（resize）且焦点框仍在可视区内；按返回先收键盘、不离开页面 |
| ④ | 读 `.tab-layout__body` 的 `overflow-y` / `-webkit-overflow-scrolling`，写一次 `scrollTop` | `auto` + `touch`；`scrollTop` 可写且生效 |
| ⑤ | 切 Tab 前后读 `performance.getEntriesByType('navigation').length` | 不变（= SPA 内部转场，没有整页重载） |

**抽屉拖拽的死区怎么扫**（D-067 §四那条）：用 `adb shell input mouse swipe` 从**四个高度各拖一次**（面板顶边 / 标题行 / 内容中段 / 面板底边），每次挂一个 `touchmove` 探针读 `panel.style.transform`。判据是"有没有像素位移"，不是"抽屉关没关"——顶边那次以前是**完全无位移**。

### 5. 页面里的安全区与边到边

- WebView 里 `env(safe-area-inset-top/bottom)` **实测 24px**（浏览器里是 0）——**验证布局问题必须在 APK 里做**，浏览器里看不出来；
- Android 15+ 强制 edge-to-edge，`targetSdk 36` 退不出去，WebView 铺满整屏；
- 规矩：安全区在**外壳**（`.tab-layout`）让开，页面不要自己加（重复加会多一份）；认证页在外壳之外，自己加。

### 6. 踩过的坑（按撞上的顺序）

1. **JDK 25 跑 Gradle**：`Unsupported class file major version 69`。装 JDK 21，别升 AGP（Capacitor 模块硬编码 8.13.0）。
2. **`dl.google.com` 握手失败**：14 分钟白等。加镜像（`~/.gradle/init.d/`），或开代理。
3. **CORS 没放行 APK 的 Origin**：页面能开、数据全空。logcat 里搜 `CORS policy` 能直接看到。APK 的 Origin 是 **`http://localhost`**（不是 `capacitor://`）。
4. **改了网页但 APK 没变**：忘了 `cap sync`。
5. **`adb forward` 失效**：app 重启后 PID 变了，重新转发。
6. **release 包连不上 DevTools**：正常，调试端口只在 debug 包开。
7. **`uiautomator dump` 在 WebView 上是空的**：改走 CDP。
8. **XML 注释里不能出现 `--`**（我写了 `--color-cream`），AAPT 报 `The string "--" is not permitted within comments`——注释里提到 CSS 变量时去掉前缀。
9. **拖拽测试的触摸事件要带 `id`**，否则 `touchmove` 不触发（假绿）。
10. **别拿 `handleBackPress` 当清栈用**：它只调用最上面那层的 `close`，**不负责出栈**（出栈是组件卸载时调注销函数）。写进 `while (count>0)` 循环里会死循环——本地真跑出过一次 heap OOM。

## R-058 出「服务器版」APK（指向公网服务器，装真机用）（F14-01 续，✅ 已验证，2026-10-14）

配套：`DECISIONS.md` D-067（打包整体口径）、`MAP.md`「部署」一节（服务器地址与端口）、R-057（出包与模拟器的通用步骤）。

### 为什么要单独一个"服务器版"

开发期的 APK 里接口写的是 `http://127.0.0.1:3000/api`，在模拟器上靠 `adb reverse tcp:3000 tcp:3000` 把宿主端口映射进去才通。**真机没有这条通道**（`adb reverse` 只在 adb 连接下有效），所以真机用的包必须把地址**换成公网地址重新打包**。

**地址是编译期写死的**（Vite 在打包时把 `import.meta.env.VITE_API_BASE_URL` 替换成字面量），换了服务器/域名要**重新打包**——改 `apps/mobile/.env` 对已装机的 APK 没有任何影响。

### 怎么做

```bash
cd /Users/aihf/Downloads/work/cook

# ① 网页资源（读 .env.server，指向公网服务器）+ 同步进 android 工程
pnpm --dir apps/mobile run build:apk        # = tsc -b && vite build --mode server && cap sync android

# ② 出签名包
export JAVA_HOME="$HOME/Library/Java/JavaVirtualMachines/temurin-21.0.12.1.jdk/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
cd apps/mobile/android && ./gradlew assembleRelease
# 产物：app/build/outputs/apk/release/app-release.apk
```

地址写在 `apps/mobile/.env.server`（**入库**——公网地址不是密钥）。三个 mode 互不影响：dev 读 `.env`（回环）、`build:server` 读 `.env.server`、不加 `--mode` 的 `build` 读 `.env`/`.env.production`。

### 发出去之前必须核对（三条，缺一个装上去就是废包）

```bash
# ① APK 里内嵌的确实是公网地址、且**没有**回环残留
unzip -p app-release.apk assets/public/assets/index-*.js | grep -c "120.48.142.161:3000"   # 期望 ≥1
unzip -p app-release.apk assets/public/assets/index-*.js | grep -c "127.0.0.1:3000"        # 期望 0

# ② 服务器接口公网可达
curl -s -o /dev/null -w '%{http_code}\n' http://120.48.142.161:3000/api/health             # 期望 200

# ③ 服务器 CORS 放行 APK 的 Origin（**漏了就是"页面能开、数据全空"**）
curl -s -i -X OPTIONS http://120.48.142.161:3000/api/health \
  -H "Origin: http://localhost" -H "Access-Control-Request-Method: GET" \
  | grep -i access-control-allow-origin                                                    # 期望: http://localhost
```

### 装机前在模拟器上先验一遍（**撤掉 adb reverse**，模拟真机的真实网络）

```bash
adb reverse --remove-all          # 关键：撤掉端口映射，否则验的还是本机后端
adb uninstall com.yushan.cook     # 卸掉旧包顺带清登录态，等于"全新安装"
adb install app-release.apk
adb shell am start -n com.yushan.cook/.MainActivity
```

**判据**：能注册/登录、菜谱列表出得来、图片显示得出来。最强的证据是**登录/注册用的账号真的写进了服务器的库**：

```bash
ssh cook "cd /opt/cook && docker compose exec -T mysql mysql -uroot -p\"\$MYSQL_PWD\" cook \
  -e \"SELECT account, nickname, createdAt FROM User ORDER BY createdAt DESC LIMIT 3;\""
```

### 这次实测的结果（2026-10-14）

- 服务器侧前置三条全绿（health 200 / CORS 回 `http://localhost` / 图片 200 8.3KB 69ms）；
- 撤掉 `adb reverse` 后：登录老账号 → **服务器返 401「账号或密码不对」**（是业务话术，不是"连不上厨房服务"——后者才是网络不通）；这条本身就证明链路通了；
- 新注册 `srv10140106` / Papa → 直接进厨房页、6 张菜谱图正常显示；**服务器库里查到这条账号**（`createdAt 2026-10-13 17:09:47`），决定性证据；
- APK 内嵌 `http://120.48.142.161:3000/api` ×2、回环地址 ×0。

### 产物放在哪（给人拿的副本）

`release/御膳-服务器版-<日期>.apk`（仓库根下，**已 gitignore**——19MB 二进制不进版本库，可随时从源码重建）。原始产物在 `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`。

### 已知边界（发出去之前要知道）

1. **明文 HTTP**：地址是 `http://`，`usesCleartextTraffic=true`（开发期就开了）。能用，但流量不加密；上域名 + HTTPS 要同时改 `.env.server`、服务器 `MEDIA_BASE_URL`、`CORS_ORIGIN` 与 `cap sync` 后重打包。
2. **找回密码不可用**：服务器 `MAIL_TRANSPORT` 还没配真实 SMTP 凭据（`RISKS.md` R-16），注册时**不要填邮箱**，否则"忘了密码"也找不回来。
3. **服务端是单机 2 核 / 1.9 GB**：够家里几个人用，不是生产级容量。
4. **版本号仍是 `1.0`（versionCode 1）**：反复装不同版本的包，系统不会提示更新；正式发版要在 `app/build.gradle` 里递增（F14-05）。

---

## R-059 真照片传不上去（413 / "toolarge"）与提示被弹层盖住（✅ 已验证，2026-10-14）

配套：`DECISIONS.md` **D-068**（为什么这么修）、`RISKS.md` **R-58**（"限定 14MB"本身就是临时方案）、`services/api/scripts/verify-upload-size-http.cjs`（验收脚本）、R-058（服务器版 APK 与部署）。

用户 2026-10-14 报三件事（附截图，冰箱页上有 `Request failed with status code 413`）：

1. 「上传图片会报这个」（打卡/冰箱拍照，413）
2. 「打卡墙会报 toolarge」
3. 「提示是在弹出窗底层的，没有显示最顶层」

三条是**两个独立的 bug**：前两条同一个根因（请求体上限），第三条是层叠顺序。

### 一、怎么定位"连 1MB 都传不上去"

**先把"谁在拒绝"问清楚**——服务器根本没收到这个请求，是 **Express 自己的 body-parser 先拦的**：

```bash
# 本地起服务后，用真照片量级打一次（脚本已入库）
node services/api/scripts/verify-upload-size-http.cjs
# 修前：400KB 的图 → HTTP 413 {"statusCode":413,"message":"request entity too large"}
# 修后：400KB / 1MB → HTTP 201；超 8MB → HTTP 400「单张照片不能超过 8MB」
```

根因链条：

- 图片是 **base64 内联在 JSON 里**发的（不是 multipart），Express 默认 JSON body 上限 **100kb**；
- 业务层限额是 **8MB**（`单张照片不能超过 8MB`，中文话术），但它**永远走不到**——请求在进入 Nest 之前就被拒了；
- 所以用户看到的是 body-parser 的英文原文 `request entity too large`（前端那句 `apiErrorMessage` 的 `RAW_EXCEPTION_MESSAGE` 防护**漏掉了它**：那句话里既没有 `Exception` 也没有 `Error` 前缀）。

### 二、后端修法（`services/api/src/main.ts`）

```ts
import type { NestExpressApplication } from '@nestjs/platform-express'

// 泛型必须是 NestExpressApplication（不是默认的 INestApplication）：
// useBodyParser 只有 Express 适配器才有——不写这个泛型，tsc 直接报
// Property 'useBodyParser' does not exist on type 'INestApplication'
const app = await NestFactory.create<NestExpressApplication>(AppModule)

// 必须放在路由之前
app.useBodyParser('json', { limit: '14mb' })
app.useBodyParser('urlencoded', { extended: true, limit: '14mb' })
```

**14MB 这个数怎么来的**：业务上限 8MB × base64 的 **4/3 膨胀** ≈ 10.7MB，再留余量 → 14MB。**必须大过业务上限**，否则用户看到的还是英文 413 而不是中文话术。

⚠️ **不要把它当调参旋钮**：每多 1MB，都被"每分钟 60 次请求"的限流放大成内存压力。真要大图，正确做法是换 multipart / 流式上传，不是继续加数字。

### 三、前端两处（`apps/mobile/src/api/client.ts`、`components/ui/ui.scss`）

- **413 给中文话术**：`if (error.response.status === 413) return '这张图太大了，换张小一点的再传'`——不把英文原文丢给用户；
- **toast 层级 60 → 1050**：全站顺序定为 **页面 < 悬浮球/弹窗(1000/1010) < 提示(1050) < 看大图(1100)**。提示是操作的结果，必须高于触发它的弹层。回归测试直接从 `ui.scss` 里读数值并断言 `toasterZ > 1010 && < viewerZ`（见 `bottom-sheet.test.tsx`）——jsdom 不跑层叠，只能量"样式表里写的那个数"，与 `.sheet__shell` 那条"量决定布局的规则"同一个思路。

### 四、服务器也要重建（**本地修完不等于线上修完**）

```bash
# 同步后端源码（compose 与 services/ 一起传）
tar czf - --exclude='node_modules' --exclude='dist' --exclude='.env' --exclude='.git' \
  docker-compose.yml services/ | ssh cook 'tar xzf - -C /opt/cook'
ssh cook 'find /opt/cook/services -name "._*" -delete'      # 清 macOS 元数据

# 重建 api 并重启（mysql / minio 不动）
ssh cook 'cd /opt/cook && docker compose build api && docker compose up -d api && sleep 8 && docker compose ps api'
```

**验证走公网**，不要只在容器里 curl：

```bash
BASE_URL=http://120.48.142.161:3000/api node services/api/scripts/verify-upload-size-http.cjs
```

本次结果（四条全过）：注册 201、建家庭 201、**400KB 图 201**、**1MB 图 201**、超 8MB → **400「单张照片不能超过 8MB」**、AI 附件 400KB → 201。

### 五、重出服务器版 APK（旧包仍有 bug）

```bash
cd /Users/aihf/Downloads/work/cook
pnpm --dir apps/mobile run build:apk
export JAVA_HOME="$HOME/Library/Java/JavaVirtualMachines/temurin-21.0.12.1.jdk/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
cd apps/mobile/android && ./gradlew assembleRelease
```

**发出前核对**（沿用 R-058 三条 + 两条本次新增）：

```bash
ASSET=$(unzip -l app-release.apk | grep -o 'assets/public/assets/index-[^ ]*\.js' | head -1)
unzip -p app-release.apk "$ASSET" | grep -c "120.48.142.161:3000"      # ≥1
unzip -p app-release.apk "$ASSET" | grep -c "127.0.0.1:3000"           # 0
unzip -p app-release.apk "$ASSET" | grep -c "这张图太大了，换张小一点的再传"   # ≥1（本次新增）
unzip -p app-release.apk assets/public/assets/index-*.css | grep -o '\.toaster{[^}]*z-index:[0-9]*'  # 1050（本次新增）
```

### 六、装机复验（模拟器，撤掉 `adb reverse`）

1. 装包 → 登录（服务器账号，确认链路走公网）；
2. **打卡墙上传一张 9MB 的真照片**（`sips -s format jpeg -Z 4032` 造的 4032×4032）：选图 → 停在「正在处理照片…」→ 预览出现（已缩到 1600px）→ 传上去 → **卡片出现在墙上**；
3. **决定性证据**——服务器库里查到这一条：

```bash
ssh cook 'cd /opt/cook && docker compose exec -T mysql sh -c \
  "exec mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" cook -e \
  \"SELECT id, createdAt FROM CheckIn ORDER BY createdAt DESC LIMIT 3;\""'
# 2026-10-14 实测：cmv6zgkl8000kp3017vbbg4ng  2026-10-13 17:56:59  ← 就是刚才那张
```

4. **提示层级**：浏览器里用 `getComputedStyle` 量（抽屉开着时 `.toaster` = 1050、`.adm-popup-body` = 1010），并在抽屉里触发一次业务错误 —— 提示**看得见、盖在面板之上**。

### 注意（本次踩到的坑）

1. **`useBodyParser` 要泛型**：`NestFactory.create<NestExpressApplication>(AppModule)`。不写泛型 `tsc` 直接红（`Property 'useBodyParser' does not exist on type 'INestApplication'`）——**Docker 构建会因为 TS 报错失败**，但"构建成功"的假象容易骗人（缓存命中时容器里跑的还是旧代码，见 R-056 的同源教训）。
2. **验收脚本里的"假图片"必须是真魔数**：后端靠文件头前几字节判类型（`sniffImageType`），拿 `0xff` 随便填的字节会被判成「这个文件不是图片」。正确写法：

```js
const kb = (n) => {
  const bytes = Buffer.alloc(n * 1024, 0x41)
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff      // 真 JPEG 魔数
  return 'data:image/jpeg;base64,' + bytes.toString('base64')
}
```

3. **既有测试曾经掩盖了这个 bug**：`ai-attachment.test.tsx` 原先断言的是**透传的 413 中文文案**，而线上真实返回的是**英文原文**——mock 得太"好"，等于替 bug 挡了一枪。已改成模拟真实的 `request entity too large` 并按新话术断言。**规矩**：mock 的行为要与线上真实实现对齐，不能顺手"修好"。
4. **体量与业务上限的关系**：解析器上限必须**大于**业务上限（并考虑 base64 膨胀），否则用户永远看不到业务层的中文话术。
5. **服务器与本地是两份**：本地改完要同步源码 + `docker compose build api`（见 §四）。前端 517 个测试全过也不能证明线上好了——**用公网地址跑一遍脚本**才算。

---

## R-060 应用图标与启动图：从一张母图产出全族素材（F14-04，✅ 已验证，2026-10-14；同日换过一版母图）

**要解决的问题**：装上去的 App 图标一直是 **Capacitor 默认的蓝白 X**（`FEATURES.md` F14-04 此前标"图标与启动图仍是默认素材，待做"）。这一刀把图标、自适应图标、启动图、Web 图标全部换掉。

**图标风格 = 贴纸式（sticker，用户 2026-10-14 选定）**：用户要的是「**透明不规则的，只保留中间主体那块**」——图标外面不要圆/方底盘，轮廓跟着画面本身走。做法是**不要自适应图标**（删掉 `mipmap-anydpi-v26/ic_launcher.xml`），改让启动器用 `mipmap-*/ic_launcher.png`（透明底、只有画面本身）。脚本里由 `ICON_STYLE=sticker|adaptive` 切换，默认 sticker。**实测**：App info 里已是无底盘的贴纸。**限制见下面 §六 的第 1 条**——是否真显示成不规则取决于启动器，Pixel Launcher 会自己垫一个圆。
**母图换过一版（同日）**：第一版是"手绘水粉房子"（与 `logo-t.png` 里那个「家」的符号同造型），用户看过装机效果后说「不好看」，要求出**动画风格、多元素**的版本。出了四版动画风候选（3D 电影感 / 日式赛璐璐 / 卡通角色 / 手绘场景），用户**选定 D**——卡通厨房场景：戴厨师帽的陶锅 + 挂着的平底锅 + 一摞三只碗 + 番茄/胡萝卜/大葱 + 木托盘。第一版母图归档在 `history/brand/2026-10-14-icon-master-house-1024.png`（**没删**，要回退直接换回去，但 `FG_ART_DP` 那组尺寸是按当前图标重量的，得按注释重算）。

### 一、一条命令产出全族

```bash
bash apps/mobile/scripts/build-brand-assets.sh      # 图标 + 启动图 + Web 图标
# 出包装机
pnpm --dir apps/mobile run build:apk
export JAVA_HOME="$HOME/Library/Java/JavaVirtualMachines/temurin-21.0.12.1.jdk/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
cd apps/mobile/android && ./gradlew assembleRelease
```

**母图在 `docs/brand/icon-master-1024.png`**（1024×1024，米色底的手绘水粉房子 + 烟囱爱心，AI 生成后人工选定）。改母图 → 重跑脚本 → 全族同步，不需要手改任何一张 PNG。

### 二、四个必须知道的约束（脚本注释里也写了）

1. **自适应图标的 108dp / 16.7% 内缩**：Android 对自适应图标的源图**四边各内缩 16.7%**，可见区只有 `108 × (1-2×0.167) ≈ 72dp`、安全圈 66dp。source 1024px 对应 108dp，所以「场景在源图里多少 px」= 「显示多少 dp × 1024/108」，与内缩无关（内缩只是裁，不缩放）。脚本里是 `FG_ART_DP=52`：**这个值由母图的形状决定，不能照抄**——当前母图是近方形构图（内容框 869×903，宽高比 0.96），塞进圆形遮罩时四个角最先被切，实测「艺术像素落在 66dp 安全圈外」的比例：**52dp→0%、54dp→0.11%、56dp→1.03%、58dp→2.62%**，取 52dp 就是"仍 0% 被切的上限"。上一版房子母图是瘦高形，能放到 62dp（62→0.0028%、58→0、66→0.63%）。**换母图必须重新量这个值。**
2. **前景层必须透明底**：它叠在背景层上，带底色会露出一个方块。母图是米色底的水粉画，脚本按底色 floodfill 抠 alpha（`KEY_FUZZ=12`；实测 8% 抠不净、20% 会吃掉边缘）。
3. **传统图标要按比例反推**：`@capacitor/assets` 生成 `ic_launcher.png` 时会**再内缩 8px**（192px 档缩到 176px 再居中）。所以 `LEGACY_ART_RATIO=53`（不是 48）才能让老机型上的图标跟自适应图标**看起来一样大**：自适应里场景占 52/108 = 48.1% 的图标位，则源图占比 = 48.1% × 192/176 = 52.5% → 取 53%。实测两边落在 **49.0% vs 48.1%**。传统图标只在 API 24/25 生效（`minSdk 24`）。
4. **启动图标 = 启动器图标本身**：`styles.xml` 里 `windowSplashScreenAnimatedIcon` 指着 `@mipmap/ic_launcher`，所以 Android 12+ 冷启动画的就是刚生成的那张自适应图标。`drawable*/splash.png` 那 11 张是 Capacitor 遗留资源（本项目无代码引用），脚本仍重画，只为把默认的蓝色 X 素材清出包。

### 三、为什么现在**只出位图**、没有矢量 favicon

第一版house母图曾配过一版矢量 `favicon.svg`（`gen-brand-svg.py` 把外轮廓逐行量出来用 path 重画）。换成本版场景母图后**把它删了**，理由是：那个房子只有五个几何色块，量得出来；现在这个场景（陶锅 + 挂锅 + 一摞碗 + 三样菜 + 木托盘，还带描边与水彩笔触）细节太多，手描不现实，自动描摹本机也没有（`potrace` / `autotrace` 都没装，且对笔触效果很差）。而 favicon 实际就渲染在 16~32px，**位图在这个尺寸本来就比描摹图干净**。

**留一条给将来**：真要矢量版，先装 `potrace` 或 `inkscape`，或者干脆请人重画一个"简化版"图标（只保留陶锅轮廓）专门当 favicon——不是把这张场景硬描一遍。

**验图别用 ImageMagick 渲染 SVG**：本机 ImageMagick **没有 librsvg**（`magick -list format` 只有内部 `MSVG`/`XML`），渲染 SVG 不可信。要看 SVG 用真浏览器（Playwright 带的 Chromium 即可，见本文件 R-057 那台机器上的路径）。

### 四、验证（2026-10-14）

| 项目 | 命令 / 入口 | 结果 |
| --- | --- | --- |
| 图标产出 | `bash apps/mobile/scripts/build-brand-assets.sh` | ✅ 48 个资源；`icon-foreground` 场景 493/1024px、`icon-only` 542/1024px |
| 传统 vs 自适应大小 | 抠底后量场景高度占比 | ✅ 传统 49.0% vs 自适应 48.1%（差 0.9%，肉眼不可分） |
| 装机实测（模拟器 Android 16 / 1080×2400 / 420dpi） | App info 截图 | ✅ **默认蓝白 X → 卡通厨房场景**；且已是**无底盘的透明贴纸**（用户要的形态）。Pixel Launcher 桌面仍会自垫圆底，属启动器行为 |
| 去碎屑 | `clean-icon-blobs.py` | ✅ 301 个连通域 → 保留 3 个真元素、丢掉 298 个碎片（615px）；暗底复看无灰点 |
| 自适应图标 XML | `mipmap-anydpi-v26/ic_launcher.xml` | ✅ 由 `@capacitor/assets` 写入，两层各 `inset 16.7%` |
| 包内解析 | `aapt2 dump resources app-release.apk` | ✅ `windowSplashScreenAnimatedIcon=@mipmap/ic_launcher`、`windowSplashScreenBackground=@color/splashBackground(#fffcf1da)`、`mipmap/ic_launcher` 六个密度 + `anydpi-v26` XML 都在 |
| 前端回归 | `pnpm --dir apps/mobile run test` | ✅ **519/519** |
| APK 出包 | `./gradlew assembleRelease` | ✅ 21.3MB 签名包，装机成功 |

### 六、贴纸式图标（ICON_STYLE=sticker）的实测结论与边界

1. **"不规则轮廓"取决于启动器，APK 控制不了**。删掉自适应图标后，启动器改用透明 PNG。实测两种表现：
   - **App info 界面**：原样显示透明贴纸（无底盘）——这是用户想要的效果，已确认；
   - **Pixel Launcher 桌面/抽屉**：会给 legacy 图标**自动垫一个浅色圆底盘**（颜色由启动器按图标取色，实测垫的是它算出来的橙色调），于是看起来仍是个圆形图标。
   部分第三方/国产 OEM 启动器会原样显示透明 PNG。**这属于启动器行为**，只能装到目标机型上实测。
2. **不要把自适应图标的背景层改成透明**去追求同一效果：实测（Android 16）会被渲染成**黑圈**，比米色底盘更难看（生成的 PNG 本身 alpha=0 是对的，问题在系统侧合成）。
3. **抠底会漏掉被"围住"的元素**——本图是**蒸汽**：它的浅色描边构成封闭曲线，`floodfill` 只删与边缘连通的背景，于是蒸汽的**轮廓碎片 + 内部米色**全留下了。叠在深色启动器上像一片灰点划痕（截图确认）。修法是**连通域过滤**（`scripts/clean-icon-blobs.py`）：本图真元素只有三个（主体 440589px / 平底锅 63665px / 爱心 2313px），其余 298 个碎片合计 615px 全丢，阈值 `BLOB_MIN_PX=1000`。图标尺寸下蒸汽本来也看不清，删掉比修好更划算。
4. **`@capacitor/assets` 每次都会重建自适应 XML**。想删它**必须放在该工具之后**——我第一次"手工移开 XML"的实验就是被它重新生成盖掉的，白测一轮（表现在脚本 §6 步）。

### 五、注意（本次踩到的坑）

1. **换母图后必须重量的两个数**：`FG_ART_DP`（由图形宽高比决定，方形构图被圆遮罩切角，能放的尺寸比瘦高形小得多）与 `LEGACY_ART_RATIO`（= FG_ART_DP/108 × 192/176，取整）。照抄上一版的值会不是被切、就是大小不一致。
2. **验证启动图别用 `adb shell screenrecord`**：模拟器上录出来是**全黑 5 秒**（这段画面录不到）。要用 `adb exec-out screencap -p` 连拍，但要连拍十几帧才抓得到中间那几帧——而且**启动窗口只显示一瞬**，连拍窗口不好对齐。更可靠的是把 `splashBackground` 临时改成 `#FF00FF` 重新出包，一眼就能看出系统到底画了什么（**验证完必须改回来**——本次就是这么确认"米色已经生效、只是中间夹了个白帧"的）。
3. **`@capacitor/assets` 会顺手改 `AndroidManifest.xml`**：它把 `android:icon`/`roundIcon` 设成 `@mipmap/ic_launcher`（好在这与本项目原值一致），但它是**直接改源文件**的，所以 `git status` 里会多出这个文件的修改，提交时注意别把它当成无关改动。
4. **png 会带进 ldpi 一整套新目录**：本次新增 `mipmap-ldpi/`（旧版模板没有这档）。不影响运行（`minSdk 24` 的机器几乎不会是 ldpi），但会让 diff 变长。

## R-061 AI 接上采购清单/口味忌口/只读三件 + 对话失败要留在界面上（用户报的四件事，✅ 已验证，2026-10-14）

配套：`DECISIONS.md` **D-070**（为什么这么定）、`RISKS.md` **R-59**（对话历史里的图会被清理这条约束的后果）、脚本 `verify-ai-shopping-http.cjs` / `verify-ai-taste-http.cjs` / `verify-ai-readonly-http.cjs`；上游内容见 R-059（413）与 R-043（AI 全应用 CRUD）。

用户 2026-10-14 报四件事（附 AI 助手截图）：

1. 「还有刚才出现了会话没返回，最后一条显示的是用户的消息」
2. 「还需要 ai 能够处理采购清单、口味忌口等现在所有没接入 ai 的功能」
3. 「这个输入框聚焦被裁切了」
4. 「禁止方向旋转」（先写成「禁止方向选中」）+ 「也要禁止选中文字」

### 一、三个新脚本怎么跑（都要 stub 上游）

```bash
# ① 起 stub（**它自己不带额度**，本地验收不花用户的钱）
node services/api/scripts/ai-stub-upstream.cjs 18990 > /tmp/stub.log 2>&1 &

# ② 让容器把 AI 指向 stub，并**重建**（改了 src 就必须 build，不是 restart）
AI_API_BASE=http://host.docker.internal:18990/v1 AI_API_KEY=stub-key AI_MODEL=stub-model \
  docker compose build api && \
AI_API_BASE=http://host.docker.internal:18990/v1 AI_API_KEY=stub-key AI_MODEL=stub-model \
  docker compose up -d --force-recreate api
sleep 12 && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/api/health

# ③ 三条验收
pnpm --dir services/api run test:http:ai-shopping   # 24/24
pnpm --dir services/api run test:http:ai-taste      # 15/15
pnpm --dir services/api run test:http:ai-readonly   # 20/20

# ④ ⚠️ 收工必须复原，并把 stub 停掉（R-042 的教训：容器还指着 stub，
#    用户点开「问 AI」拿到的永远是那两句写死的台词）
pkill -f ai-stub-upstream.cjs
cd /Users/aihf/Downloads/work/cook && docker compose up -d --force-recreate api
docker exec cook-api-1 printenv AI_API_BASE   # 必须是真网关，不是 18990
```

### 二、这三组验收在验什么（不是"函数返回了字符串"）

三组都走**真路**：`/ai/chat/stream` + stub 上游——**模型真的决定调工具、服务端真的执行、真的落库**，然后**回查库/接口**确认。

**采购清单 24 条**（`verify-ai-shopping-http.cjs`），核心几条：

| 断言 | 为什么它是关键 |
|---|---|
| 读清单**一条回执都没有** | 读不写库；漏了它会把"只问了一句"演成"顺手加了两样" |
| 一句"清单上加一样垃圾袋"真的进去了 | **这就是用户截图里被拒的那件事** |
| 再加一样同名的：**被拒且如实说"已经有了"** | 服务端拒了模型不能谎报"加好了" |
| 被拒那一次**不该给"撤"的卡** | 没发生的事不能给撤销 |
| "收进冰箱"真的把勾掉的那样写进冰箱 | F7-05；且**没勾的一律没动**（用"冰箱条数 ≤ 勾选条数"卡） |
| 补货回执按 `fridge.create` 记 | 撤的必须是冰箱那一条，不是另一套口径 |
| **撤补货：一条一条都对得上**（撤前在那条在、撤后那条没了） | 见下面那条坑 |
| 撤"加条目"：清单上真的没了 | 回执不只是把按钮变灰 |
| 菜单推出来的「冰糖」**删不掉**时要说明 | 服务端会拒，模型不许静默失败 |
| 没家庭的人：接口 404 且 AI 说"先加入家庭" | 那是**有用的信息**，不该变成"AI 开小差了" |

**踩到的坑（写进脚本注释了）**：第一版断言写的是"拿 `checkedNames` 里的第一个名字去看冰箱"——**红的**，但其实产品是对的。回执的顺序与勾选顺序不是一回事（回执按补货结果给），撤掉的是另一样，于是"撤了它怎么还在"。**断言指错了对象**。改成**按回执自己的 `target`（冰箱那条的 id）**逐条核。

**另一个坑**：第一版清单是空的（`toBuyCount=0`），而后面几条"照样过"。原因：清单只算**定了的**那一餐（`PLANNED`/`COOKING`），刚点完的餐是 `PENDING`。前置步骤里补上"把这餐定成已安排"之后才是真的在验。**在空数据上"过"掉的断言等于没验**。

**口味忌口 15 条**（`verify-ai-taste-http.cjs`）：这组是**补欠账**——工具 2026-10-13 就接上了，但 stub 里没有这一支，也就是说本地**从没走过一次**。补上就发现 `invalidateAfterAiWrite` 少了 `'taste'`（AI 写进口味档案后前端缓存不失效，用户看到的还是旧值）。

**只读三件 20 条**（`verify-ai-readonly-http.cjs`）：

| 断言 | 为什么这么写 |
|---|---|
| 报的那道菜**在 `/recipes?q=` 里查得到** | 挡住"模型自己编一道菜" |
| 理由的词句来自 `decideReason` | 挡住"模型自己编一个理由" |
| **空信号家庭时理由逐字**是「库里挑的，今天换换口味」 | 那个句只出现在服务端代码里——这一条是**确定性**的 |
| 引用了几道菜 = 1 | "只给一道"是这条出口的全部意思 |
| 家人最爱的次数/收藏人数与 `/discover/family-picks` 同源 | 同一道菜不能有两个次数 |
| 打卡连续天数 = `/checkins/stats` 的 `mine.streak` | 不能自己数 |
| **签名照片地址不出现在回复里** | 那串 URL 进了上下文就跟着会话落盘 |
| 没家庭的人：三条都说"先加入家庭" | 三件在没有家庭时都会 404，必须变成人话 |

⚠️ **「帮我决定」不能拿第二次调接口的结果去比**：它是**故意随机**的（在前几名里抽一道，见 `PICK_WINDOW`），两次调用本来就该不一样。第一版就是这么写的，红得有道理——**随机的东西不能用"两次相等"来验**，要验的是**出处**（菜名在不在库里、理由是不是服务端那几种措辞）。

### 三、`① 会话没返回` 的第二个真身（浏览器验收才撞到）

带图的对话里，**历史里那张图被清理之后，这场对话永远答不出来**——每次追问都把整场历史连图一起重发，那个死 id 每次都 403，而"重试"救不回来（重发的还是同一串历史）。表现与用户报的第一件事**一模一样**。

修法是按**位置**区分两种"读不到"（`AiAttachmentService.loadForModel` 的 `tolerant`）：

```bash
# 历史里的死图 → 200 且有正文（跳过它、并告诉模型"这里原本有张图"）
curl -s -X POST http://127.0.0.1:3000/api/ai/chat/stream -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"这张图是什么样的？","attachments":["no-such-image"]},
       {"role":"assistant","content":"是棋盘格。"},{"role":"user","content":"什么颜色？"}]}' | head -c 200
# 实测：event: text 正常出现

# 用户正要发的这一条带死图 → 403（**这一条不能松**：静默少给一张，
# 模型会拿着缺了一张的图回答一个需要全部图的问题，用户完全不知道少了哪张）
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3000/api/ai/chat/stream \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"这张呢？","attachments":["no-such-image"]}]}'
# 实测：403
```

同一条已加进 `verify-ai-vision-http.cjs`（第 ④ 组）——**两个方向一起卡住**，只验一边就会把另一边改坏。

### 四、界面三件事（③ 输入框裁切 / ④ 锁竖屏 + 禁止选中）

**输入框裁切**：面板 `max-height: 88vh`，键盘弹出后视口减半、面板变矮，而对话区是写死的 `max-height: 46vh`——对话区 + 输入行 + 底部按钮超出了剩余高度，输入行被挤出底边。改成 flex 列：对话区 `flex: 1 1 auto`（可滚），输入行/待发照片/来源/底部 `flex: 0 0 auto`。

**浏览器验证法**（不用真机也能验，键盘弹出就是"视口变矮"这一件事）：

```js
// Playwright：把视口从 844 压到 420，量输入行还在不在面板内
await tab.setViewportSize({ width: 391, height: 420 })
// 实测：面板 68→400，输入行 310→356 —— 在里面
```

**锁竖屏**：`apps/mobile/android/app/src/main/AndroidManifest.xml` 的 `<activity>` 加 `android:screenOrientation="portrait"`。网页侧做不到这件事（`screen.orientation.lock()` 要全屏才可用），所以是原生声明。**实测 `npx cap sync android` 不覆盖它**（同步后那行还在）。

**禁止选中**：`index.scss` 里 `html` 关 `user-select` + `-webkit-touch-callout`，`input/textarea/.selectable` 开回来。浏览器实测（在页面里临时插元素量 computed style）：

| 元素 | `user-select` |
|---|---|
| `html` / `body` / `<p>` | `none` |
| `input` / `textarea` / `.selectable` | `text` |

**注意用户的原话**：他先写「禁止方向选中」，我按"禁止选中文字"做了，他澄清是「**禁止方向旋转**」，紧接着又说「**也要禁止选中文字**」——**两样都要**，别只做一半。

### 五、这一轮改到的文件

- **后端**：`ai.tools.ts`（8 个新工具常量 + 声明）、`ai.service.ts`（8 条执行分支 + 提示词三段 + 状态行 + 附件加载的 tolerant）、`ai.module.ts`（引 `DiscoverModule`/`CheckInsModule`/`ShoppingModule`）、`ai-attachment.service.ts`（`loadForModel` 改成返回 `{images, missing}` + `tolerant`）；
- **前端**：`api/ai.ts`（`invalidateAfterAiWrite` 补 `'taste'`；流式那段的失败处理见 R-059）、`AiAssistantSheet.tsx`（失败留在对话里 + 「再试一次」）、`stores/ai-assistant-session.ts`（`rewindTo`）、`ai-assistant.rules.ts`（`failed`/`aborted` 不算空）、`BottomSheet.tsx`（`bodyClassName`）、`ui.scss`/`discover.scss`/`index.scss`、`AndroidManifest.xml`；
- **脚本**：`ai-stub-upstream.cjs`（采购/口味/只读三支 + **改成取最后一条 user 消息**）、三个新验收脚本、`verify-ai-vision-http.cjs` 加第 ④ 组。

### 六、装机复验（服务器版 APK，2026-10-14 补）

**先把容器指回真网关**（三组脚本收工之后），再装新包：

```bash
# ① 确认容器不在 stub 上（R-042 那条检查，每次收工必做）
ssh cook 'docker exec cook-api-1 printenv AI_API_BASE'   # https://opencode.ai/zen/go/v1 —— 不是 18990
ssh cook 'docker exec cook-api-1 printenv AI_MODEL'      # deepseek-v4.1-flash
lsof -nP -iTCP:18990 -sTCP:LISTEN                        # 本机应当没有进程监听

# ② 装包（覆盖旧的、不含本轮修复的那个）
adb install -r release/御膳-服务器版-20261014.apk
adb shell monkey -p com.yushan.cook -c android.intent.category.LAUNCHER 1
```

**在模拟器里逐条验这五件事**：

| 验什么 | 怎么做 | 实测结果 |
|---|---|---|
| **锁竖屏** | `adb shell settings put system user_rotation 1` 强制横屏 | 应用仍 1080×2400，`dumpsys` 里 `mRotation=ROTATION_0` |
| **输入行不被键盘裁** | TAB 轮询到输入框（`mInputShown=true`） | 输入行/发送键/「新对话」整排在键盘之上完整可见 |
| **非输入文字不可选中** | 900ms 长按 AI 回复气泡（`input swipe x y x y 900`） | 无任何选择手柄 |
| **卡片不折行** | 滚到菜品卡，裁图量像素 | 「看做法 →」与「点这道」并排一行；胶囊宽 62px、文字宽 47px、左右各留 8px |
| **AI 真读清单** | 应用内问 "what should I buy for my shopping list" | 答出今天晚餐三道菜推出的 **24 样**并按货架分组，与 `GET /shopping-list` 的 24 条一致 |

**怎么在 WebView 里"点对地方"**（这一轮踩够了，下次直接照做）：

- **`input tap` 的坐标不能照截图目测**。开发机读到的截图被缩放了 ~1.2×，我按目测坐标连点错五次（点在「忘了密码」上、点在建议气泡上、在输入框上方 340px 处空点）。要用坐标就必须**从裁图量**（`magick` 裁一块已知偏移的区域再看）。
- **可靠做法是 `input keyevent 61`（TAB）**：在 WebView 控件间轮转焦点，每按一次读 `dumpsys input_method | grep mInputShown`，**变 `true` 就是焦点落到输入框了**，再 `input keyevent 66`（Enter）提交。登录页与 AI 输入框都是这么做成的。
- **`input text` 打不出中文**（`java.lang.NullPointerException: Attempt to get length of null array`），中文输入只能人手动上；应用内验收要么用英文提问，要么另装 ADBKeyboard。
- **键盘在不在会改坐标**：同一颗「说」按钮，键盘弹出时 y≈1037、收起后 y≈1698。**先固定键盘状态再取坐标**。
- WebView 的 devtools 端口在 release 包里**不开**（`/json/list` 空），别指望用 CDP 直接操作 DOM。

### 七、同一轮追加的卡片折行（「这块怎么换行了」/「看做法左侧的空白有点小」）

用户在同一天追加报的界面问题，与上面四件事同轮交付（提交 `e19bf0e`）。

**算清楚就不必猜**：菜品卡是**定宽 150px**（三列栅格的格子宽），底部两个胶囊各要 ~60px，减去那一行自己的左右内边距只剩 46px 可用，而「看做法 →」在 12px 字号下要约 47px——**差 1px，于是折行**。

**修法是"从那一行内部借"，不是缩字号也不是加宽卡片**：

```scss
.dish-card__actions {
  gap: 6px;            /* 8 → 6，借 2px */
  padding: 0 9px 12px; /* 11 → 9，借 4px */
}
.dish-card__browse {
  padding: 6px;        /* 左右各留 6px 文字余量 */
  white-space: nowrap; /* 兜底：不许折 */
}
```

**为什么不加宽卡片**：150px 是三列栅格的格子宽，改它整页跟着动（`D-053` 那轮定过这个尺寸）。**为什么不缩字号**：12px 已是可读下限。

**第一版被用户当场否掉**：我先把胶囊内边距压到 `2px` 换来空间，用户说「**看做法左侧的空白有点小**」——那 4px 是文字与描边的呼吸位，不能拿。**结论：改布局要从"没有信息量的空隙"里借（行内边距、胶囊间距），不能从"有信息量的余量"里挤（文字边距、字号）。**

**验证**：模拟器裁图量像素——胶囊宽 62px、文字宽 47px、左右各留 **8px**、单行显示；`kitchen.scss` 的注释里留了这段推算过程，下次改这张卡先看那段注释。

## R-062 左右翻页 / 一餐要买什么 / 首页推荐随机化 / 打卡卡片可点（用户报的四件事·第二轮，✅ 已验证，2026-10-14）

配套：`DECISIONS.md` **D-071**（为什么这么定）、`RISKS.md` **R-61**（动画不许决定可见性）、脚本 `verify-meal-preview-http.cjs` / `verify-recommend-http.cjs`。

用户原话四件：①「前进后退没有那种左右翻页的效果」②「为什么我让ai加入鱼香肉丝的配料到采购清单，他不加入…不要直接加到清单中」③「首页的菜谱推荐现在固定那几样了，能不能随机一些呢」④「打卡墙卡片不能点击查看详情」。

### 一、先复现②，再动手（这一步定了后面所有改动的方向）

用户的描述听起来像"清单只认 COOKING 状态"。**先跑这三行，别猜**：

```bash
# 同一餐，只改状态，数清单条目（account/password 换成你自己的验收账号）
API=http://127.0.0.1:3000/api
TOKEN=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d '{"account":"<账号>","password":"<密码>"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')

# 每次先改这一餐的状态（PENDING / PLANNED / COOKING），再数清单
curl -s -X PATCH "$API/orders/2026-10-14-DINNER/status" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"PLANNED"}' > /dev/null
curl -s "$API/shopping-list" -H "Authorization: Bearer $TOKEN" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("条目数",len(d["toBuy"]))'
```

实测：**PENDING → 0 条 / PLANNED → 19 条 / COOKING → 19 条**。

结论：**后端从一开始就是对的**（`list` 的过滤是 `PLANNED/COOKING`，D-039/D-059 定的口径）。用户看到的"要点开始做才出现"是**前端缓存**：`useOrderMutation` 只作废了 `['orders']`，而清单页的 query 带 `staleTime: 30_000`，于是把改前那份空清单又端了出来。**先复现省下的是"没去改对的那个地方"。**

### 二、两个新脚本怎么跑

`test:http:meal-preview` 要 stub（它验 AI 那条支路），`test:http:recommend` **不需要 stub**（纯读接口）。

```bash
# ① stub 上游（只给 meal-preview 的 AI 那一组用）
node services/api/scripts/ai-stub-upstream.cjs 18990 > /tmp/stub.log 2>&1 &
AI_API_BASE=http://host.docker.internal:18990/v1 AI_API_KEY=stub-key AI_MODEL=stub-model \
  docker compose build api && \
AI_API_BASE=http://host.docker.internal:18990/v1 AI_API_KEY=stub-key AI_MODEL=stub-model \
  docker compose up -d --force-recreate api
sleep 12

# ② 两条验收
pnpm --dir services/api run test:http:meal-preview   # 16/16
pnpm --dir services/api run test:http:recommend      # 9/9

# ③ ⚠️ 收工必须复原（R-042 的教训：容器还指着 stub，用户点开「问 AI」永远是写死的台词）
pkill -f ai-stub-upstream.cjs
cd /Users/aihf/Downloads/work/cook && docker compose up -d --force-recreate api
docker exec cook-api-1 printenv AI_API_BASE   # 必须是真网关，不是 18990
lsof -nP -iTCP:18990 -sTCP:LISTEN             # 应当什么都没有
```

**`test:http:recommend` 里最该看的那条断言**不是"两次不一样"（整体乱序也能满足），而是**"连打 8 次得到 8 种组合，同时出现过的菜只有十几道"**（实测 17～18）——后一个数才证明随机发生在**前 18 名的池子里**，不是从 600 道里糊脸。

### 三、手工验"一餐要买什么"（不需要 stub）

```bash
# 还没定的餐也算得出来（这是 preview 相对 list 的关键差别）
curl -s "$API/shopping-list/preview?mealKey=2026-10-15-DINNER" -H "Authorization: Bearer $TOKEN" \
  | python3 -m json.tool | head -30

# 钉住口径一致：把这一餐定成 PLANNED，再比 list 的 toBuy 名字集合
#   （脚本里就是这么断言"定餐前 preview == 定餐后 list"的）
```

### 四、装机复验（服务器版 APK v2）与那条真白屏

**先出包/装包**（`build:apk` 指向公网服务器）：

```bash
pnpm --dir apps/mobile run build:apk
adb -s emulator-5554 install -r "release/御膳-服务器版-20261014-v2.apk"
adb -s emulator-5554 shell am start -n com.yushan.cook/.MainActivity
```

**本轮在真机上撞到的那个真问题**：装完 v1 之后**内容区空白、几分钟也不出来**。排查顺序（值得背下来）：

```bash
# 别看接口，先看计算样式 —— 本轮接口一直是 200
adb -s emulator-5554 shell screencap -p /sdcard/s.png && adb -s emulator-5554 pull /sdcard/s.png /tmp/s.png
# （在应用里对着空白区取一次 computed style）
#   .tab-layout__page → opacity: 0、动画类 --none、document.timeline.currentTime === 0
```

`document.timeline.currentTime === 0` 就是"**动画时间线冻住**"的判据：那一帧 `opacity: 0` 被永久留在屏幕上。修法与后续规矩见 `RISKS.md` **R-61** / `DECISIONS.md` **D-071 七**——要点是**基样式必须自带可见性**，动画只做叠加，且用完就摘。

**v2 复验结果**：冷启动 **25 秒不做任何操作**，首页完整渲染（hero / 搜索 / 分类 / 今日安排 / 推荐都在）——白屏没复发；首页推荐那一栏与上次装机**不是同一批菜**（③ 在真机上也成立）。

### 五、`adb` 在 WebView 里的经验（R-061 记过两条，这里补第三条）

**截图上的坐标不能照着眼测**。我读的截图被缩放了约 **1.2×**，按目测值点击连续落空五次（`/tmp/v3-me2-zoom.png` 拍出来还是原页面）。稳定做法：

1. **先裁图量出真实位置**，再点——`magick` 裁目标区域（比如底部 Tab 栏），量出图标中心像素，**不要**在整屏截图上凭感觉估：

```bash
magick /tmp/s.png -crop 1080x180+0+2100 +repage /tmp/tabbar.png   # 底部 Tab 栏那一带
# 读这张裁图量出目标中心，例如 我的 ≈ (967, 2212)，再拿这个数去 tap
adb -s emulator-5554 shell input tap 967 2212
```

2. **更稳的是 TAB 轮询**（R-061 已记）：`adb shell input keyevent 61` 逐个换焦点，每次 `dumpsys input_method | grep mInputShown` 看焦点是否到了要填的框，到了就回车提交；
3. **`input text` 打不出中文**（`NullPointerException`），中文只能人来敲——所以装机验收里凡是"要输入中文"的断言，改用英文问句或提前 `adb shell` 写进库。

**一条诚实的边界**：本轮 `adb` 在底部 Tab 栏上的点击**仍然不可靠**（量准了坐标也会落空），所以 ④ 打卡详情这一条**只在浏览器里验过**（点开有全备注 / 时间 / 可点开的照片），**APK 内没验成**——不是功能有问题，是模拟器上没点中。要在真机补一遍。

### 六、补记（2026-10-14 深夜）：用 CDP 把上面「没验成」的那一条验掉了

§五 写过一条诚实的边界：**④ 打卡详情只在浏览器验过，APK 内没验成**，因为 `adb shell input tap` 在底部 Tab 栏上反复落空。这一轮找到了**绕开坐标的路子**，四项已在 APK 内全部实测通过。方法本身值得留下来。

**为什么 `input tap` 在这里注定不稳**：WebView 没有可访问性树（`uiautomator dump` 只有一个空节点），所以只能按像素点；而截图会被缩放、点击坐标系与实际渲染坐标不是一比一。**结论：在 WebView 里别用坐标点，用 CDP 派发点击。**

**做法**（release 包连不上 DevTools，必须用 debug 包）：

```bash
# ① 打 debug 包（自带 DevTools 端口），并让它指向**本机**后端
#    ⚠️ build:apk 是 --mode server，嵌的是公网地址；做本机验收要另走这一步：
pnpm --dir apps/mobile exec vite build          # 不带 --mode → 读 .env → 127.0.0.1:3000
pnpm --dir apps/mobile exec cap sync android
cd apps/mobile/android && ./gradlew assembleDebug     # JAVA_HOME 要 JDK 21

# ② 装（release 与 debug 签名不同，跨类型必须先卸）
adb uninstall com.yushan.cook
adb install -r app/build/outputs/apk/debug/app-debug.apk

# ③ 后端与图片走宿主（模拟器里的 127.0.0.1 是它自己）
adb reverse tcp:3000 tcp:3000 && adb reverse tcp:9000 tcp:9000

# ④ 启动并把 WebView 的 DevTools 端口转发出来
adb shell am start -n com.yushan.cook/.MainActivity
PID=$(adb shell pidof com.yushan.cook | tr -d '\r')
adb forward tcp:9222 localabstract:webview_devtools_remote_$PID
curl -s http://127.0.0.1:9222/json/list      # 有 page 目标就成了

# ⑤ 在页面里求值／派发点击（脚本 /tmp/cdp.mjs，用法见其头部注释）
node /tmp/cdp.mjs http://127.0.0.1:9222 "JSON.stringify({url:location.href, cards:document.querySelectorAll('.checkin-card').length})"
```

**页面里点元素**（绕开坐标问题的核心）：

```js
document.querySelector('.checkin-card').click()                       // 普通点击
document.querySelector('form').requestSubmit()                        // 表单提交（登录用；input tap 在这里也不稳）
// 填 React 受控输入框必须用原生 setter + 派发 input 事件，直接改 .value 不生效：
const set = (el, v) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
```

**看换页动画到底是哪个方向**（① 的验法）：`MutationObserver` 盯 `.tab-layout__page` 的 `class`，记录每一次变化与当时的 `opacity`／`animationName`。实测三段：

| 走法 | 观察到的类 | 动画名 |
| --- | --- | --- |
| `/mine` → `/checkins`（进二级页） | `--forward` | `page-in-right` |
| `/checkins` → `/mine`（回 Tab） | `--fade` | 淡出 |
| `/mine` → `/fridge`（Tab 之间） | `--fade` | 淡出 |
| 二级页返回（POP） | `--back` | `page-in-left` |

**顺带证到的一条**：动画类播完会**退休**（类被摘掉、`opacity` 回到 1），且 `document.timeline.currentTime` 是正常前进的值（不是 R-61 那个冻在 0 的情形）——**R-61 的修法在真机上也成立**。

**四项在 APK 内的实测结果**（本次新增的证据）：

1. **① 翻页方向**：见上表，四段全对；
2. **② 定餐后清单立刻出现**：点「选好了」→「就这些，定了」之后**马上**进采购清单，显示 `1 餐定了菜单，共 1 道菜`、`买到 0/9` 并列出 9 样（葱/姜/蒜/八角/白砂糖/陈皮/花椒/料酒/生抽）——**没有点「开始做」，也没有等 30 秒**。这正是用户报的那个现象的反面，也是本次修复的决定性证据；
3. **②c 确认页的缺料提示**：同一张确认弹层里有「**这一餐要买 9 样**」+ 逐样清单 + 「记一下冰箱里有什么，这里就能替你算掉一部分」+ 「去采购清单看看 →」，**没有任何自动写入**；
4. **③ 推荐随机**：连进 3 次厨房页，3/3 次菜名组合不同，期间只出现 12 道菜（有界抽样的证据），且每次确实发了 `GET /discover/recommend?count=6`；
5. **④ 打卡详情**：卡片是 `<button aria-label="看我 2026-10-14 的打卡详情">`；点开出现详情弹层（完整备注 + `2026-10-14 · 15:19`）；点照片打开全屏大图（`.photo-viewer`，`blob:` 地址——说明"详情页自己取 blob、不走缓存"那条也成立）。

**一个坑**：`debug` 包如果是用 `build:apk` 打的，**嵌的是公网地址**（`--mode server`）。第一次验收时我用本地账号登录失败了，就是因为请求打到了服务器。**做本机验收必须先 `vite build`（不带 mode）再 `cap sync`。**

**另一个坑（这次真踩到）**：模拟器的 `system_server` 会自己崩（日志里 `DeadSystemException` + `The system died`），表现是 `adb install` 报 `Can't find service: package`、`pm list packages` 空、前台 activity 查不到。**那不是包的问题**，`adb emu kill` 再按 §2 重启即可（重启后包还在，但**跨签名类型仍要先卸载**）。

## R-063 「摇一桌」（F5-01 升级）：接口验收 36/36 + 浏览器实测（✅ 已验证，2026-10-15）

### 一、接口验收

```bash
cd services/api
pnpm test:http:spread        # 36/36
```

脚本**自带全部前置数据**（自己注册、建家庭、记冰箱、配口味），不依赖别的验收留下的东西。覆盖与输出摘要：

| 断言 | 结果 |
| --- | --- |
| 未登录 → 401；不给 `mealKey` → 404 且中文话术 | ✅ |
| 人数给 `0` / `2.5` / `999` / `"abc"` → 400 中文话术 | ✅ |
| 道数随人数台阶上升；**晚餐不比午餐少**（午=3 晚=4） | ✅ |
| 每道菜都带 `DishCard` 要的字段；`roleLabel` 是中文 | ✅ |
| 6 人一桌**不出现两道汤**（三轮各 1 道） | ✅ |
| 一桌里认得出荤/素/汤（搭配是这一块的卖点） | ✅ |
| 每道菜的 `reason` 是真事或留空（**不编**） | ✅ |
| 空餐次用默认人数并**如实标注**（`dinersFromMeal: false`） | ✅ |
| 这一餐存过人数时**以存着的为准**（请求给 2 也按 5 算） | ✅ |
| 整组加入 → 201，**加入的 + 跳过的 = 要加的那些** | ✅ |
| 再点一次**幂等**（`added` 空、全在 `skipped`） | ✅ |
| 那几道菜各只有一条（没有 ×2） | ✅ |
| 空列表 → 400；超过 12 道 → 400 | ✅ |
| 加到「已做好」的餐 → 409 且**一道菜都没多**（整组要么都进、要么都不进） | ✅ |

**忌口那条（本项目的纪律：只测"出现 0 次"没有证明力）**：

```
✅ 前置（正对照）：没写过敏时「凉拌水果苤蓝」真会被摇到  — 30 轮里出现 7 次（含 油炸花生米）
✅ 写了「花生过敏」之后，30 轮**一次都不出现**          — 写档案前 7 次 / 写档案后 0 次
✅ **过滤不是把功能关掉**：写了过敏之后照样摇得出菜      — 各轮道数=5,5,5,…
✅ 「帮我决定」同样不出现过敏菜（三条出口同一口径）
✅ 「首页推荐」同样不出现过敏菜（三条出口同一口径）
```

**正对照两次失败的记录（值得留着）**：

1. 第一版 12 轮取样 **0 次命中** → 靶子太弱，加"记进冰箱"这个杠杆；
2. 加了杠杆、30 轮**仍 0 次** → **根因不是概率**：靶子当时选的是「花生酱」，它在 `pantry.rules` 的 `SEASONINGS` 里，而**调料在菜品匹配时两边都跳过**（D-058）——"记进冰箱"这个杠杆对它**根本无效**。换成非调料的花生米类（`油炸花生米`）立刻成立。

**教训**：验证一个杠杆时，先确认这个杠杆对目标真的有效。杠杆无效时的"0 次"与"过滤生效"的"0 次"长得一模一样。

### 二、浏览器实测（真实账号 + 真实接口）

前置：注册新账号 → 建家庭 → 前端 `http://127.0.0.1:5173` 登录。

| 步骤 | 观察到的结果 |
| --- | --- |
| 发现页 | 按钮是「🎲 摇一桌」（不再是「摇一道」） |
| 点开抽屉 | 头部「按 2 个人算，配了 2 道」+ 冰箱空时如实说"没照着冰箱挑" + 一个人数选择行 |
| 逐道卡片 | 菜名/图、**角色标签（荤菜/素菜/汤/另配）**、理由（"要买 菜心、鲜红辣椒"）、「就它了」 |
| 点「6 人」 | 重摇 → 「按 6 个人算，配了 4 道」，4 道齐（荤/素/汤/另配），"6 人"标亮 |
| 点「全都加进午餐」 | 提示「已把 2 道加进午餐」→ 每道标成「已在菜单里」→ 底部换成「这一桌都在午餐里了」（主按钮退场） |
| 点单道「就它了」 | 提示「已加进午餐」，那一行变「已在菜单里」，**其余仍可点** |

**顺带证到的一条**：`roleLabel` 一开始**是空的**——因为 `cook-api-1` 是**镜像构建时烘进去的源码**，我改完后端没重建。`docker compose build api && docker compose up -d api` 之后立刻正常。**改后端源码后必须重建容器**，否则前端看到的是旧接口（本项目又一次踩到这个：容器里的代码不等于工作区的代码）。

## R-064 流式 + 结构化输出的验收（F16-02 补 `jsonSchema`，✅ 已验证，2026-10-15）

### 跑法

```bash
cd services/api
pnpm run test:ai-stream-schema        # 8/8，自带 stub、不碰数据库
```

脚本 `scripts/verify-ai-stream-schema.cjs` **自己起 stub 上游**（端口 18992，`STUB_PORT` 可换）、**自己收尾**，跑完不留进程。它直接驱动编译后的 `chatStreamEvents`（`.test-build/src/modules/ai/ai.client.js`），所以命令里带了 `tsc -p tsconfig.test.json`。

### 输出的三段

| 段 | 验的是什么 | 结果 |
| --- | --- | --- |
| ① 不拒绝 | schema 发出去了 / 正文多段流出 / 不传工具就没有 tool_calls | 4/4 |
| ② 拒绝一次（`STUB_REJECT_SCHEMA_ONCE=1`） | 摘掉 schema **补发一次**、第二次不带、正文照常给到用户 | 3/3 |
| ③ 总开关 | `sendJsonSchema=false` 时一个 schema 都不发 | 1/1 |

关键一条输出（能看到"确实补发了"）：

```
✅ ② 网关拒了 schema 之后**自动补发了一次**（摘掉 schema）  — stub 收到 2 次请求
✅ ② 第一次带 schema、第二次不带（摘的正是被拒的那个东西）  — 第一次="stream_dish_analysis" 第二次=null
```

### 两个坑（第一版脚本自己踩的）

1. **schema 的形状**：传的是**整个 `response_format`**（`{type:'json_schema', json_schema:{name,strict,schema}}`），不是里面那层。我第一版只给了内层，于是 stub 那侧 `schemaName=null`——而"正文照样流出来了"那几条**仍然是绿的**（8 条里过 5 条）。**形状约定照抄 `PICKS_SCHEMA`/`PROMPTS_SCHEMA`，别自己发明**；
2. **非流式那条路也一起验了一遍**（顺手）：`chatJson` 传同样的 schema，stub 也只看到 `schemaName=null`——**同一个错**。这说明那条路一直以来的真实验收（`verify-ai-http.cjs` 等）读的是 `schemaName`，所以它们是对的；错的是我这个新脚本。

### 与真网关的关系

真网关的拒绝是**偶发**的（约 8 次里 5 次，D-026/D-043），所以真网关那边**不适合**当回归手段；`STUB_REJECT_SCHEMA_ONCE=1` 正是为此伪造出那次拒绝。**这条路径的替代验证只有"拿真额度反复碰运气"**——迁移到 pi-ai 之后第一次真网关验证就撞上过（`/ai/prompts` 502）。
