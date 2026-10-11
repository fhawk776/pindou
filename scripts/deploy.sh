#!/bin/bash
# 拼豆店会员系统 - 服务器部署脚本
# 由部署流程自动执行，密码从 /tmp/pindou-secrets.txt 读取，不回显
set -euo pipefail

# 读取密钥（文件格式 KEY=value，值为字母数字，source 安全）
source /tmp/pindou-secrets.txt

echo "===== 1. 解压代码到 /opt/pindou ====="
mkdir -p /opt/pindou
tar -xzf /tmp/pindou.tar.gz -C /opt/pindou
cd /opt/pindou
echo "  已解压到 $(pwd)"

echo "===== 2. 创建数据库专用用户（若不存在）====="
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pindou_app') THEN CREATE ROLE pindou_app LOGIN PASSWORD '$DB_PASSWORD'; END IF; END \$\$;"

echo "===== 3. 创建数据库（若不存在）====="
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'pindou'" | grep -q 1; then
  sudo -u postgres psql -c "CREATE DATABASE pindou OWNER pindou_app"
  echo "  数据库 pindou 已创建"
else
  echo "  数据库 pindou 已存在，跳过"
fi

echo "===== 4. 安装依赖（npm ci）====="
npm ci --loglevel=error

echo "===== 5. 编译 TypeScript ====="
npm run build

echo "===== 6. 跑数据库迁移 ====="
PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=pindou PGUSER=pindou_app PGPASSWORD="$DB_PASSWORD" \
  npx tsx src/db/migrate.ts up

echo "===== 7. 初始化管理员 ====="
PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=pindou PGUSER=pindou_app PGPASSWORD="$DB_PASSWORD" \
  ADMIN_USERNAME=admin ADMIN_PASSWORD="$ADMIN_PASSWORD" ADMIN_DISPLAY_NAME=店长 \
  npx tsx src/db/init-admin.ts

echo "===== 8. 写环境变量文件 ====="
cat > /opt/pindou/.env <<EOF
NODE_ENV=production
PORT=3100
HOST=0.0.0.0
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=pindou
PGUSER=pindou_app
PGPASSWORD=$DB_PASSWORD
SESSION_SECRET=$SESSION_SECRET
COOKIE_SECURE=false
LOG_LEVEL=info
EOF
chmod 600 /opt/pindou/.env
echo "  .env 已写入（权限 600）"

echo "===== 9. 保存管理员初始密码（供店主 SSH 查看）====="
echo "$ADMIN_PASSWORD" > /opt/pindou/admin-initial-password.txt
chmod 600 /opt/pindou/admin-initial-password.txt

echo "===== 10. 清理临时文件 ====="
rm -f /tmp/pindou-secrets.txt /tmp/pindou.tar.gz

echo ""
echo "部署脚本执行完毕"
