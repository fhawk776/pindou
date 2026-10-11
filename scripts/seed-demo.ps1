# =============================================================================
# 构造演示场景
#
# 用于给甲方演示，以及生成单文件演示页。会创建：
#   · 3 个会员（其中 1 个持周卡）
#   · 3 张使用中的桌位，分别演示三种看板状态
#   · 若干已完成的历史订单与流水，让收入页有内容
#
# 用法：
#   $env:ALLOW_SEED = 'yes'; .\scripts\seed-demo.ps1
# =============================================================================
$ErrorActionPreference = 'Stop'

if ($env:ALLOW_SEED -ne 'yes') {
  Write-Host ''
  Write-Host '本脚本会写入演示数据，默认拒绝运行。' -ForegroundColor Yellow
  Write-Host '确认目标是演示/开发库后，请显式授权：' -ForegroundColor Cyan
  Write-Host '  $env:ALLOW_SEED = ''yes''; .\scripts\seed-demo.ps1' -ForegroundColor Cyan
  Write-Host ''
  exit 1
}

$base = $env:API_BASE
if (-not $base) { $base = 'http://127.0.0.1:3101' }
$psql = 'D:\PostgreSQL\bin\psql.exe'
$db = if ($env:PGDATABASE) { $env:PGDATABASE } else { 'pindou' }

$script:session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

function Api($method, $path, $body) {
  $params = @{
    Uri = "$base$path"; Method = $method
    WebSession = $script:session
    ContentType = 'application/json; charset=utf-8'; TimeoutSec = 15
  }
  if ($body) { $params.Body = [System.Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Compress -Depth 8)) }
  Invoke-RestMethod @params
}

function Show($l, $v) { Write-Host ("  {0,-20} {1}" -f $l, $v) }

Write-Host "`n=== 登录 ===" -ForegroundColor Cyan
$me = Api POST '/api/v1/auth/login' @{ username = 'admin'; password = 'Pindou2026Dev' }
Show '登录用户' $me.user.displayName

$prods = (Api GET '/api/v1/products').products
$byCode = @{}
foreach ($p in $prods) { $byCode[$p.code] = $p }

Write-Host "`n=== 创建会员 ===" -ForegroundColor Cyan
$m1 = Api POST '/api/v1/members' @{ nickname = '小雨'; phoneTail = '5481' }
Show '会员1' "$($m1.nickname) · $($m1.phoneTail)（$($m1.memberNo)）"

$m2 = Api POST '/api/v1/members' @{ nickname = '阿梨'; phoneTail = '8892' }
Show '会员2' "$($m2.nickname) · $($m2.phoneTail)（$($m2.memberNo)）"

$m3 = Api POST '/api/v1/members' @{ nickname = '杨先生'; phoneTail = '1234'; remark = '周末常来' }
Show '会员3' "$($m3.nickname) · $($m3.phoneTail)（$($m3.memberNo)）"

Write-Host "`n=== 给阿梨办周卡 ===" -ForegroundColor Cyan
$card = Api POST "/api/v1/members/$($m2.id)/card" @{
  cardType = 'week'; productId = $byCode['WEEK_N'].id; paymentMethod = 'wechat'
}
Show '办卡' "有效期至 $($card.expiresAt)"

Write-Host "`n=== 构造历史订单（让收入页有内容）===" -ForegroundColor Cyan
$tables = (Api GET '/api/v1/tables').tables

# 单1：散客买 78 钉，现金
$o1 = Api POST '/api/v1/sessions' @{ tableId = $tables[4].id; guestName = '小李'; productId = $byCode['P78'].id }
$s1 = Api POST "/api/v1/sessions/$($o1.sessionId)/settle" @{ paymentMethod = 'cash' }
Show '订单1' "$($s1.orderNo) ¥$($s1.paidCents / 100)（散客 78钉）"

# 单2：小雨买双人3小时 + 加购，微信
$o2 = Api POST '/api/v1/sessions' @{ tableId = $tables[5].id; memberId = $m1.id; productId = $byCode['T3H_D'].id }
$s2 = Api POST "/api/v1/sessions/$($o2.sessionId)/settle" @{
  addonIds = @($byCode['ADD_BOARD'].id); paymentMethod = 'wechat'
}
Show '订单2' "$($s2.orderNo) ¥$($s2.paidCents / 100)（双人3小时+拼豆板）"

# 单3：杨先生买单人3小时，支付宝
$o3 = Api POST '/api/v1/sessions' @{ tableId = $tables[6].id; memberId = $m3.id; productId = $byCode['T3H_S'].id }
$s3 = Api POST "/api/v1/sessions/$($o3.sessionId)/settle" @{ paymentMethod = 'alipay' }
Show '订单3' "$($s3.orderNo) ¥$($s3.paidCents / 100)（单人3小时）"

Write-Host "`n=== 构造三种看板状态 ===" -ForegroundColor Cyan

# 状态1：用卡核销 → 全天不限时
$c1 = Api POST '/api/v1/sessions' @{ tableId = $tables[0].id; memberId = $m2.id; useCard = $true }
Show '01号桌' "阿梨用周卡开台（全天不限时）"

# 状态2：限时套餐已超时
$c2 = Api POST '/api/v1/sessions' @{ tableId = $tables[1].id; memberId = $m1.id; productId = $byCode['T1H_S'].id }
# 状态3：限板套餐（不限时，用于展示与限时套餐的区别）
$c3 = Api POST '/api/v1/sessions' @{ tableId = $tables[3].id; guestName = '穿蓝衣服的姐姐'; productId = $byCode['P78'].id }
# 状态4：另一个限时套餐即将到时（用 3 小时套餐，避免与状态2 重复）
$c4 = Api POST '/api/v1/sessions' @{ tableId = $tables[6].id; memberId = $m3.id; productId = $byCode['T3H_S'].id }

Write-Host "`n=== 调整时间制造演示效果 ===" -ForegroundColor Cyan
$sql = @"
UPDATE table_sessions
   SET started_at = now() - interval '100 minutes',
       expected_end_at = now() - interval '40 minutes'
 WHERE id = $($c2.sessionId);

UPDATE table_sessions
   SET started_at = now() - interval '172 minutes',
       expected_end_at = now() + interval '8 minutes'
 WHERE id = $($c4.sessionId);
"@
[System.IO.File]::WriteAllText('D:\temp\seed-times.sql', $sql, (New-Object System.Text.UTF8Encoding($false)))
& $psql -w -h 127.0.0.1 -p 5432 -U postgres -d $db -f 'D:\temp\seed-times.sql' 2>&1 | Out-Null

Show '02号桌' '单人1小时（已超时 40 分钟）'
Show '04号桌' '78钉（不限时，无倒计时）'
Show '07号桌' '单人3小时（剩余约 8 分钟）'

Write-Host "`n=== 最终看板 ===" -ForegroundColor Cyan
$board = Api GET '/api/v1/board'
foreach ($t in $board.tables) {
  if ($t.session) {
    $x = $t.session
    $label = if ($x.usedCard) { '【周卡·全天不限时】' } else { $x.productName }
    Write-Host ("  {0,-8} {1,-16} {2,-20} 剩余={3} 警示={4}" -f `
      $t.tableName, $x.displayName, $label, $x.remainingMinutes, $x.alertLevel)
  }
}
Show '使用中 / 空闲' "$($board.summary.occupied) / $($board.summary.idle)"

Write-Host "`n=== 对账检查 ===" -ForegroundColor Cyan
$rec = Api GET '/api/v1/revenue/reconcile'
Show '消费 流水/订单' "¥$($rec.consumeLedgerCents / 100) / ¥$($rec.consumeOrdersCents / 100)"
Show '办卡 流水/记录' "¥$($rec.cardLedgerCents / 100) / ¥$($rec.cardRecordsCents / 100)"
Show '是否平账' $(if ($rec.balanced) { 'OK 平' } else { "X 消费差 $($rec.consumeDiffCents) 卡差 $($rec.cardDiffCents)" })

Write-Host "`n演示场景构造完成" -ForegroundColor Green
