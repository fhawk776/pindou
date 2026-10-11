#!/bin/bash
# 验证部署 + 检查阿里云 CLI 可用性
set -euo pipefail

echo "===== 1. 登录测试（密码从文件读，不回显）====="
PW=$(cat /opt/pindou/admin-initial-password.txt)
RESP=$(curl -s -X POST http://127.0.0.1:3100/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$PW\"}")
if echo "$RESP" | grep -q '"user"'; then
  echo "  ✅ 登录成功（返回了 user 对象）"
else
  echo "  ❌ 登录失败: $(echo "$RESP" | head -c 200)"
fi

echo ""
echo "===== 2. 看板接口 ====="
curl -s http://127.0.0.1:3100/api/v1/board -H "Cookie: pindou_sid=test" | head -c 100
echo ""

echo ""
echo "===== 3. 阿里云 CLI 可用性 ====="
if command -v aliyun >/dev/null 2>&1; then
  echo "  aliyun CLI 已安装: $(aliyun version 2>/dev/null || echo '版本未知')"
  echo "  已配置凭证: $(aliyun configure list 2>/dev/null | grep -c 'access_key' || echo 0) 个"
else
  echo "  ❌ aliyun CLI 未安装"
fi

echo ""
echo "===== 4. 现有 ECS 元数据（判断能否获取安全组）====="
curl -s -m 3 http://100.100.100.200/latest/meta-data/instance-id 2>/dev/null && echo "（实例ID）" || echo "  无法获取实例元数据"
curl -s -m 3 http://100.100.100.200/latest/meta-data/region-id 2>/dev/null && echo "（地域）" || true
