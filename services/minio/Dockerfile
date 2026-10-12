# 自建 MinIO 镜像 —— 用 MinIO 官方发布的 server 二进制，而不是任何第三方打包镜像。
#
# 为什么自建（2026-10-12 实测）：
#   ① MinIO 官方 Docker 镜像已不可获取：`docker pull minio/minio` 报 repository does not exist
#      （同期 `alpine` 可正常拉取，排除网络问题），`quay.io/minio/minio` 返回 401 UNAUTHORIZED；
#   ② 之前临时用的 `bitnamilegacy/minio` 是归档仓库、不再更新，不适合长期依赖；
#   ③ 官方直发地址 `dl.min.io/server/minio/release/...` 现在返回 **410 Gone**（停发免费二进制），
#      但 **官方中国镜像站 `dl.minio.org.cn` 仍提供二进制**，本镜像即从该站取。
#
# 但二进制本身仍是 MinIO 官方发布的产物（不是别人二次打包的），并做了 sha256 校验：
# 上游一旦换版本，构建会**直接失败并报哈希不符**，而不是悄悄装上一个不一样的东西。
#
# 构建：
#   docker compose build minio          # 本机构建（自动按当前架构选 arm64/amd64）
# 只改版本号时记得同步更新下面的 sha256（两条命令：下载 → sha256sum）。

FROM alpine:3.20

# MinIO 发布版本（固定，不用 latest —— 镜像要可复现）
ARG MINIO_RELEASE=RELEASE.2025-04-22T22-12-26Z
# 上面的版本对应官方二进制的校验值，按架构区分（TARGETARCH 由 BuildKit 自动注入：arm64 / amd64）
ARG MINIO_SHA256_ARM64=6c2f3142c94240206123177f4ba1e360daa5d1e0a4962e90757ef4f92c3ab57c
ARG MINIO_SHA256_AMD64=53e2a2cb16c5366ea6fbbc479c19ddb4c6a0948273e752f740fb1fbf27bb817c

# 中国镜像站默认；海外服务器可用 build arg 覆盖为 https://dl.min.io
ARG MINIO_DOWNLOAD_BASE=https://dl.minio.org.cn/server/minio/release

RUN set -eux; \
    apk add --no-cache ca-certificates curl; \
    case "${TARGETARCH:-$(apk --print-arch)}" in \
      arm64|aarch64) arch=arm64; sum="${MINIO_SHA256_ARM64}" ;; \
      amd64|x86_64)  arch=amd64; sum="${MINIO_SHA256_AMD64}" ;; \
      *) echo "不支持的架构：${TARGETARCH}"; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/minio \
      "${MINIO_DOWNLOAD_BASE}/linux-${arch}/archive/minio.${MINIO_RELEASE}"; \
    echo "${sum}  /usr/local/bin/minio" | sha256sum -c -; \
    chmod +x /usr/local/bin/minio; \
    apk del curl

# 数据卷挂载点（compose 的 minio-data 卷挂到这里）
VOLUME ["/data"]

ENV MINIO_ROOT_USER="" \
    MINIO_ROOT_PASSWORD="" \
    MINIO_BROWSER_REDIRECT_URL=""

EXPOSE 9000 9001

# healthcheck 用镜像自带的二进制（`minio --version` 足够判断进程可执行），
# 不依赖 curl/wget —— 它们在构建末尾已被移除，容器里保持最小。
HEALTHCHECK --interval=5s --timeout=5s --start-period=15s --retries=30 \
  CMD ["minio", "--version"]

# 入口固定为 server 模式：/data 为数据目录，:9001 为网页控制台
ENTRYPOINT ["minio", "server", "/data", "--console-address", ":9001"]
