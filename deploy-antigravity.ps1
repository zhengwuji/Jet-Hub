# 部署 dsh-codearts-auth（含 Antigravity 渠道）到 DSH Desktop 运行时
#
# ════════════════════════════════════════════════════════════════════════
# 排查结论（勿省，这些是踩过的坑）
# ════════════════════════════════════════════════════════════════════════
#
# 1. **DSH 加载的不是源码目录**
#    运行时根是 %APPDATA%\dsh-desktop\harness（**不是** ~/.dsh —— 那是另一个
#    独立位置）。插件以不可变 generation 快照的形式发布在：
#      profiles/.generations/live/<plugin>+<version>+<digest>/node_modules/<plugin>
#
# 2. **generation 目录名里的 digest 来自 pnpm-lock.yaml，不是内容哈希**
#    依据 registry.mjs 的 generationId()：
#      digest = sha256(lockfileText).slice(0, 12)
#    因此**只要不动 pnpm-lock.yaml 与版本号，原地替换 lib/ 内容后目录名依然正确**，
#    无需新建 generation、无需改 desired.json、无需改 profile override。
#    这是本脚本采用「原地更新」而非「新版本 generation」的原因 —— 改动面最小。
#
# 3. **快照内部是硬链接**
#    同一 generation 里 source/<plugin> 与 node_modules/<plugin> 是**硬链接对**
#    （同一 inode 两个路径）。用 Copy-Item -Force 原位覆盖会连带改写 source，
#    必须「先删后拷」让目标拿到独立 inode。
#
# 4. **插件 node_modules 保持原样**
#    依赖（jose / @deepseek-ai/*）由 generation 根的 pnpm 树提供，脚本不碰它们，
#    因此不会破坏依赖解析。package.json 的依赖声明也不修改（改了会触发校验失败）。
#
# 用法：
#   pwsh -File deploy-antigravity.ps1             # 部署
#   pwsh -File deploy-antigravity.ps1 -Rollback   # 回滚
#   pwsh -File deploy-antigravity.ps1 -DryRun     # 只校验不改动

[CmdletBinding()]
param(
  [switch]$Rollback,
  [switch]$DryRun,
  [string]$SourceDir = 'F:\源码\dsh-codearts-auth'
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

$BackupDir = Join-Path $HarnessHome "profiles\.antigravity-deploy-backup"
$StampFile = Join-Path $BackupDir 'state.json'

# 装进 generation 的发布文件（generation 是运行时快照：只含 lib + 清单，
# 不含 src/tests；依赖由 generation 根的 pnpm 树提供）。
$PluginFiles = @('lib', 'cordis.patch.yml', 'LICENSE', 'README.md', 'package.json')

# 这些文件**禁止改动**：改了会触发 DSH 的依赖闭包校验失败
$ForbiddenToChange = @('pnpm-lock.yaml', '.npmrc', 'pnpm-workspace.yaml', 'generation.json')

# ── 输出 helpers ──────────────────────────────────────────────────────
function Write-Step([string]$m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Write-Ok([string]$m)   { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Write-Warn2([string]$m){ Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Write-Err2([string]$m) { Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Write-Info([string]$m) { Write-Host "         $m" -ForegroundColor Gray }

# 先删后拷：避免写到硬链接而污染同 inode 的 source 副本
function Copy-Fresh([string]$From, [string]$To) {
  if (Test-Path $To) { Remove-Item $To -Recurse -Force }
  Copy-Item $From $To -Recurse -Force
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

  # 用备份覆盖回 runtime（先删后拷，保持一致性）
  Copy-Fresh (Join-Path $state.backupPath 'runtime') $Runtime
  if ((Test-Path (Join-Path $state.backupPath 'source')) -and (Test-Path $SourceMirror)) {
    Copy-Fresh (Join-Path $state.backupPath 'source') $SourceMirror
  }
  Write-Ok '已还原插件文件'

  $bundle = Join-Path $Runtime 'lib\client\jet-hub.js'
  $hits = (Select-String -Path $bundle -Pattern 'antigravity' -SimpleMatch -ErrorAction SilentlyContinue | Measure-Object).Count
  Write-Ok "还原后的 bundle antigravity 引用数: $hits（0 = 已回到旧版）"

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
Write-Ok "源码目录     : $SourceDir"
Write-Ok "目标 generation: $GenName"

$srcLib = Join-Path $SourceDir 'lib'
$srcBundle = Join-Path $srcLib 'client\jet-hub.js'
if (-not (Test-Path $srcBundle)) { throw "缺少构建产物 $srcBundle，请先构建" }

$bundleHits = (Select-String -Path $srcBundle -Pattern 'antigravity' -SimpleMatch | Measure-Object).Count
if ($bundleHits -eq 0) { throw '源码 client bundle 不含 antigravity，请重建后再部署' }
Write-Ok "client bundle 含 antigravity（$bundleHits 处引用）"

$requiredArtifacts = @(
  'antigravity.js', 'antigravity-adapter.js',
  'antigravity-local.js', 'antigravity-local-adapter.js'
)
foreach ($a in $requiredArtifacts) {
  if (-not (Test-Path (Join-Path $srcLib $a))) { throw "源码 lib 缺少 $a" }
}
Write-Ok 'lib 含全部 4 个 antigravity 产物'

$srcIndex = Join-Path $srcLib 'index.js'
$idxHits = (Select-String -Path $srcIndex -Pattern 'registerAntigravityLocalLlm' -SimpleMatch | Measure-Object).Count
if ($idxHits -eq 0) { throw '源码 index.js 未注册 registerAntigravityLocalLlm（构建产物可能过期）' }
Write-Ok 'index.js 已注册 registerAntigravityLocalLlm'

# 依赖声明必须与已装版本一致 —— 不一致会触发 DSH 的依赖闭包校验失败
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

# 原地更新方案：pnpm-lock.yaml / version 必须保持不变（digest 由 lockfile 决定）
$curVersion = $instManifest.version
if ($curVersion -ne '0.1.0') {
  Write-Warn2 "已装版本是 $curVersion（期望 0.1.0），将保持原样不改动"
}
Write-Ok "版本号保持 $curVersion（digest 由 pnpm-lock.yaml 决定，改版本会让目录名失效）"

# 确认 desired.json 已登记该 generation
$desiredPath = Join-Path $HarnessHome 'profiles\.generations\desired.json'
if (Test-Path $desiredPath) {
  $desired = Get-Content $desiredPath -Raw | ConvertFrom-Json
  if ($desired -contains $GenName) {
    Write-Ok "desired.json 已登记该 generation"
  } else {
    throw "desired.json 未登记 $GenName，DSH 可能不会加载它。请先用 DSH 插件市场正常安装一次。"
  }
} else {
  Write-Warn2 '未找到 desired.json（DSH 版本可能不同）'
}

$currentHits = (Select-String -Path (Join-Path $Runtime 'lib\client\jet-hub.js') -Pattern 'antigravity' -SimpleMatch -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Info "当前已装 bundle 的 antigravity 引用数: $currentHits（0 = 旧版，需要部署）"

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
Write-Step '2. 替换插件文件（先删后拷，避开硬链接）'
$copied = 0
foreach ($item in $PluginFiles) {
  $from = Join-Path $SourceDir $item
  if (-not (Test-Path $from)) { Write-Warn2 "源码缺少 $item，跳过"; continue }
  if ($ForbiddenToChange -contains $item) { Write-Warn2 "跳过受保护文件 $item"; continue }

  Copy-Fresh $from (Join-Path $Runtime $item)
  if (Test-Path $SourceMirror) { Copy-Fresh $from (Join-Path $SourceMirror $item) }
  $copied++
}
Write-Ok "已替换 $copied 项"

# ══════════════════════════════════════════════════════════════════════
Write-Step '3. 校验部署结果'
# 注意：插件本体**本就不含 node_modules** —— peer 依赖（@deepseek-ai/*）由宿主
# 运行时注入，dependencies（jose 等）由 generation 根的 pnpm 树提供。
# 因此这里校验的是「插件文件齐全」+「generation 根的依赖树未被破坏」。
$must = [ordered]@{
  'lib/index.js'                     = (Join-Path $Runtime 'lib\index.js')
  'lib/client/jet-hub.js'            = (Join-Path $Runtime 'lib\client\jet-hub.js')
  'lib/antigravity.js'               = (Join-Path $Runtime 'lib\antigravity.js')
  'lib/antigravity-adapter.js'       = (Join-Path $Runtime 'lib\antigravity-adapter.js')
  'lib/antigravity-local.js'         = (Join-Path $Runtime 'lib\antigravity-local.js')
  'lib/antigravity-local-adapter.js' = (Join-Path $Runtime 'lib\antigravity-local-adapter.js')
  'package.json'                     = (Join-Path $Runtime 'package.json')
  # generation 根的依赖树必须完好（脚本刻意不碰这些）
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

# 内容校验
$nb = Join-Path $Runtime 'lib\client\jet-hub.js'
$ni = Join-Path $Runtime 'lib\index.js'
$bh = (Select-String -Path $nb -Pattern 'antigravity' -SimpleMatch | Measure-Object).Count
$ih = (Select-String -Path $ni -Pattern 'registerAntigravityLocalLlm' -SimpleMatch | Measure-Object).Count
if ($bh -eq 0) { throw '部署后 client bundle 不含 antigravity' }
if ($ih -eq 0) { throw '部署后 index.js 未注册 registerAntigravityLocalLlm' }
Write-Ok "client bundle 含 antigravity（$bh 处，部署前为 $currentHits）"
Write-Ok 'index.js 注册 registerAntigravityLocalLlm'

# 清理运行时中旧的 Qoder 产物（若存在）
Get-ChildItem (Join-Path $Runtime 'lib') -Filter 'qoder*' -File -ErrorAction SilentlyContinue | ForEach-Object {
  Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
}

# 逐文件哈希比对，确保拷贝无损
$diffFiles = @()
Get-ChildItem $srcLib -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($srcLib.Length + 1)
  $target = Join-Path (Join-Path $Runtime 'lib') $rel
  if (-not (Test-Path $target)) { $diffFiles += $rel; return }
  if ((Get-FileHash $_.FullName).Hash -ne (Get-FileHash $target).Hash) { $diffFiles += $rel }
}
if ($diffFiles.Count) { throw "lib 拷贝后 $($diffFiles.Count) 个文件不一致: $($diffFiles -join ', ')" }
Write-Ok "lib 全部 $( (Get-ChildItem $srcLib -Recurse -File).Count ) 个文件哈希一致"

# 确认硬链接已断开（runtime 与 source 现在是独立 inode，可安全各自演进）
$rtFile = Join-Path $Runtime 'lib\client\jet-hub.js'
$links = fsutil hardlink list $rtFile 2>$null
Write-Info "jet-hub.js 当前链接数: $(($links | Measure-Object).Count)"

# 语法校验（node --check 不解析依赖，只查语法）
$synBad = @()
foreach ($f in @(
  'lib\index.js', 'lib\antigravity-local.js', 'lib\antigravity-local-adapter.js',
  'lib\client\jet-hub.js'
)) {
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

  下一步：**正常退出 DSH Desktop 并重新打开**（菜单退出，勿强杀进程），
  然后到 设置 -> Jet Hub -> Antigravity 面板确认出现通道状态卡片。

  回滚：pwsh -File "$PSCommandPath" -Rollback
"@ -ForegroundColor Green
