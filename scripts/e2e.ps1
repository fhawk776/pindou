# =============================================================================
# 端到端业务流程验证
#
# 【重要】本脚本会写入并清理数据，只允许对测试库运行。
# 必须显式设置 ALLOW_E2E=yes 才会执行，避免误连开发库或正式库。
#
# 用法：
#   $env:ALLOW_E2E = 'yes'
#   $env:API_BASE  = 'http://127.0.0.1:3102'   # 指向连测试库的服务实例
#   .\scripts\e2e.ps1
# =============================================================================
$ErrorActionPreference = 'Stop'

if ($env:ALLOW_E2E -ne 'yes') {
  Write-Host ''
  Write-Host '本脚本会创建与清理数据，默认拒绝运行。' -ForegroundColor Yellow
  Write-Host '确认目标是测试库后，请显式授权：' -ForegroundColor Yellow
  Write-Host '  $env:ALLOW_E2E = ''yes''; .\scripts\e2e.ps1' -ForegroundColor Cyan
  Write-Host ''
  exit 1
}

$base = if ($env:API_BASE) { $env:API_BASE } else { 'http://127.0.0.1:3102' }
$psql = 'D:\PostgreSQL\bin\psql.exe'
$pgArgs = @('-w', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'pindou_test')
$script:session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

try { $null = Invoke-RestMethod -Uri "$base/healthz" -TimeoutSec 8 }
catch {
  Write-Host "无法连接 $base ：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

function Api($method, $path, $body) {
  $params = @{
    Uri = "$base$path"
    Method = $method
    WebSession = $script:session
    ContentType = 'application/json; charset=utf-8'
    TimeoutSec = 15
  }
  if ($body) { $params.Body = [System.Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Compress -Depth 8)) }
  Invoke-RestMethod @params
}

function Try-Api($method, $path, $body) {
  try { return @{ ok = $true; data = (Api $method $path $body) } }
  catch {
    $msg = $_.ErrorDetails.Message; if (-not $msg) { $msg = $_.Exception.Message }
    return @{ ok = $false; error = $msg }
  }
}

function Show($label, $value) { Write-Host ("  {0,-22} {1}" -f $label, $value) }

# -----------------------------------------------------------------------------
Write-Host "`n=== 1. 登录 ===" -ForegroundColor Cyan
$me = Api POST '/api/v1/auth/login' @{ username = 'admin'; password = 'Pindou2026Dev' }
Show '登录用户' $me.user.displayName

Write-Host "`n=== 2. 挑两张空闲桌 ===" -ForegroundColor Cyan
$idle = (Api GET '/api/v1/tables').tables | Where-Object { $_.status -eq 'idle' }
if ($idle.Count -lt 2) {
  Write-Host "  空闲桌不足（$($idle.Count) 张），先清理测试库中的占用记录" -ForegroundColor Yellow
  exit 1
}
$tableA = $idle[0].id
$tableB = $idle[1].id
Show '使用桌位' "$($idle[0].name) / $($idle[1].name)"

$prods = (Api GET '/api/v1/products').products
$byCode = @{}
foreach ($p in $prods) { $byCode[$p.code] = $p }

Write-Host "`n=== 3. 新建测试会员 ===" -ForegroundColor Cyan
$tag = Get-Date -Format 'HHmmss'
$m1 = Api POST '/api/v1/members' @{ nickname = "E2E$tag"; phoneTail = '9001' }
$m2 = Api POST '/api/v1/members' @{ nickname = "E2E伴$($tag.Substring(2))"; phoneTail = '9002' }
Show '会员1' "$($m1.nickname) · $($m1.memberNo)"
Show '会员2' "$($m2.nickname) · $($m2.memberNo)"

# 产品分类过滤。
# 这个检查是补上的：路由层曾把 category = $1 误写成 category = 1（少一个 $），
# 导致所有带 ?category= 的请求报 42883，前端表现为"点办卡没反应"。
# 集成测试只覆盖 service 层，抓不到路由层 SQL 拼接错误，因此在这里补一道。
Write-Host "`n=== 3.5 产品分类过滤 ===" -ForegroundColor Cyan
foreach ($cat in 'timed', 'board', 'day', 'card', 'addon') {
  $r = Try-Api GET "/api/v1/products?category=$cat"
  if ($r.ok) {
    Show $cat "$($r.data.products.Count) 个"
  } else {
    Write-Host "  FAIL category=$cat: $($r.error)" -ForegroundColor Red
    exit 1
  }
}

Write-Host "`n=== 4. 开台（限时套餐）===" -ForegroundColor Cyan
$open1 = Api POST '/api/v1/sessions' @{
  tableId = $tableA; memberId = $m1.id; productId = $byCode['T1H_S'].id
}
Show '开台' "$($open1.tableName) · $($open1.productName)"
Show '预计结束' ([datetime]$open1.expectedEndAt).ToString('HH:mm')

Write-Host "`n=== 5. 冲突校验 ===" -ForegroundColor Cyan
$r = Try-Api POST '/api/v1/sessions' @{ tableId = $tableA; memberId = $m2.id; productId = $byCode['T1H_S'].id }
Show '同桌重复开台' $(if ($r.ok) { 'X 不该成功' } else { 'OK 已拒绝' })
$r = Try-Api POST '/api/v1/sessions' @{ tableId = $tableB; memberId = $m1.id; productId = $byCode['T1H_S'].id }
Show '同人重复开台' $(if ($r.ok) { 'X 不该成功' } else { 'OK 已拒绝' })

Write-Host "`n=== 6. 加购预览与结账 ===" -ForegroundColor Cyan
$addonId = $byCode['ADD_BOARD'].id
$pv = (Api GET "/api/v1/sessions/$($open1.sessionId)/preview?addons=$addonId").preview
Show '套餐原价' "¥$($pv.productOriginalCents / 100)"
Show '加购原价' "¥$($pv.addonOriginalCents / 100)"
Show '折扣合计' "¥$($pv.discountCents / 100)"
Show '应收' "¥$($pv.totalCents / 100)"

$st = Api POST "/api/v1/sessions/$($open1.sessionId)/settle" @{
  addonItems = @(@{ id = $addonId; qty = 1 }); paymentMethod = 'wechat'
}
Show '订单号' $st.orderNo
Show '实收' "¥$($st.paidCents / 100)"
Show '流水号' $st.flowNo

# 断言：实收必须等于预览的应收，否则说明加购/折扣算错了
if ($st.paidCents -ne $pv.totalCents) {
  Write-Host "  ❌ 实收 ¥$($st.paidCents/100) 与应收 ¥$($pv.totalCents/100) 不一致！" -ForegroundColor Red
  exit 1
}
Write-Host "  ✅ 实收与应收一致" -ForegroundColor Green

Write-Host "`n=== 7. 桌位已释放 ===" -ForegroundColor Cyan
$board = Api GET '/api/v1/board'
Show '原桌状态' ($board.tables | Where-Object { $_.tableId -eq $tableA }).status

Write-Host "`n=== 8. 办周卡并用卡开台 ===" -ForegroundColor Cyan
$card = Api POST "/api/v1/members/$($m1.id)/card" @{
  cardType = 'week'; productId = $byCode['WEEK_N'].id; paymentMethod = 'wechat'
}
Show '办卡' "有效期至 $($card.expiresAt)"

$cardOpen = Api POST '/api/v1/sessions' @{ tableId = $tableB; memberId = $m1.id; useCard = $true }
Show '用卡开台' "$($cardOpen.tableName)（不选套餐）"
Show '权益至' $cardOpen.cardExpiresAt
Show '预计结束' $(if ($cardOpen.expectedEndAt) { $cardOpen.expectedEndAt } else { '无（全天不限时）' })

$sql = "UPDATE table_sessions SET started_at = now() - interval '5 hours' WHERE id = $($cardOpen.sessionId);"
& $psql @pgArgs -c $sql 2>&1 | Out-Null

$pv2 = (Api GET "/api/v1/sessions/$($cardOpen.sessionId)/preview").preview
Show '已玩' "$($pv2.actualMinutes) 分钟"
Show '超时档数' $pv2.overtimeUnits
$cardSettle = Api POST "/api/v1/sessions/$($cardOpen.sessionId)/settle" @{ paymentMethod = 'card' }
Show '用卡实收' "¥$($cardSettle.paidCents / 100)"

Write-Host "`n=== 9. 退卡 ===" -ForegroundColor Cyan
$r = Try-Api POST "/api/v1/members/$($m1.id)/card/refund" @{
  refundCents = 10000; refundMethod = 'cash'; reason = 'E2E 测试退卡'
}
Show '退卡' $(if ($r.ok) { "OK 退款 ¥$($r.data.refundCents / 100)" } else { "X $($r.error)" })

Write-Host "`n=== 10. 对账 ===" -ForegroundColor Cyan
$rec = Api GET '/api/v1/revenue/reconcile'
Show '消费 流水/订单' "¥$($rec.consumeLedgerCents / 100) / ¥$($rec.consumeOrdersCents / 100)"
Show '办卡 流水/记录' "¥$($rec.cardLedgerCents / 100) / ¥$($rec.cardRecordsCents / 100)"
Show '是否平账' $(if ($rec.balanced) { 'OK 平' } else { "X 消费差$($rec.consumeDiffCents) 卡差$($rec.cardDiffCents)" })

Write-Host "`n完成" -ForegroundColor Green
