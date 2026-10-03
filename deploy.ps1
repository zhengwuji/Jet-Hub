# 部署 dsh-codearts-auth 到 DSH Desktop 运行时
#
# 用法：
#   pwsh -File deploy.ps1             # 部署
#   pwsh -File deploy.ps1 -Rollback   # 回滚
#   pwsh -File deploy.ps1 -DryRun     # 只校验不改动

[CmdletBinding()]
param(
  [switch]$Rollback,
  [switch]$DryRun,
  [string]$SourceDir = (Split-Path -Parent $MyInvocation.MyCommand.Path)
)

$ErrorActionPreference = 'Stop'

# ── 常量 ──────────────────────────────────────────────────────────────
$HarnessHome     = Join-Path $env:APPDATA 'dsh-desktop\harness'
$GenerationsDir  = Join-Path $HarnessHome 'profiles\.generations\live'
$ProfileDir      = Join-Path $HarnessHome 'profiles\web'

$PluginName = 'dsh-codearts-auth'
$GenName    = "$PluginName+0.1.0+33d7aede97fa"   # 原地更新，名字不变
$GenDir     = Join-Path $GenerationsDir $GenName
$Runtime    = Join-Path $GenDir "node_modules\$PluginName"
$SourceMirror = Join-Path $GenDir "source\$PluginName"

$BackupDir = Join-Path $HarnessHome "profiles\.deploy-backup"
$StampFile = Join-Path $BackupDir 'state.json'

$PluginFiles = @('lib', 'cordis.patch.yml', 'LICENSE', 'README.md', 'package.json')
$ForbiddenToChange = @('pnpm-lock.yaml', '.npmrc', 'pnpm-workspace.yaml', 'generation.json')

# ── 输出 helpers ──────────────────────────────────────────────────────
function Write-Step([string]$m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Write-Ok([string]$m)   { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Write-Warn2([string]$m){ Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Write-Err2([string]$m) { Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Write-Info([string]$m) { Write-Host "         $m" -ForegroundColor Gray }

function Copy-Fresh([string]$From, [string]$To) {
  if (Test-Path $To) { Remove-Item $To -Recurse -Force }
  Copy-Item $From $To -Recurse -Force
}

# 写**无 BOM** 的 UTF-8 文件。
#
# ⚠️ Windows PowerShell 的 `Set-Content -Encoding UTF8` 会写入 **UTF-8 BOM**，
# 而 DSH 对 `package.json` 做**严格** `JSON.parse` —— BOM 会让它抛
# `SyntaxError: Unexpected token '\uFEFF'`，插件条目加载失败、客户端 bundle
# 不再下发，症状是**设置里整块 Jet Hub 消失**（2026-10-04 实测：
# 部署后 package.json 首三字节 EF BB BF，而备份是 7B）。
# .NET 的 `UTF8Encoding($false)` 才是真正的「无 BOM」。
function Write-NoBom([string]$Path, [string]$Content) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

# ══════════════════════════════════════════════════════════════════════
# 回滚
# ══════════════════════════════════════════════════════════════════════
if ($Rollback) {
  Write-Step '回滚到部署前状态'
  if (-not (Test-Path $StampFile)) {
    throw "找不到部署记录 $StampFile，无法自动回滚"
  }
  $state = Get-Content $StampFile -Raw | ConvertFrom-Json
  if (-not (Test-Path $state.backupPath)) {
    throw "备份目录不存在: $($state.backupPath)"
  }
  Write-Host "  部署时间: $($state.deployedAt)"
  Write-Host "  备份位置: $($state.backupPath)"

  Copy-Fresh (Join-Path $state.backupPath 'runtime') $Runtime
  if ((Test-Path (Join-Path $state.backupPath 'source')) -and (Test-Path $SourceMirror)) {
    Copy-Fresh (Join-Path $state.backupPath 'source') $SourceMirror
  }
  Write-Ok '已还原插件文件'
  Write-Host "`n请正常退出并重新打开 DSH Desktop 使回滚生效。" -ForegroundColor Yellow
  exit 0
}

# ══════════════════════════════════════════════════════════════════════
# 前置校验
# ══════════════════════════════════════════════════════════════════════
Write-Step '0. 前置校验'
foreach ($p in @($SourceDir, $GenDir, $Runtime)) {
  if (-not (Test-Path $p)) { throw "路径不存在: $p" }
}
Write-Ok "源码目录       : $SourceDir"
Write-Ok "目标 generation: $GenName"

$srcLib = Join-Path $SourceDir 'lib'
$srcBundle = Join-Path $srcLib 'client\jet-hub.js'
$srcIndex  = Join-Path $srcLib 'index.js'
if (-not (Test-Path $srcBundle)) { throw "缺少构建产物 $srcBundle，请先执行 pnpm build:all" }
if (-not (Test-Path $srcIndex))  { throw "缺少构建产物 $srcIndex，请先执行 pnpm build:all" }

Write-Ok "构建产物完备 (index.js, jet-hub.js)"

$srcManifest = Get-Content (Join-Path $SourceDir 'package.json') -Raw | ConvertFrom-Json
$instManifest = Get-Content (Join-Path $Runtime 'package.json') -Raw | ConvertFrom-Json

$norm = {
  param($o)
  if (-not $o) { return '' }
  ($o.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" } | Sort-Object) -join ';'
}
foreach ($field in @('dependencies', 'peerDependencies')) {
  $a = & $norm $srcManifest.$field
  $b = & $norm $instManifest.$field
  if ($a -ne $b) {
    throw "package.json 的 $field 与已装版本不一致，会触发依赖校验失败。`n  源码: $a`n  已装: $b"
  }
}
Write-Ok 'dependencies / peerDependencies 与已装版本一致'
if ($srcManifest.name -ne $PluginName) { throw "manifest name 不匹配: $($srcManifest.name)" }
Write-Ok 'manifest name 匹配'

$curVersion = $instManifest.version
Write-Ok "保持运行时版本声明 $curVersion（以保证 generation digest 吻合）"

$desiredPath = Join-Path $HarnessHome 'profiles\.generations\desired.json'
if (Test-Path $desiredPath) {
  $desired = Get-Content $desiredPath -Raw | ConvertFrom-Json
  if ($desired -contains $GenName) {
    Write-Ok "desired.json 已登记该 generation"
  } else {
    throw "desired.json 未登记 $GenName"
  }
}

if ($DryRun) {
  Write-Host "`n[DryRun] 全部校验通过，未做任何改动。" -ForegroundColor Green
  exit 0
}

# ══════════════════════════════════════════════════════════════════════
Write-Step '1. 备份现有插件文件'
if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }
$backupRuntime = Join-Path $BackupDir 'runtime'
$backupSource = Join-Path $BackupDir 'source'
Copy-Fresh $Runtime $backupRuntime
if (Test-Path $SourceMirror) { Copy-Fresh $SourceMirror $backupSource }
[ordered]@{
  deployedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  backupPath = $BackupDir
  generation = $GenName
} | ConvertTo-Json | Set-Content $StampFile -Encoding UTF8
Write-Ok "已备份到 $BackupDir"

# ══════════════════════════════════════════════════════════════════════
Write-Step '2. 替换插件文件（先删后拷，断开硬链接）'
$copied = 0
foreach ($item in $PluginFiles) {
  $from = Join-Path $SourceDir $item
  if (-not (Test-Path $from)) { Write-Warn2 "源码缺少 $item，跳过"; continue }
  if ($ForbiddenToChange -contains $item) { Write-Warn2 "跳过受保护文件 $item"; continue }

  # 若是 package.json，需确保 version 与已装 generation 声明严格一致
  if ($item -eq 'package.json') {
    $targetPkg = $srcManifest | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $targetPkg.version = $curVersion
    $pkgJson = $targetPkg | ConvertTo-Json -Depth 10
    # ⚠️ 必须无 BOM（见 Write-NoBom 的说明）：写 BOM 会让 DSH 读不了这份
    #    manifest，整条插件在设置里消失。
    Write-NoBom (Join-Path $Runtime 'package.json') $pkgJson
    if (Test-Path $SourceMirror) {
      Write-NoBom (Join-Path $SourceMirror 'package.json') $pkgJson
    }
    $copied++
    continue
  }

  Copy-Fresh $from (Join-Path $Runtime $item)
  if (Test-Path $SourceMirror) { Copy-Fresh $from (Join-Path $SourceMirror $item) }
  $copied++
}
Write-Ok "已替换 $copied 项"

# ══════════════════════════════════════════════════════════════════════
Write-Step '3. 清理已废弃的遗留产物'
# 清理运行时中源码已经不存在的旧文件（历史遗留产物）
$runtimeLib = Join-Path $Runtime 'lib'
$sourceLibFiles = Get-ChildItem $srcLib -Recurse -File | ForEach-Object {
  $_.FullName.Substring($srcLib.Length + 1)
}

$cleanedCount = 0
Get-ChildItem $runtimeLib -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($runtimeLib.Length + 1)
  if ($sourceLibFiles -notcontains $rel) {
    Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
    $mirrorFile = Join-Path (Join-Path $SourceMirror 'lib') $rel
    if (Test-Path $mirrorFile) {
      Remove-Item $mirrorFile -Force -ErrorAction SilentlyContinue
    }
    Write-Info "已清理废弃文件: $rel"
    $cleanedCount++
  }
}
Write-Ok "已清理 $cleanedCount 个已废弃产物文件"

# ══════════════════════════════════════════════════════════════════════
Write-Step '4. 校验部署结果'
$must = [ordered]@{
  'lib/index.js'                     = (Join-Path $Runtime 'lib\index.js')
  'lib/client/jet-hub.js'            = (Join-Path $Runtime 'lib\client\jet-hub.js')
  'package.json'                     = (Join-Path $Runtime 'package.json')
  '依赖树 jose'                       = (Join-Path $GenDir 'node_modules\jose')
  '依赖树 .pnpm'                      = (Join-Path $GenDir 'node_modules\.pnpm')
  '依赖树 .modules.yaml'              = (Join-Path $GenDir 'node_modules\.modules.yaml')
  'pnpm-lock.yaml（未改动）'          = (Join-Path $GenDir 'pnpm-lock.yaml')
  'generation.json（未改动）'         = (Join-Path $GenDir 'generation.json')
}
$bad = @()
foreach ($k in $must.Keys) {
  if (Test-Path $must[$k]) { Write-Ok $k } else { Write-Err2 $k; $bad += $k }
}
if ($bad.Count) { throw "部署后缺少: $($bad -join ', ')" }

# 逐文件哈希比对，确保拷贝无损
$diffFiles = @()
Get-ChildItem $srcLib -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($srcLib.Length + 1)
  $target = Join-Path $runtimeLib $rel
  if (-not (Test-Path $target)) { $diffFiles += $rel; return }
  if ((Get-FileHash $_.FullName).Hash -ne (Get-FileHash $target).Hash) { $diffFiles += $rel }
}
if ($diffFiles.Count) { throw "lib 拷贝后 $($diffFiles.Count) 个文件不一致: $($diffFiles -join ', ')" }
Write-Ok "lib 全部 $( (Get-ChildItem $srcLib -Recurse -File).Count ) 个文件哈希一致"

# 语法校验（node --check 不解析依赖，只查语法）
$synBad = @()
foreach ($f in @('lib\index.js', 'lib\client\jet-hub.js')) {
  $p = Join-Path $Runtime $f
  & node --check $p 2>$null
  if ($LASTEXITCODE -ne 0) { $synBad += $f } else { Write-Ok "语法 OK: $f" }
}
if ($synBad.Count) { throw "语法校验失败: $($synBad -join ', ')" }

# ══════════════════════════════════════════════════════════════════════
Write-Step '完成'
Write-Host @"
  目标 generation : $GenName
  运行时目录      : $Runtime
  备份            : $BackupDir

  下一步：**正常退出 DSH Desktop 并重新打开**（从托盘或菜单正常退出），
  新版本插件即可自动加载生效！

  如需回滚：pwsh -File "$PSCommandPath" -Rollback
"@ -ForegroundColor Green
