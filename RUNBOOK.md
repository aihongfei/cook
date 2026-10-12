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
