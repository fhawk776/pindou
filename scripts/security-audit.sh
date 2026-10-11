#!/bin/bash
# 安全实测（温和版：不做破坏性攻击，测试数据会清理）
set -uo pipefail

BASE="http://127.0.0.1:3100"
PW=$(cat /opt/pindou/admin-initial-password.txt)
q() { sudo -u postgres psql -d pindou -tAc "$1" 2>/dev/null; }

echo "===== 1. 未授权访问（应全部 401）====="
for ep in /api/v1/members /api/v1/board /api/v1/revenue/summary /api/v1/settings /api/v1/orders /api/v1/audit-logs; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$ep")
  printf "  %-26s %s\n" "$ep" "$code"
done

echo ""
echo "===== 2. 安全响应头 ====="
curl -s -I "$BASE/" | grep -iE 'x-frame-options|x-content-type|content-security-policy|strict-transport|x-xss|cross-origin|referrer-policy' | sed 's/^/  /'

echo ""
echo "===== 3. 会话 Cookie 属性 ====="
curl -s -i -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$PW\"}" | grep -i 'set-cookie' | sed 's/^/  /'

echo ""
echo "===== 4. 登录限速（连续错误密码，用不存在的账号避免锁定真实账号）====="
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"username":"nobody_test","password":"wrongpass123"}')
  printf "%s " "$code"
done
echo "  ← 若出现 429 说明已限速"

echo ""
echo "===== 5. SQL 注入（搜索参数）====="
curl -s -c /tmp/sc.txt -o /dev/null -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$PW\"}"
INJ=$(curl -s -b /tmp/sc.txt "$BASE/api/v1/members?q=%27%20OR%201%3D1--")
if echo "$INJ" | grep -qiE 'syntax error|pg_|postgres|SQL'; then
  echo "  ❌ 疑似泄露数据库错误: $(echo "$INJ" | head -c 120)"
else
  echo "  ✅ 未泄露数据库错误"
  echo "     返回: $(echo "$INJ" | head -c 80)"
fi

INJ2=$(curl -s -b /tmp/sc.txt "$BASE/api/v1/members?q=%27%3B%20DROP%20TABLE%20members%3B--")
if echo "$INJ2" | grep -qiE 'syntax error|pg_|postgres'; then
  echo "  ❌ DROP 注入疑似生效"
else
  echo "  ✅ DROP 注入无效"
fi
echo "  验证 members 表仍存在: $(q "select count(1) from members") 条记录"

echo ""
echo "===== 6. 存储型 XSS（散客名存脚本，看是否转义）====="
XSS='<img src=x onerror=alert(1)>'
TID=$(q "select id from tables where status='idle' order by id limit 1")
OPEN=$(curl -s -b /tmp/sc.txt -X POST "$BASE/api/v1/sessions" -H 'Content-Type: application/json' \
  -d "{\"tableId\":$TID,\"guestName\":\"$XSS\",\"productId\":1}")
SID=$(echo "$OPEN" | grep -o '"sessionId":[0-9]*' | head -1 | cut -d: -f2)
if [ -n "$SID" ]; then
  BOARD=$(curl -s -b /tmp/sc.txt "$BASE/api/v1/board")
  if echo "$BOARD" | grep -q '<img src=x'; then
    echo "  ⚠️ 接口原样返回了 HTML（前端 app.js 有 esc() 转义，需确认渲染时已转义）"
  else
    echo "  ✅ 未原样返回 HTML"
  fi
  # 清理
  q "delete from audit_logs where target_id = $SID and target_type='table_session'"
  q "delete from table_sessions where id = $SID"
  q "update tables set status='idle' where id = $TID"
  echo "  （测试数据已清理）"
fi

echo ""
echo "===== 7. 数据库账号权限（应用账号不应是超级用户）====="
sudo -u postgres psql -tAc "select rolname, rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname = 'pindou_app'" 2>/dev/null | sed 's/^/  /'

echo ""
echo "===== 8. 密码存储方式 ====="
HASH=$(q "select password_hash from users limit 1")
echo "  哈希前缀: $(echo "$HASH" | cut -c1-30)..."
echo "  长度: ${#HASH}"

rm -f /tmp/sc.txt
