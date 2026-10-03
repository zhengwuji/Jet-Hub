# 部署 dsh-codearts-auth（Jet Hub）到当前 DSH Desktop profile
#
# 与仓库里那份 `deploy.ps1` 的差别：那份指向 `%APPDATA%\dsh-desktop\harness` 的
# **旧 generation 布局**（`.generations\live\<名字+摘要>`），本机实际不存在。
# 本机是 **profile 直装布局**：插件实体在
#   %USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-codearts-auth
# 由 pnpm 从 GitHub tarball 安装（文件是硬链接）。
#
# 用法：
#   pwsh -File deploy-profile.ps1            # 部署
#   pwsh -File deploy-profile.ps1 -DryRun    # 只校验
#   pwsh -File deploy-profile.ps1 -Rollback  # 回滚
#
# ⚠️ 部署后需要**重启 DSH Desktop** 才会加载新插件（Node 侧模块已进内存）。

[CmdletBinding()]
param(
  [switch]$Rollback,
  [switch]$DryRun,
  [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }),
  [string]$SourceDir = (Split-Path -Parent $MyInvocation.MyCommand.Path)
)

$ErrorActionPreference = 'Stop'

$PluginName = 'dsh-codearts-auth'
$ProfileDir = Join-Path (Join-Path $env:USERPROFILE '.dsh\profiles') $Profile
$Runtime    = Join-Path $ProfileDir "node_modules\$PluginName"
$BackupDir  = Join-Path $ProfileDir '.deploy-backup'
$StampFile  = Join-Path $BackupDir 'state.json'

# 只替换这些（与 package.json 的 files 字段一致）。
# ⚠️ 刻意**不含** pnpm-lock.yaml / .npmrc / package.json 之外的依赖文件：
# 动它们会让下次 `pnpm install` 与 lockfile 不一致。
$PluginFiles = @('lib', 'locale', 'cordis.patch.yml', 'LICENSE', 'README.md', 'package.json')

function Write-Step([string]$m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Write-Ok([string]$m)   { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Write-Warn2([string]$m){ Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Write-Err2([string]$m) { Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Write-Info([string]$m) { Write-Host "         $m" -ForegroundColor Gray }

# 先删后拷：**断开 pnpm 的硬链接**。直接 Copy-Item -Force 会写穿到
# pnpm store（硬链接共享 inode），污染其它 profile 的同一份包。
function Copy-Fresh([string]$From, [string]$To) {
  if (Test-Path $To) { Remove-Item $To -Recurse -Force }
  Copy-Item $From $To -Recurse -Force
}

# 写**无 BOM** 的 UTF-8 文件。
#
# ⚠️ 这是本脚本上一版引发过一次真实故障的地方，务必保留：
# Windows PowerShell 的 `Set-Content -Encoding UTF8` 会写入 **UTF-8 BOM**，
# 而 DSH 对 `package.json` 做**严格** `JSON.parse` —— BOM 会让它抛
# `SyntaxError: Unexpected token '\uFEFF'`，插件条目加载失败，
# 客户端 bundle 随之不再下发，症状是**设置里整块 Jet Hub 消失**
#（2026-10-04 实测：部署后 package.json 首三字节是 EF BB BF，备份是 7B）。
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
  if (-not (Test-Path $StampFile)) { throw "找不到部署记录 $StampFile，无法自动回滚" }
  $state = Get-Content $StampFile -Raw | ConvertFrom-Json
  if (-not (Test-Path $state.backupPath)) { throw "备份目录不存在: $($state.backupPath)" }
  Write-Host "  部署时间: $($state.deployedAt)"
  Write-Host "  备份位置: $($state.backupPath)"
  Copy-Fresh (Join-Path $state.backupPath 'runtime') $Runtime
  Write-Ok '已还原插件文件'
  Write-Host "`n请重启 DSH Desktop 使回滚生效。" -ForegroundColor Yellow
  exit 0
}

# ══════════════════════════════════════════════════════════════════════
Write-Step '0. 前置校验'
foreach ($p in @($SourceDir, $ProfileDir, $Runtime)) {
  if (-not (Test-Path $p)) { throw "路径不存在: $p" }
}
Write-Ok "源码目录 : $SourceDir"
Write-Ok "目标插件 : $Runtime"

$srcIndex  = Join-Path $SourceDir 'lib\index.js'
$srcBundle = Join-Path $SourceDir 'lib\client\jet-hub.js'
if (-not (Test-Path $srcIndex))  { throw "缺少构建产物 $srcIndex，请先构建（tsc）" }
if (-not (Test-Path $srcBundle)) { throw "缺少构建产物 $srcBundle，请先构建（esbuild）" }
Write-Ok '构建产物完备（index.js, client/jet-hub.js）'

$srcManifest  = Get-Content (Join-Path $SourceDir 'package.json') -Raw | ConvertFrom-Json
$instManifest = Get-Content (Join-Path $Runtime 'package.json') -Raw | ConvertFrom-Json
if ($srcManifest.name -ne $PluginName) { throw "manifest name 不匹配: $($srcManifest.name)" }

# 依赖必须与已装版本一致，否则 DSH 的依赖校验会失败。
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

# 版本号保持与已装一致：profile 的 package.json 把本插件钉在某个 tarball 提交上，
# 改版本号会让「已装版本」与 lockfile 记录不符。
$curVersion = $instManifest.version
Write-Ok "保持运行时版本声明 $curVersion"

if ($DryRun) {
  Write-Host "`n[DryRun] 全部校验通过，未做任何改动。" -ForegroundColor Green
  exit 0
}

# ══════════════════════════════════════════════════════════════════════
Write-Step '1. 备份现有插件文件'
if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }
Copy-Fresh $Runtime (Join-Path $BackupDir 'runtime')
[ordered]@{
  deployedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  backupPath = $BackupDir
  profile    = $Profile
} | ConvertTo-Json | ForEach-Object { Write-NoBom $StampFile $_ }
Write-Ok "已备份到 $BackupDir"

# ══════════════════════════════════════════════════════════════════════
Write-Step '2. 替换插件文件（先删后拷，断开硬链接）'
$copied = 0
foreach ($item in $PluginFiles) {
  $from = Join-Path $SourceDir $item
  if (-not (Test-Path $from)) { Write-Warn2 "源码缺少 $item，跳过"; continue }

  if ($item -eq 'package.json') {
    # 只改 version 一个字段，其余原样（含 dsh.bundle / exports / files）。
    $targetPkg = $srcManifest | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $targetPkg.version = $curVersion
    # ⚠️ 必须无 BOM 写入（见 Write-NoBom 的说明）—— 写 BOM 会让 DSH 读不了
    #    这份 manifest，整条插件在设置里消失。
    Write-NoBom (Join-Path $Runtime 'package.json') ($targetPkg | ConvertTo-Json -Depth 10)
    $copied++
    continue
  }

  Copy-Fresh $from (Join-Path $Runtime $item)
  $copied++
}
Write-Ok "已替换 $copied 项"

# ══════════════════════════════════════════════════════════════════════
Write-Step '3. 清理已废弃的遗留产物'
# 运行时里源码已不存在的旧 lib 文件（历史遗留产物）会被 Node 继续加载。
$runtimeLib = Join-Path $Runtime 'lib'
if (Test-Path $runtimeLib) {
  $srcLib = Join-Path $SourceDir 'lib'
  $removed = 0
  foreach ($file in Get-ChildItem $runtimeLib -Recurse -File) {
    $rel = $file.FullName.Substring($runtimeLib.Length + 1)
    if (-not (Test-Path (Join-Path $srcLib $rel))) {
      Remove-Item $file.FullName -Force
      $removed++
    }
  }
  if ($removed -gt 0) { Write-Ok "清理 $removed 个遗留产物" } else { Write-Ok '无遗留产物' }
}

# ══════════════════════════════════════════════════════════════════════
Write-Step '4. 部署后自检'
$checks = @(
  @{ name = 'lib/index.js';        path = Join-Path $Runtime 'lib\index.js' },
  @{ name = 'lib/client/jet-hub.js'; path = Join-Path $Runtime 'lib\client\jet-hub.js' },
  @{ name = 'lib/zcode.js';        path = Join-Path $Runtime 'lib\zcode.js' },
  @{ name = 'lib/catpaw.js';       path = Join-Path $Runtime 'lib\catpaw.js' },
  @{ name = 'lib/autoclaw.js';     path = Join-Path $Runtime 'lib\autoclaw.js' },
  @{ name = 'lib/accio.js';        path = Join-Path $Runtime 'lib\accio.js' }
)
foreach ($c in $checks) {
  if (Test-Path $c.path) { Write-Ok $c.name } else { Write-Warn2 "$($c.name) 不存在" }
}

# 客户端 bundle 必须含新 provider 的面板项（否则面板是空壳）。
# ⚠️ esbuild 会把源码里的单引号规范成**双引号**，故这里按双引号匹配 ——
#    上一版按 `id: 'zcode'` 匹配，结果每次都误报「bundle 缺 …」（假告警）。
$bundleText = Get-Content (Join-Path $Runtime 'lib\client\jet-hub.js') -Raw
foreach ($id in @('zcode', 'zcode-intl', 'catpaw', 'autoclaw', 'autoclaw-intl', 'accio', 'accio-cn')) {
  if ($bundleText.Contains("id: `"$id`"")) { Write-Ok "bundle 含 $id" } else { Write-Warn2 "bundle 缺 $id" }
}

# ⚠️ **关键守卫：任何被本脚本写过的 JSON/YAML 都不得带 UTF-8 BOM。**
#    DSH 对 package.json 做严格 JSON.parse，BOM 会让插件条目加载失败、
#    设置里整块 Jet Hub 消失（2026-10-04 真实故障）。这条检查就是为它加的。
$bomFiles = @()
foreach ($rel in @('package.json', 'cordis.patch.yml')) {
  $p = Join-Path $Runtime $rel
  if (-not (Test-Path $p)) { continue }
  $bytes = [System.IO.File]::ReadAllBytes($p)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) {
    $bomFiles += $rel
  }
}
if ($bomFiles.Count -gt 0) {
  Write-Err2 "以下文件带 UTF-8 BOM，DSH 会读不了（必须修）：$($bomFiles -join ', ')"
  throw "部署产物含 BOM，已中止报告 —— 请修好再重启 DSH。"
} else {
  Write-Ok '无 BOM（package.json / cordis.patch.yml 均为无 BOM UTF-8）'
}

# package.json 的首字节必须是 `{`。
#
# ⚠️ 不用 `ConvertFrom-Json` 当守卫：它**能容忍 BOM**，正是这一点让上一版的
#    故障躲过了自检（字段逐项比对全相等，但 Node 侧 JSON.parse 直接抛错）。
#    这里退回最朴素、也最贴近真实读法的判据：首字节就得是 `{`（0x7B）。
$pkgPath = Join-Path $Runtime 'package.json'
$pkgBytes = [System.IO.File]::ReadAllBytes($pkgPath)
if ($pkgBytes.Length -lt 1 -or $pkgBytes[0] -ne 123) {
  Write-Err2 "package.json 首字节不是 '{'（实际 $($pkgBytes[0])）—— 极可能有 BOM 或前导空白，DSH 的 JSON.parse 会失败。"
  throw 'package.json 首字节异常，已中止报告。'
}
Write-Ok "package.json 首字节为 '{'（无 BOM 无前导空白）"

Write-Host "`n部署完成。" -ForegroundColor Green
Write-Host "⚠️ 请**完全退出并重新打开 DSH Desktop**（不是刷新页面）—— 宿主侧模块已进内存。" -ForegroundColor Yellow
Write-Host "   回滚：pwsh -File deploy-profile.ps1 -Rollback" -ForegroundColor Gray
