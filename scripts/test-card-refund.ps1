# =============================================================================
# 测试退卡与冻结权益
# 注意：WebSession 必须作为脚本级变量传给每个请求，否则 cookie 丢失会 401
# =============================================================================
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:3101'
$script:session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

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
    $msg = $_.ErrorDetails.Message
    if (-not $msg) { $msg = $_.Exception.Message }
    return @{ ok = $false; error = $msg }
  }
}

# ---- 登录 ----
$login = Api POST '/api/v1/auth/login' @{ username = 'admin'; password = 'Pindou2026Dev' }
Write-Host "已登录: $($login.user.displayName)`n" -ForegroundColor Green

# ---- 1. 找一个持卡会员 ----
Write-Host "═══ 1. 查找持卡会员 ═══" -ForegroundColor Cyan
$members = (Api GET '/api/v1/members?limit=20').members
# 必须挑一个"状态正常 + 持有效卡 + 未冻结"的会员，否则会被业务校验拦住
$withCard = $members | Where-Object {
  $_.cardType -and $_.cardValid -and $_.status -eq 'active' -and -not $_.cardFrozen
} | Select-Object -First 1
if (-not $withCard) {
  Write-Host "  没有持卡会员，先给一个会员办卡" -ForegroundColor Yellow
  $first = $members | Select-Object -First 1
  $prods = (Api GET '/api/v1/products?category=card').products
  $wk = $prods | Where-Object { $_.cardType -eq 'week' } | Select-Object -First 1
  Api POST "/api/v1/members/$($first.id)/card" @{ cardType = 'week'; productId = $wk.id; paymentMethod = 'wechat' } | Out-Null
  $withCard = (Api GET "/api/v1/members/$($first.id)").member
}

$mid = $withCard.id
$m = (Api GET "/api/v1/members/$mid").member
Write-Host "  会员: $($m.displayName)  卡种=$($m.cardType)  冻结=$($m.cardFrozen)  有效=$($m.cardValid)"

# ---- 2. 冻结 ----
Write-Host "`n═══ 2. 冻结权益 ═══" -ForegroundColor Cyan
$r = Try-Api POST "/api/v1/members/$mid/card/freeze" @{ frozen = $true; reason = '顾客投诉，暂冻结' }
if ($r.ok) { Write-Host "  ✓ 已冻结（$($r.data.cardType)）" -ForegroundColor Green }
else { Write-Host "  ✗ $($r.error)" -ForegroundColor Red }

$m2 = (Api GET "/api/v1/members/$mid").member
Write-Host "  冻结标记=$($m2.cardFrozen)  原因=$($m2.cardFrozenReason)"

# ---- 3. 冻结时不能核销 ----
Write-Host "`n═══ 3. 冻结期间用卡开台应被拒绝 ═══" -ForegroundColor Cyan
$tbl = ((Api GET '/api/v1/tables').tables | Where-Object { $_.status -eq 'idle' } | Select-Object -First 1).id
$tp = ((Api GET '/api/v1/products').products | Where-Object { $_.code -eq 'T1H_S' }).id
$r = Try-Api POST '/api/v1/sessions' @{ tableId = $tbl; memberId = $mid; productId = $tp; useCard = $true }
if ($r.ok) { Write-Host "  ✗ 不该成功！" -ForegroundColor Red; Api POST "/api/v1/sessions/$($r.data.sessionId)/settle" @{ paymentMethod = 'free' } | Out-Null }
else { Write-Host "  ✓ 被正确拒绝: $($r.error)" -ForegroundColor Green }

# ---- 4. 重复冻结应拒绝 ----
Write-Host "`n═══ 4. 重复冻结应被拒绝 ═══" -ForegroundColor Cyan
$r = Try-Api POST "/api/v1/members/$mid/card/freeze" @{ frozen = $true; reason = '再来一次' }
if ($r.ok) { Write-Host "  ✗ 不该成功" -ForegroundColor Red } else { Write-Host "  ✓ $($r.error)" -ForegroundColor Green }

# ---- 5. 解冻 ----
Write-Host "`n═══ 5. 解冻 ═══" -ForegroundColor Cyan
$r = Try-Api POST "/api/v1/members/$mid/card/freeze" @{ frozen = $false }
if ($r.ok) { Write-Host "  ✓ 已解冻" -ForegroundColor Green } else { Write-Host "  ✗ $($r.error)" -ForegroundColor Red }
Write-Host "  冻结标记=$((Api GET "/api/v1/members/$mid").member.cardFrozen)"

# ---- 6. 退卡：金额超过办卡总额应拒绝 ----
Write-Host "`n═══ 6. 退款金额超过办卡总额应被拒绝 ═══" -ForegroundColor Cyan
$r = Try-Api POST "/api/v1/members/$mid/card/refund" @{ refundCents = 99999900; refundMethod = 'cash'; reason = '乱填的' }
if ($r.ok) { Write-Host "  ✗ 不该成功" -ForegroundColor Red } else { Write-Host "  ✓ $($r.error)" -ForegroundColor Green }

# ---- 7. 退卡：缺原因应拒绝 ----
Write-Host "`n═══ 7. 缺原因应被拒绝 ═══" -ForegroundColor Cyan
$r = Try-Api POST "/api/v1/members/$mid/card/refund" @{ refundCents = 1000; refundMethod = 'cash'; reason = '' }
if ($r.ok) { Write-Host "  ✗ 不该成功" -ForegroundColor Red } else { Write-Host "  ✓ 被拒绝（参数校验）" -ForegroundColor Green }

# ---- 8. 正常退卡 ----
Write-Host "`n═══ 8. 退卡（退 200 元）═══" -ForegroundColor Cyan
$before = (Api GET '/api/v1/revenue/reconcile')
$r = Try-Api POST "/api/v1/members/$mid/card/refund" @{ refundCents = 20000; refundMethod = 'wechat'; reason = '顾客要求退款' }
if ($r.ok) {
  Write-Host "  ✓ 已退卡" -ForegroundColor Green
  Write-Host "    退还 ¥$($r.data.refundCents / 100)  流水号 $($r.data.flowNo)  原卡种 $($r.data.cardType)"
} else { Write-Host "  ✗ $($r.error)" -ForegroundColor Red }

$m3 = (Api GET "/api/v1/members/$mid").member
Write-Host "  退卡后: 卡种='$($m3.cardType)'  有效=$($m3.cardValid)"

# ---- 9. 权益流水 ----
Write-Host "`n═══ 9. 卡权益流水 ═══" -ForegroundColor Cyan
$recs = (Api GET "/api/v1/members/$mid/card-records").records
foreach ($rec in $recs) {
  $amt = if ($rec.amountCents -gt 0) { "¥$($rec.amountCents / 100)" } else { '-' }
  Write-Host "  $($rec.action.PadRight(9)) $($rec.cardType)  $amt  $($rec.reason)"
}

# ---- 10. 对账 ----
Write-Host "`n═══ 10. 对账 ═══" -ForegroundColor Cyan
$rec = Api GET '/api/v1/revenue/reconcile'
Write-Host "  流水汇总 ¥$($rec.ledgerTotalCents / 100)"
Write-Host "  订单净额 ¥$($rec.orderNetCents / 100)"
Write-Host "  差异 $($rec.diffCents) 分"
Write-Host "  退卡前流水 ¥$($before.ledgerTotalCents / 100) → 退卡后 ¥$($rec.ledgerTotalCents / 100)（应减少 200）"

Write-Host "`n完成" -ForegroundColor Green
