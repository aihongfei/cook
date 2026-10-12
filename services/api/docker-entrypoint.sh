#!/bin/sh
# 容器启动入口：先建表/升级表结构，再拉起服务。
#
# 这里直接用 node_modules/.bin/prisma 而不是 `pnpm exec prisma`：
# pnpm 在跑脚本前会校验 node_modules 与 lockfile 是否一致（verifyDepsBeforeRun），
# 容器里依赖是构建期烘进去的，那次校验只会白跑一次安装并在受限网络下报警。
# compose 里已用 mysql healthcheck 保证"数据库可连接"才启动本容器，
# 但 MySQL 首次初始化仍需一点时间，这里做一次有限重试兜底。
set -e

attempt=1
max_attempts=10
while [ "$attempt" -le "$max_attempts" ]; do
  if ./node_modules/.bin/prisma migrate deploy; then
    break
  fi
  echo "[api] 迁移失败（第 ${attempt}/${max_attempts} 次），5 秒后重试…"
  attempt=$((attempt + 1))
  sleep 5
done

if [ "$attempt" -gt "$max_attempts" ]; then
  echo "[api] 迁移多次失败，放弃启动" >&2
  exit 1
fi

echo "[api] migrations applied, starting server…"
exec node dist/main
