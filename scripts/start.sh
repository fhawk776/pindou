#!/bin/bash
# 启动拼豆店服务（PM2）
set -euo pipefail

cd /opt/pindou

# 若已存在同名进程，先删除（幂等）
pm2 delete pindou-api 2>/dev/null || true

# 用 Node 的 --env-file 加载 .env（Node 20.6+ 支持）
pm2 start "node --env-file=.env dist/server.js" --name pindou-api

pm2 save
sleep 3

echo "===== PM2 状态 ====="
pm2 status pindou-api
echo ""
echo "===== 健康检查 ====="
curl -s http://127.0.0.1:3100/healthz || echo "健康检查失败"
