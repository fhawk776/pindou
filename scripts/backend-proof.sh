#!/bin/bash
# 后端能力实测：通过 API 操作 → 直接查数据库验证 → 清理
set -uo pipefail

BASE="http://127.0.0.1:3100"
PW=$(cat /opt/pindou/admin-initial-password.txt)
q() { sudo -u postgres psql -d pindou -tAc "$1" 2>/dev/null; }

echo "===== 1. 登录（后端签发会话 Cookie）====="
CODE=$(curl -s -c /tmp/dc.txt -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/auth/login" \
  -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$PW\"}")
echo "  HTTP $CODE"

echo ""
echo "===== 2. 通过 API 开一桌 ====="
TID=$(q "select id from tables where status = 'idle' order by id limit 1")
echo "  用桌位 ID=$TID"
OPEN=$(curl -s -b /tmp/dc.txt -X POST "$BASE/api/v1/sessions" \
  -H 'Content-Type: application/json' \
  -d "{\"tableId\":$TID,\"guestName\":\"后端实测\",\"productId\":1}")
SID=$(echo "$OPEN" | grep -o '"sessionId":[0-9]*' | head -1 | cut -d: -f2)
echo "  API 返回会话 ID=$SID"

echo ""
echo "===== 3. 【关键】直连数据库，看这条记录是否真的写进去了 ====="
echo "  数据库里的这条开台记录："
sudo -u postgres psql -d pindou -c "select id, guest_name, product_name, product_price_cents, status, started_at from table_sessions where id = $SID" 2>/dev/null
echo "  桌位状态变化："
sudo -u postgres psql -d pindou -c "select id, name, status from tables where id = $TID" 2>/dev/null

echo ""
echo "===== 4. 通过 API 结账（收钱）====="
SETTLE=$(curl -s -b /tmp/dc.txt -X POST "$BASE/api/v1/sessions/$SID/settle" \
  -H 'Content-Type: application/json' -d '{"paymentMethod":"cash"}')
echo "  API 返回: $(echo "$SETTLE" | head -c 180)"

echo ""
echo "===== 5. 【关键】数据库里的订单与流水 ====="
sudo -u postgres psql -d pindou -c "select order_no, table_name, total_cents, paid_cents, payment_method from orders where table_session_id = $SID" 2>/dev/null
sudo -u postgres psql -d pindou -c "select flow_no, flow_type, amount_cents, payment_method from revenue_ledger where order_id = (select id from orders where table_session_id = $SID)" 2>/dev/null

echo ""
echo "===== 6. 清理本次实测数据 ====="
q "delete from revenue_ledger where order_id in (select id from orders where table_session_id = $SID)"
q "delete from order_items where order_id in (select id from orders where table_session_id = $SID)"
q "delete from orders where table_session_id = $SID"
q "delete from table_sessions where id = $SID"
q "delete from audit_logs where target_id = $SID and target_type = 'table_session'"
q "update tables set status = 'idle' where id = $TID"
echo "  已清理（桌位恢复空闲）"
q "select count(1) from orders" | xargs -I{} echo "  当前订单总数: {}"
rm -f /tmp/dc.txt
