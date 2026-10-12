# 后端 API 镜像：NestJS 12 + Prisma 6 + MySQL 8
#
# 说明：运行时保留了 devDependencies —— `prisma` CLI 是 devDependency，保留它让容器内的
# entrypoint 能执行 `prisma migrate deploy`。换来的是单镜像搞定建表，代价是镜像略大；
# 对家庭应用而言比"再拆一个 migrate 镜像"更省心。
FROM node:24-alpine AS base
# 国内网络下 npm 下载很慢，可用 --build-arg NPM_REGISTRY=https://registry.npmmirror.com 换源
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN npm config set registry "$NPM_REGISTRY" && npm i -g pnpm@12.11.2
# Prisma 引擎在 alpine 上需要 openssl
RUN apk add --no-cache openssl
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --trust-lockfile

FROM deps AS build
COPY . .
RUN pnpm exec prisma generate && pnpm run build

FROM base AS runner
ENV NODE_ENV=production
# 容器里的依赖是构建期烘进去的，运行时不需要 pnpm 再校验/补装一次
# （否则 entrypoint 里的 `pnpm exec` 会尝试联网安装，在受限网络的服务器上会报警甚至失败）
ENV npm_config_verify_deps_before_run=false
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
EXPOSE 3000
CMD ["./docker-entrypoint.sh"]
