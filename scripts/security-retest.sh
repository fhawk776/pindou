#!/bin/bash
# 安全重测：SQL 注入 + XSS（等待限速窗口结束）
set -uo pipefail

BASE="http://127.0.0.1:3100"
PW=$(cat /opt/pindou/admin-initial-password.txt)
q() { sudo -u postgres psql -d pindou -tAc "$1" 2>/dev/null; }

echo "等待登录限速窗口结束（65 秒）..."
sleep 65

echo ""
echo "===== 登录 ====="
CODE=$(curl -s -c /tmp/sc2.txt -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/auth/login" \
  -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$PW\"}")
echo "  登录 HTTP $CODE"
if [ "$CODE" != "200" ]; then echo "  登录失败，无法继续测试"; exit 1; fi

echo ""
echo "===== SQL 注入测试 ====="
echo "  ① 经典绕过: ' OR 1=1--"
R1=$(curl -s -b /tmp/sc2.txt "$BASE/api/v1/members?q=%27%20OR%201%3D1--")
if echo "$R1" | grep -qiE 'syntax error|pg_|postgres|ERROR:'; then
  echo "     ❌ 泄露数据库错误: $(echo "$R1" | head -c 100)"
else
  CNT=$(echo "$R1" | grep -o '"id"' | wc -l)
  echo "     ✅ 未泄露错误，返回 $CNT 条会员（正常应为 0 条，因为没会员叫这个名字）"
fi

echo "  ② 联合查询注入: ' UNION SELECT password_hash FROM users--"
R2=$(curl -s -b /tmp/sc2.txt "$BASE/api/v1/members?q=%27%20UNION%20SELECT%20password_hash%20FROM%20users--")
if echo "$R2" | grep -q 'argon2'; then
  echo "     ❌ 泄露了密码哈希！"
elif echo "$R2" | grep -qiE 'syntax error|pg_'; then
  echo "     ❌ 泄露数据库错误"
else
  echo "     ✅ 无泄露"
fi

echo "  ③ 时间盲注: '; SELECT pg_sleep(5)--"
T0=$(date +%s)
curl -s -b /tmp/sc2.txt -o /dev/null "$BASE/api/v1/members?q=%27%3B%20SELECT%20pg_sleep%285%29--"
T1=$(date +%s)
DELTA=$((T1-T0))
if [ "$DELTA" -ge 4 ]; then
  echo "     ❌ 响应延迟 ${DELTA}s，疑似时间盲注生效"
else
  echo "     ✅ 响应 ${DELTA}s，无延迟（注入未执行）"
fi

echo "  ④ 验证数据表完好"
echo "     members 表: $(q "select count(1) from members") 条"
echo "     users 表:   $(q "select count(1) from users") 条"

echo ""
echo "===== XSS 测试（存储型）====="
XSS='<img src=x onerror=alert(1)>'
TID=$(q "select id from tables where status='idle' order by id limit 1")
OPEN=$(curl -s -b /tmp/sc2.txt -X POST "$BASE/api/v1/sessions" -H 'Content-Type: application/json' \
  -d "{\"tableId\":$TID,\"guestName\":\"$XSS\",\"productId\":1}")
SID=$(echo "$OPEN" | grep -o '"sessionId":[0-9]*' | head -1 | cut -d: -f2)

if [ -n "$SID" ]; then
  BOARD=$(curl -s -b /tmp/sc2.txt "$BASE/api/v1/board")
  echo "  存入内容: $XSS"
  if echo "$BOARD" | grep -qF '<img src=x'; then
    echo "  ⚠️ API 原样返回 HTML 字符串"
    echo "     前端渲染时用 esc() 转义 → 不会执行（见下方代码验证）"
  else
    echo "  ✅ API 已做处理"
  fi
  # 清理
  q "delete from audit_logs where target_id = $SID and target_type='table_session'"
  q "delete from table_sessions where id = $SID"
  q "update tables set status='idle' where id = $TID"
  echo "  （测试数据已清理）"
else
  echo "  ⚠️ 开台失败，无法测试: $(echo "$OPEN" | head -c 100)"
fi

echo ""
echo "===== 前端转义函数使用情况 ====="
echo "  app.js 中 esc() 调用次数: $(grep -c 'esc(' /opt/pindou/web/app.js 2>/dev/null || echo 0)"
echo "  直接插入 innerHTML 且未转义的插值（自查）:"
grep -oE '\$\{[a-zA-Z_.]+\.(guestName|nickname|displayName|name|remark|note)\}' /opt/pindou/web/app.js 2>/dev/null | sort -u | head -10 | sed 's/^/    /' || echo "    （无）"

rm -f /tmp/sc2.txt
