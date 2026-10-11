#!/bin/bash
# 上线验收：页面 + 静态资源 + 登录 + 业务接口 + 数据完整性
set -uo pipefail

BASE="http://127.0.0.1:3100"
PASS=0
FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (期望 $3 实际 $2)"; fi; }

echo "===== 1. 页面与静态资源 ====="
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")
check "首页 HTML 可访问" "$CODE" "200"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/app.js")
check "app.js 可加载" "$CODE" "200"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/app.css")
check "app.css 可加载" "$CODE" "200"

echo ""
echo "===== 2. 登录 ====="
PW=$(cat /opt/pindou/admin-initial-password.txt)
LOGIN=$(curl -s -c /tmp/pd-cookie.txt -X POST "$BASE/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$PW\"}")
if echo "$LOGIN" | grep -q '"user"'; then ok "管理员登录成功"; else bad "登录失败: $(echo "$LOGIN" | head -c 150)"; fi

echo ""
echo "===== 3. 业务接口（带登录态） ====="
BOARD=$(curl -s -b /tmp/pd-cookie.txt "$BASE/api/v1/board")
if echo "$BOARD" | grep -q '"tables"'; then ok "看板接口正常"; else bad "看板异常"; fi

MEMBERS=$(curl -s -b /tmp/pd-cookie.txt "$BASE/api/v1/members?limit=5")
if echo "$MEMBERS" | grep -q '"members"'; then ok "会员接口正常"; else bad "会员接口异常"; fi

PRODUCTS=$(curl -s -b /tmp/pd-cookie.txt "$BASE/api/v1/products")
if echo "$PRODUCTS" | grep -q '"products"'; then ok "价目表接口正常"; else bad "价目表异常"; fi

REC=$(curl -s -b /tmp/pd-cookie.txt "$BASE/api/v1/revenue/reconcile")
if echo "$REC" | grep -q '"balanced"'; then ok "对账接口正常"; else bad "对账异常"; fi

echo ""
echo "===== 4. 数据完整性 ====="
TBL=$(sudo -u postgres psql -d pindou -tAc "select count(1) from tables")
PROD=$(sudo -u postgres psql -d pindou -tAc "select count(1) from products where is_active")
MIG=$(sudo -u postgres psql -d pindou -tAc "select count(1) from schema_migrations")
echo "  桌位 $TBL 张 / 在售套餐 $PROD 个 / 迁移 $MIG 个"
check "桌位 8 张" "$TBL" "8"
check "在售套餐 13 个" "$PROD" "13"
check "迁移 13 个" "$MIG" "13"

echo ""
echo "===== 5. 服务与资源占用 ====="
pm2 jlist 2>/dev/null | grep -o '"name":"pindou-api"[^}]*"status":"[a-z]*"' | head -1 || true
MEM=$(pm2 jlist 2>/dev/null | grep -o '"name":"pindou-api".*' | grep -o '"memory":[0-9]*' | head -1)
echo "  pindou-api $MEM"
free -m | head -2 | tail -1 | awk '{print "  可用内存: " $7 " MB"}'

echo ""
echo "======================================"
echo "通过 $PASS 项，失败 $FAIL 项"
rm -f /tmp/pd-cookie.txt
