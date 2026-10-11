# =============================================================================
# 本地开发用 PostgreSQL 管理脚本（免安装 zip 版）
#
# 用法：
#   .\scripts\pg.ps1 init     初始化数据库集群
#   .\scripts\pg.ps1 start    启动
#   .\scripts\pg.ps1 stop     停止
#   .\scripts\pg.ps1 status   查看状态
#   .\scripts\pg.ps1 psql     打开 psql 交互终端
#   .\scripts\pg.ps1 createdb 创建 pindou 和 pindou_test 库
# =============================================================================
param(
  [Parameter(Position = 0)]
  [ValidateSet('init', 'start', 'stop', 'restart', 'status', 'psql', 'createdb', 'logs')]
  [string]$Action = 'status',

  [string]$Database = 'pindou'
)

$ErrorActionPreference = 'Stop'

# ---- 路径配置 ----
$PgRoot  = 'D:\PostgreSQL'
$PgBin   = Join-Path $PgRoot 'bin'
$PgData  = Join-Path $PgRoot 'data'
$PgLog   = Join-Path $PgRoot 'postgres.log'
$Port    = 5432
$SuperUser = 'postgres'

function Assert-Binaries {
  if (-not (Test-Path (Join-Path $PgBin 'initdb.exe'))) {
    throw "找不到 PostgreSQL 程序文件：$PgBin\initdb.exe`n请先解压 zip 到 $PgRoot"
  }
}

function Get-PgStatus {
  if (-not (Test-Path $PgData)) { return 'not-initialized' }
  $pidFile = Join-Path $PgData 'postmaster.pid'
  if (-not (Test-Path $pidFile)) { return 'stopped' }
  $pidValue = (Get-Content $pidFile -First 1).Trim()
  $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if ($proc) { return 'running' } else { return 'stopped' }
}

switch ($Action) {

  'init' {
    Assert-Binaries
    if (Test-Path $PgData) {
      Write-Host "数据目录已存在，跳过初始化：$PgData" -ForegroundColor Yellow
      Write-Host "如需重新初始化，请先删除该目录（会丢失所有数据）"
      break
    }

    Write-Host "正在初始化数据库集群到 $PgData ..." -ForegroundColor Cyan
    # --auth-local=trust / --auth-host=scram-sha-256
    # 本地连接免密（仅供开发，服务器上绝不可这样配）
    & (Join-Path $PgBin 'initdb.exe') `
        -D $PgData `
        -U $SuperUser `
        --encoding=UTF8 `
        --locale=C `
        --auth-local=trust `
        --auth-host=scram-sha-256

    if ($LASTEXITCODE -ne 0) { throw "initdb 失败，退出码 $LASTEXITCODE" }

    # 开发环境：监听本机即可，端口 5432
    $conf = Join-Path $PgData 'postgresql.conf'
    Add-Content $conf "`n# ---- 本地开发配置 ----"
    Add-Content $conf "listen_addresses = '127.0.0.1'"
    Add-Content $conf "port = $Port"
    Add-Content $conf "max_connections = 50"
    # 低配机器上不需要太大
    Add-Content $conf "shared_buffers = 128MB"
    Add-Content $conf "work_mem = 4MB"

    Write-Host "✓ 初始化完成" -ForegroundColor Green
    Write-Host "  数据目录: $PgData"
    Write-Host "  超级用户: $SuperUser（本地免密）"
  }

  'start' {
    Assert-Binaries
    $status = Get-PgStatus
    if ($status -eq 'not-initialized') { throw "尚未初始化，请先运行: .\scripts\pg.ps1 init" }
    if ($status -eq 'running') { Write-Host "已在运行中" -ForegroundColor Yellow; break }

    Write-Host "正在启动 PostgreSQL ..." -ForegroundColor Cyan
    & (Join-Path $PgBin 'pg_ctl.exe') -D $PgData -l $PgLog -o "-p $Port" start
    Start-Sleep -Seconds 3

    if ((Get-PgStatus) -eq 'running') {
      Write-Host "✓ 已启动，监听 127.0.0.1:$Port" -ForegroundColor Green
    } else {
      Write-Host "✗ 启动失败，日志末尾：" -ForegroundColor Red
      Get-Content $PgLog -Tail 20 -ErrorAction SilentlyContinue
    }
  }

  'stop' {
    if ((Get-PgStatus) -ne 'running') { Write-Host "未在运行"; break }
    Write-Host "正在停止 ..." -ForegroundColor Cyan
    & (Join-Path $PgBin 'pg_ctl.exe') -D $PgData -m fast stop
    Write-Host "✓ 已停止" -ForegroundColor Green
  }

  'restart' {
    & $PSCommandPath stop
    Start-Sleep -Seconds 2
    & $PSCommandPath start
  }

  'status' {
    $status = Get-PgStatus
    switch ($status) {
      'not-initialized' { Write-Host "状态: 未初始化（运行 .\scripts\pg.ps1 init）" -ForegroundColor Yellow }
      'stopped'         { Write-Host "状态: 已停止（运行 .\scripts\pg.ps1 start）" -ForegroundColor Yellow }
      'running'         { Write-Host "状态: 运行中，127.0.0.1:$Port" -ForegroundColor Green }
    }
    if (Test-Path $PgData) {
      $size = (Get-ChildItem $PgData -Recurse -ErrorAction SilentlyContinue |
               Measure-Object -Property Length -Sum).Sum
      Write-Host "数据目录: $PgData ($([math]::Round($size/1MB,1)) MB)"
    }
  }

  'psql' {
    Assert-Binaries
    & (Join-Path $PgBin 'psql.exe') -h 127.0.0.1 -p $Port -U $SuperUser -d $Database
  }

  'createdb' {
    Assert-Binaries
    if ((Get-PgStatus) -ne 'running') { throw "PostgreSQL 未运行，请先 start" }

    foreach ($db in @('pindou', 'pindou_test')) {
      $exists = & (Join-Path $PgBin 'psql.exe') -h 127.0.0.1 -p $Port -U $SuperUser -d postgres `
                  -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'"
      if ($exists -eq '1') {
        Write-Host "已存在: $db" -ForegroundColor Yellow
      } else {
        & (Join-Path $PgBin 'createdb.exe') -h 127.0.0.1 -p $Port -U $SuperUser -E UTF8 $db
        Write-Host "✓ 已创建: $db" -ForegroundColor Green
      }
    }
  }

  'logs' {
    Get-Content $PgLog -Tail 50 -Wait
  }
}
