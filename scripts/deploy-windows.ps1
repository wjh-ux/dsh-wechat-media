<#
.SYNOPSIS
  dsh-wechat-media 的一键部署：环境 + 插件 + 自检。

.DESCRIPTION
  给一台**全新的 Windows 机器**用：把插件跑起来所需的东西装齐，再把插件装进 DSH 的 profile，最后逐项验证。
  每一步都"先检查、再动手、最后用真命令验证"——文件在不在不等于能用，所以验证一律是跑 `--version`
  或真的 import 一次。

  这个脚本可以重复跑：
    - 已经装好的工具会跳过（不会重复下载 350 MB）
    - profile 里已有的 package.json 会先备份再合并，不会覆盖你其它配置
    - 指向别处的 junction 会被拒绝，而不是悄悄删掉

  典型用法：
    .\deploy-windows.ps1                  # 完整部署（环境 + 插件 + 自检）
    .\deploy-windows.ps1 -CheckOnly       # 只看缺什么，什么都不改
    .\deploy-windows.ps1 -SkipTools       # 只部署插件（环境已就绪）
    .\deploy-windows.ps1 -LocalPath D:\src\dsh-wechat-media   # 用本地检出而不是 clone

.PARAMETER CheckOnly
  只体检：列出每一项的状态，不做任何修改。适合先看看这台机器差什么。

.PARAMETER SkipTools
  跳过环境安装（python 包 / arduino-cli / arm 工具链），只做插件部署。

.PARAMETER SkipToolchain
  跳过 ARM 工具链（arm-none-eabi-gcc 约 320 MB + cmake / ninja / openocd）。
  只想先确认"插件能装进 DSH 并启动"时用；之后想编 STM32 再去掉这个开关重跑即可。

.PARAMETER SkipArduino
  不装 arduino-cli 及其核心（只做 STC / STM32 的人可以省 1 GB 以上）。

.PARAMETER WithEsp32Core
  额外装 esp32 的 Arduino 核心（约 1.2 GB）。默认只装 arduino:avr（UNO/Mega/Nano）。

.PARAMETER Offline
  不联网、不下载：只检测，以及把已有的插件接进 profile。给离线机器，或已经把 ~\tools 整个拷过来的 VM。
  缺什么就报什么，不尝试安装。

.PARAMETER NoSelfTest
  跳过最后的冒烟测试。

.EXAMPLE
  .\deploy-windows.ps1 -CheckOnly
  体检这台机器。

.EXAMPLE
  .\deploy-windows.ps1 -LocalPath C:\work\dsh-wechat-media -Profile desktop
  用本地检出装进 desktop profile。
#>
[CmdletBinding()]
param(
  [string]$ToolsRoot = "$env:USERPROFILE\tools",
  [string]$InstallDir = "$env:USERPROFILE\dsh-wechat-media",
  [string]$Profile = "desktop",
  [string]$Source = "https://github.com/wjh-ux/dsh-wechat-media.git",
  [string]$LocalPath = "",
  [switch]$CheckOnly,
  [switch]$SkipTools,
  [switch]$SkipArduino,
  [switch]$SkipToolchain,
  [switch]$SkipCh340,
  [string]$Ch340Installer = "",
  [switch]$WithEsp32Core,
  [switch]$NoSelfTest,
  [switch]$Offline,
  [switch]$ResolveOnly
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest 的进度条会让下载慢十倍

# ── 报告 ──────────────────────────────────────────────────────────────────────
$script:Report = @()
function Step($n, $total, $text) { Write-Host "`n[$n/$total] $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "  ✔ $text" -ForegroundColor Green;  $script:Report += [pscustomobject]@{ 项 = $text; 状态 = "✔" } }
function Miss($text) { Write-Host "  – $text" -ForegroundColor Yellow; $script:Report += [pscustomobject]@{ 项 = $text; 状态 = "缺" } }
function Bad($text)  { Write-Host "  ✖ $text" -ForegroundColor Red;    $script:Report += [pscustomobject]@{ 项 = $text; 状态 = "✖" } }
function Info($text) { Write-Host "    $text" -ForegroundColor DarkGray }

# 装完东西要立刻能用：winget 改的是注册表里的 PATH，当前进程看不到。这个从注册表把机器级+用户级 PATH 重新拼一遍。
function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:PATH = (@($machine, $user) | Where-Object { $_ }) -join ";"
}

# 用 winget 装一个包，并验证它真的出现了（winget 返回 0 不等于装好了：还要看命令能不能找到）。
function Install-WithWinget {
  param([Parameter(Mandatory)][string]$Id, [Parameter(Mandatory)][string]$Probe, [string]$Name = $Id)
  if (-not (Have "winget")) {
    Bad "没有 winget，装不了 $Name"
    Info "Windows 10 1809 以下没有 winget；也可以从官网下安装包手动装"
    return $false
  }
  Write-Host "    winget install $Id …" -ForegroundColor DarkGray
  & winget install --id $Id --exact --silent --accept-package-agreements --accept-source-agreements 2>&1 |
    Select-String -Pattern "已成功|Successfully|已安装|already installed|失败|error" | ForEach-Object { Info $_.Line.Trim() }
  Refresh-Path
  if (Have $Probe) { Ok "$Name 已可用：$((Get-Command $Probe).Source)"; return $true }
  Bad "$Name 装完了但命令还是找不到（可能需要重新登录，或 PATH 里有别的问题）"
  return $false
}

# ── 没有 winget 时的备用安装 ──────────────────────────────────────────────────
# 真实踩到：VM 是 Win10 1809 以下（或精简版），没有 winget，于是 Node/Python/VS Code 一个都装不上，
# 而 arduino-cli 与 ARM 工具链是直链下载、照常成功 —— 结果装了一半。下面用官方安装包补上这条路。

# 三个地址解析（安装器与 -ResolveOnly 共用同一套逻辑，避免两处各写一遍再漂移）
function Get-NodeMsiUrl {
  $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -TimeoutSec 60
  $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
  if (-not $lts) { throw "拿不到 Node 的 LTS 版本号" }
  $version = $lts.version
  return @{ Version = $version; Url = "https://nodejs.org/dist/$version/node-$version-x64.msi" }
}

function Get-PythonExeUrl {
  <#
    python.org 的 ftp 目录里有 3.12.11 及以后的文件夹，但那些是**仅源码**的安全版本，里面没有 .exe。
    第一版直接取"最新目录"，于是拿到 3.12.16 的地址、下载 404（VM 上真实发生）。
    现在从新到旧逐个 HEAD，直到找到真的带 amd64 安装包的那个。
  #>
  $listing = Invoke-WebRequest -Uri "https://www.python.org/ftp/python/" -TimeoutSec 60 -UseBasicParsing
  $versions = [regex]::Matches($listing.Content, 'href="(3\.12\.\d+)/"') |
    ForEach-Object { $_.Groups[1].Value } |
    Sort-Object { [version]$_ } -Descending
  if (-not $versions) { throw "ftp 目录里没有 3.12.x" }

  $tried = 0
  foreach ($version in $versions) {
    if ($tried -ge 12) { break }        # 有上限，别在弱网下探太久
    $tried++
    $url = "https://www.python.org/ftp/python/$version/python-$version-amd64.exe"
    try {
      $head = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 20
      if ($head.StatusCode -eq 200) {
        return @{ Version = $version; Url = $url; Probed = $tried }
      }
    } catch {
      # 404 就是"这个版本没有 Windows 安装包"，继续往旧看
    }
  }
  throw "3.12.x 里没找到带 amd64 安装包的版本（探了 $tried 个）"
}

function Get-VSCodeExeUrl {
  # 这个地址 302 到当前 stable 的 User 安装包。第一版用 `-MaximumRedirection 0` 想直接读 Location，
  # 在 PS 5.1 里抛的是 "Operation is not valid due to the current state of the object"，拿不到头；
  # 改成跟随重定向、从最终 URL 里读（实测 status=200，final=…/VSCodeUserSetup-x64-1.144.0.exe）。
  $response = Invoke-WebRequest -Uri "https://update.code.visualstudio.com/latest/win32-x64-user/stable" `
    -Method Head -MaximumRedirection 5 -UseBasicParsing -TimeoutSec 60 -ErrorAction Stop
  $final = $response.BaseResponse.ResponseUri.AbsoluteUri
  if (-not $final) { throw "重定向后拿不到最终地址" }
  $name = ($final -split "/")[-1]
  $version = "latest"
  if ($name -match '(\d+\.\d+\.\d+)') { $version = $Matches[1] }
  return @{ Version = $version; Url = $final }
}

# 下载工具的通用实现：流式写入 + 进度/速度/剩余时间。
# 为什么要自己写：Invoke-WebRequest 的进度条慢得离谱（所以最早把它关了），关掉之后又什么都看不见。
# 这里用 HttpWebRequest 的流，自己按 500ms 刷新一行，两边都不吃亏。
function Format-Bytes([double]$bytes) {
  if ($bytes -ge 1GB) { return "{0:N2} GB" -f ($bytes / 1GB) }
  if ($bytes -ge 1MB) { return "{0:N1} MB" -f ($bytes / 1MB) }
  if ($bytes -ge 1KB) { return "{0:N0} KB" -f ($bytes / 1KB) }
  return "{0:N0} B" -f $bytes
}

function Save-Installer([string]$Url, [string]$FileName) {
  $path = Join-Path $env:TEMP $FileName
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $request = [Net.HttpWebRequest]::Create($Url)
  $request.UserAgent = "dsh-deploy"
  $request.Timeout = 60000
  $request.ReadWriteTimeout = 300000
  $response = $request.GetResponse()
  $total = $response.ContentLength
  $stream = $response.GetResponseStream()
  $file = [IO.File]::Create($path)
  $buffer = New-Object byte[] 131072
  $done = 0L
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $lastTick = -1000
  $lastBytes = 0L
  try {
    while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $file.Write($buffer, 0, $read)
      $done += $read
      if ($clock.ElapsedMilliseconds - $lastTick -ge 500) {
        $speed = 0
        $elapsedMs = $clock.ElapsedMilliseconds - $lastTick
        if ($elapsedMs -gt 0) { $speed = ($done - $lastBytes) / ($elapsedMs / 1000.0) }
        $lastTick = $clock.ElapsedMilliseconds
        $lastBytes = $done
        $line = "      "
        if ($total -gt 0) {
          $percent = [Math]::Min(100, [int](100 * $done / $total))
          $filled = [int]($percent / 4)                       # 25 格的进度条
          $bar = ("#" * $filled) + ("-" * (25 - $filled))
          $eta = ""
          if ($speed -gt 0 -and $done -lt $total) {
            $eta = "  还剩 {0:N0}s" -f (($total - $done) / $speed)
          }
          $line += "[$bar] {0,3}%  {1} / {2}  {3}/s{4}" -f $percent, (Format-Bytes $done), (Format-Bytes $total), (Format-Bytes $speed), $eta
        } else {
          $line += "{0}  {1}/s（服务器没给总大小）" -f (Format-Bytes $done), (Format-Bytes $speed)
        }
        Write-Host "`r$line" -NoNewline
      }
    }
  } finally {
    $file.Close()
    $stream.Close()
    $response.Close()
  }
  $clock.Stop()
  $finalLine = "      {0} 用时 {1:N1}s（平均 {2}/s）" -f (Format-Bytes $done), $clock.Elapsed.TotalSeconds, (Format-Bytes ($done / [Math]::Max($clock.Elapsed.TotalSeconds, 0.1)))
  Write-Host "`r$finalLine" -ForegroundColor DarkGray
  return $path
}

function Install-NodeFallback {
  try {
    $found = Get-NodeMsiUrl
    $version = $found.Version
    # 先试 MSI（机器级，要管理员）；失败就退到 zip（不需要）
    Info "Node.js LTS $version（先试官方 msi）"
    $msi = Save-Installer $found.Url "node-$version-x64.msi"
    $proc = Start-Process msiexec.exe -ArgumentList @("/i", "`"$msi`"", "/qn", "/norestart") -Wait -PassThru
    Remove-Item $msi -Force -ErrorAction SilentlyContinue
    Refresh-Path
    if (Have "node") { Ok "node $(Read-Version 'node' @('--version'))"; return $true }

    Info "msiexec 退出码 $($proc.ExitCode)（1603 通常是权限）——改用免管理员的 zip"
    if (Install-ZipNode -Version $version) {
      if (Have "node") { Ok "node $(Read-Version 'node' @('--version'))（zip 安装）"; return $true }
      Bad "zip 解开了但 node 仍不可用"; return $false
    }
    Bad "Node 安装失败：msi 与 zip 都没成"
    return $false
  } catch { Bad "Node 安装失败：$($_.Exception.Message)"; return $false }
}

function Install-PythonFallback {
  try {
    $found = Get-PythonExeUrl
    Info "Python $($found.Version)（官方安装包，当前用户 + 加进 PATH）"
    $exe = Save-Installer $found.Url "python-$($found.Version)-amd64.exe"
    # InstallAllUsers=0：不需要管理员；PrependPath=1：装完在 PATH 里；Include_pip=1：带 pip
    $proc = Start-Process $exe -ArgumentList @("/quiet", "InstallAllUsers=0", "PrependPath=1", "Include_pip=1") -Wait -PassThru
    Remove-Item $exe -Force -ErrorAction SilentlyContinue
    Refresh-Path
    foreach ($candidate in @("python", "python3", "py")) {
      if (Have $candidate) { Ok "$candidate $(Read-Version $candidate @('--version'))"; return $true }
    }
    Bad "安装器退出码 $($proc.ExitCode)，python 仍不可用"
    return $false
  } catch { Bad "Python 安装失败：$($_.Exception.Message)"; return $false }
}

function Install-VSCodeFallback {
  try {
    $found = Get-VSCodeExeUrl
    Info "VS Code（官方 User 安装包）"
    $exe = Save-Installer $found.Url "VSCodeUserSetup.exe"
    # /MERGETASKS=!runcode：装完不自动启动；把 code 加进 PATH 由安装器默认任务完成
    $proc = Start-Process $exe -ArgumentList @("/VERYSILENT", "/NORESTART", "/MERGETASKS=!runcode") -Wait -PassThru
    Remove-Item $exe -Force -ErrorAction SilentlyContinue
    Refresh-Path
    if (Have "code") { Ok "VS Code $((& code --version 2>&1 | Select-Object -First 1))"; return $true }
    Bad "安装器退出码 $($proc.ExitCode)，code 仍不可用"
    return $false
  } catch { Bad "VS Code 安装失败：$($_.Exception.Message)"; return $false }
}

# 统一入口：先试 winget（有就用），没有或失败就退回官方安装包。
function Install-Package {
  param(
    [Parameter(Mandatory)][string]$Id,
    [Parameter(Mandatory)][string]$Probe,
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][scriptblock]$Fallback
  )
  if (Have "winget") {
    if (Install-WithWinget -Id $Id -Probe $Probe -Name $Name) { return $true }
    Info "winget 这条路没成，改用官方安装包"
  } else {
    Info "这台机器没有 winget，改用官方安装包"
  }
  return (& $Fallback)
}

function Have($command) {
  return [bool](Get-Command $command -ErrorAction SilentlyContinue)
}

# 第二个参数**不能**叫 $args：那是 PowerShell 的自动变量，第一版因此什么都没传给 --version，
# 于是每个工具的"版本"都变成了 "Usage" 或 "fatal error: no input files"。
function Read-Version([string]$command, [string[]]$ArgList = @()) {
  try {
    $out = & $command @ArgList 2>&1 | Select-Object -First 1
    if ($LASTEXITCODE -eq 0 -or $out) { return ("" + $out).Trim() }
  } catch { }
  return ""
}

# 下载并解压一个便携工具（xpack / arduino-cli 都发 win32-x64 的 zip，解压出来带一层目录）
function Install-PortableZip {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Url,
    [Parameter(Mandatory)][string]$Destination,
    [string]$AssetPattern = "win32-x64\.zip$"
  )
  $zip = Save-Installer $Url "$Name.zip"          # 同一个下载器：带进度、速度、剩余时间
  if (Test-Path $Destination) { Remove-Item $Destination -Recurse -Force }
  New-Item -ItemType Directory -Force $Destination | Out-Null
  Write-Host "    解压 $Name…" -ForegroundColor DarkGray
  Expand-Archive -Path $zip -DestinationPath $Destination -Force
  # 解开后通常是一层同名目录：把内容提上来，路径才稳定
  $inner = Get-ChildItem $Destination -Directory | Select-Object -First 1
  if ($inner -and -not (Get-ChildItem $Destination -File)) {
    Get-ChildItem $inner.FullName | Move-Item -Destination $Destination -Force
    Remove-Item $inner.FullName -Recurse -Force
  }
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
}

function Get-LatestAsset($repo, $pattern) {
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ "User-Agent" = "dsh-deploy" } -TimeoutSec 60
  return $rel.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
}

Write-Host "`n============================================" -ForegroundColor White
Write-Host " dsh-wechat-media 部署" -ForegroundColor White
Write-Host "============================================" -ForegroundColor White
if ($CheckOnly) { Write-Host " 模式：只体检（不改任何东西）" -ForegroundColor Yellow }
if ($Offline) { Write-Host " 模式：离线（不下载、不安装，只检测并把已有的东西接进 profile）" -ForegroundColor Yellow }
Info "工具目录 : $ToolsRoot"
Info "插件目录 : $InstallDir"
Info "目标 profile : $Profile"

$total = 11
$failures = 0

# ── -ResolveOnly：只解析地址 ──────────────────────────────────────────────────
if ($ResolveOnly) {
  Write-Host "`n解析官方安装包地址（不下载、不安装）" -ForegroundColor Cyan
  $anyFail = $false
  foreach ($spec in @(
      @{ Name = "Node.js"; Get = { Get-NodeMsiUrl } },
      @{ Name = "Python";  Get = { Get-PythonExeUrl } },
      @{ Name = "VS Code"; Get = { Get-VSCodeExeUrl } }
    )) {
    try {
      $found = & $spec.Get
      Ok "$($spec.Name) $($found.Version)"
      Info $found.Url
    } catch {
      Bad "$($spec.Name) 地址解析失败：$($_.Exception.Message)"
      $anyFail = $true
    }
  }
  Write-Host ""
  if ($anyFail) { Write-Host "有解析失败的项 —— 检查这台机器能不能访问 nodejs.org / python.org / update.code.visualstudio.com" -ForegroundColor Yellow }
  else { Write-Host "地址都拿到了。去掉 -ResolveOnly 就会真的下载并安装。" -ForegroundColor Green }
  exit ([int]$anyFail)
}

# ── 1. 前置 ───────────────────────────────────────────────────────────────────
Step 1 $total "前置条件"
if ($env:OS -ne "Windows_NT") { Bad "这个脚本只支持 Windows"; $failures++; }
else { Ok "Windows" }

# Node.js：DSH 的运行时和插件自己的工具（冒烟测试、probe-tools）都要它。缺了就装 LTS。
if (-not (Have "node")) {
  if ($CheckOnly -or $Offline) {
    Miss "没找到 node（Node.js 18+）$(if ($Offline) { '；离线模式不装' } else { '' })"
  } elseif (Install-Package -Id "OpenJS.NodeJS.LTS" -Probe "node" -Name "Node.js LTS" -Fallback { Install-NodeFallback }) {
    Ok "node $((Read-Version "node" @("--version")))"
  } else {
    Info "备选：https://nodejs.org/en/download  （选 LTS 的 .msi，装完重开一个终端）"
    $failures++
  }
} else {
  $nodeVersion = Read-Version "node" @("--version")
  Ok "node $nodeVersion"
}

if (Have "node") {
  # DSH 本体：只查 ~/.dsh 目录是不够的（那个目录可能是空的，或者从别的机器拷来的）。
  # 这里按实际安装布局找：PATH 里的 dsh.cmd、或 %LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe。
  $dshExe = $null
  foreach ($candidate in @(
      (Join-Path $env:LOCALAPPDATA "Programs\DeepSeek Harness\DeepSeek Harness.exe"),
      (Join-Path $env:LOCALAPPDATA "Programs\deepseek-harness\DeepSeek Harness.exe"),
      (Join-Path $env:PROGRAMFILES "DeepSeek Harness\DeepSeek Harness.exe")
    )) {
    if (Test-Path $candidate) { $dshExe = $candidate; break }
  }
  $dshCmd = Get-Command "dsh" -ErrorAction SilentlyContinue
  if ($dshExe) {
    Ok "DSH 已安装：$dshExe"
  } elseif ($dshCmd) {
    Ok "DSH 已安装（PATH 里的 dsh：$($dshCmd.Source)）"
  } else {
    Bad "没找到 DSH 本体 —— 插件是 DSH 的扩展，装不了也跑不起"
    Info "先装 DSH（DeepSeek Harness）并启动一次，生成 %USERPROFILE%\.dsh\，再来跑这个脚本"
    $failures++
  }
  $dsh = Join-Path $env:USERPROFILE ".dsh"
  if (Test-Path $dsh) {
    Ok "DSH 目录存在（$dsh）"
    if (-not (Test-Path (Join-Path $dsh "profiles"))) {
      Miss "还没有 profiles\ —— DSH 至少启动过一次才会有；插件要装进某个 profile"
    }
  } else {
    Miss "还没有 DSH 目录（$dsh）——先把 DSH 启动一次"
  }
  $profileDir = Join-Path $dsh "profiles\$Profile"
  if (Test-Path $profileDir) { Ok "profile 存在（$profileDir）" } else { Miss "profile 不存在（$profileDir）——会在部署时创建" }
}

# ── 2. Python 本体 ────────────────────────────────────────────────────────────
Step 2 $total "Python 本体"
$python = $null
foreach ($candidate in @("python", "python3", "py")) { if (Have $candidate) { $python = $candidate; break } }
if ($python) {
  Ok "python：$((Get-Command $python).Source) · $((& $python --version 2>&1))"
} elseif ($CheckOnly -or $Offline) {
  Miss "没找到 python（第 3 步需要它）"
  Info "去掉 -CheckOnly 后脚本会用 winget 装 Python（winget install Python.Python.3.12）"
} else {
  Miss "没找到 python，尝试安装"
  if (Install-Package -Id "Python.Python.3.12" -Probe "python" -Name "Python 3.12" -Fallback { Install-PythonFallback }) {
    $python = "python"
    Ok "python：$((& python --version 2>&1))"
  } else {
    Info "备选：从 python.org 下安装包，装时勾选 Add python.exe to PATH"
    $failures++
  }
}

# ── 3. Python 包 ───────────────────────────────────────────────────
Step 3 $total "Python 包（串口烧录依赖）"
if (-not $python) {
  Miss "没找到 python —— STC 烧录（stcgal）与 STM32 UART 引导（stm32loader）需要它"
  Info "第 2 步没装上 python，跳过这一节"
} else {
  # pip --user 会把 console script 放进 %APPDATA%\Python\PythonXY\Scripts，而那个目录**通常不在 PATH 上**
  # （pip 自己会打 WARNING 说这件事）。插件靠 which() 找 stcgal.exe，所以这个目录必须在 PATH 里，
  # 否则"装成功"和"用得上"之间差了整整一层。VM 上真实踩到过。
  $scriptDirs = @()
  $sysScripts = & $python -c "import sysconfig; print(sysconfig.get_path('scripts'))" 2>&1
  if ($sysScripts -and (Test-Path $sysScripts)) { $scriptDirs += $sysScripts }
  foreach ($root in @("$env:APPDATA\Python", "$env:LOCALAPPDATA\Programs\Python")) {
    Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $candidate = Join-Path $_.FullName "Scripts"
      if (Test-Path $candidate) { $scriptDirs += $candidate }
    }
  }
  $scriptDirs = $scriptDirs | Select-Object -Unique

  # "能用"= PATH 上有，或某个 python 的 Scripts 目录里有（插件 which() 会扫 PATH，所以稍后要把目录加进 PATH）
  $resolvable = {
    param($name)
    if (Have $name) { return $true }
    foreach ($dir in $scriptDirs) { if (Test-Path (Join-Path $dir "$name.exe")) { return $true } }
    return $false
  }

  $missing = @()
  if (((& $python -c "import serial; print('ok')" 2>&1) -notmatch "ok")) { $missing += "pyserial" }
  if (((& $python -c "import stm32loader; print('ok')" 2>&1) -notmatch "ok")) { $missing += "stm32loader" }
  if (-not (& $resolvable "stcgal")) { $missing += "stcgal" }

  if (-not $missing) {
    Ok "串口烧录依赖齐：pyserial / stcgal / stm32loader"
  } elseif ($CheckOnly -or $Offline) {
    Miss "缺：$($missing -join ', ')$(if ($Offline) { '；离线模式不装' } else { '' })"
  } else {
    Info "安装 $($missing -join ', ')（当前用户，不需要管理员）"
    $pipOut = & $python -m pip install --user --quiet @missing 2>&1
    if ($LASTEXITCODE -ne 0) { Info "pip 报错（最后几行）："; ($pipOut | Select-Object -Last 4) | ForEach-Object { Info ("" + $_) } }
    $still = @()
    if (($missing -contains "pyserial") -and (((& $python -c "import serial; print('ok')" 2>&1) -notmatch "ok"))) { $still += "pyserial" }
    if (($missing -contains "stm32loader") -and (((& $python -c "import stm32loader; print('ok')" 2>&1) -notmatch "ok"))) { $still += "stm32loader" }
    if ($still) { Bad "装完还缺：$($still -join ', ')"; $failures++ } else { Ok "pip 包装好：$($missing -join ', ')" }
  }

  # 把装到东西的 Scripts 目录加进用户 PATH —— 不管上面装没装，都检查一遍，
  # 因为可能是别的步骤/别的 python 环境放进去的。
  # 注意：体检模式（-CheckOnly）与离线模式不许改系统，只报告"本该加什么"。
  $needDirs = @()
  foreach ($dir in $scriptDirs) {
    $hasOurExe = @("stcgal.exe", "stm32loader.exe", "esptool.exe") | Where-Object { Test-Path (Join-Path $dir $_) }
    if (-not $hasOurExe) { continue }
    $userPathNow = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $userPathNow) { $userPathNow = "" }
    if ($userPathNow -notlike "*$dir*") { $needDirs += $dir }
  }
  if ($needDirs.Count -eq 0) {
    # 已经在 PATH 上，不用动
  } elseif ($CheckOnly) {
    Miss "这些目录不在 PATH 上（体检模式不改）：$($needDirs -join '; ')"
  } elseif ($Offline) {
    Miss "这些目录不在 PATH 上（离线模式不改）：$($needDirs -join '; ')"
  } else {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $userPath) { $userPath = "" }
    foreach ($dir in $needDirs) { $userPath = ($userPath.TrimEnd(";") + ";" + $dir).TrimStart(";") }
    [Environment]::SetEnvironmentVariable("Path", $userPath, "User")
    Refresh-Path
    Ok "已把 pip 脚本目录加进用户 PATH：$($needDirs -join '; ')"
  }

  # 加完 PATH 再确认一次，这次用和插件一样的方式（命令能不能找到）
  foreach ($name in @("stcgal", "stm32loader")) {
    if (Have $name) { Ok "$name：$((Get-Command $name).Source)" }
    elseif (-not $CheckOnly -and -not $Offline) { Miss "$name 仍不在 PATH（插件可能找不到，第 10 步会再确认一次）" }
  }
}

# ── 4. VS Code 与 Python 扩展 ─────────────────────────────────────────────────
Step 4 $total "VS Code 与 Python 扩展"
$code = Get-Command "code" -ErrorAction SilentlyContinue
if ($code) {
  Ok "VS Code：$((& code --version 2>&1 | Select-Object -First 1)) · $($code.Source)"
} elseif ($CheckOnly -or $Offline) {
  Miss "没装 VS Code"
} else {
  Miss "没装 VS Code，尝试安装"
  if (Install-Package -Id "Microsoft.VisualStudioCode" -Probe "code" -Name "VS Code" -Fallback { Install-VSCodeFallback }) {
    $code = Get-Command "code"
  } else {
    Info "备选：https://code.visualstudio.com/Download  （选 User Installer，装时勾选 Add to PATH）"
    $failures++
  }
}

if ($code) {
  # 扩展装没装用 `code --list-extensions` 看，而不是猜目录
  $extensions = (& code --list-extensions 2>&1) -join "`n"
  $wanted = @("ms-python.python")
  $missingExt = $wanted | Where-Object { $extensions -notmatch [regex]::Escape($_) }
  if (-not $missingExt) {
    Ok "扩展齐：$(($wanted -join ', '))"
  } elseif ($CheckOnly) {
    Miss "缺扩展：$($missingExt -join ', ')"
  } else {
    foreach ($ext in $missingExt) {
      Info "装扩展 $ext"
      & code --install-extension $ext --force 2>&1 | Select-String -Pattern "successfully|已成功|already" | ForEach-Object { Info $_.Line.Trim() }
    }
    $after = (& code --list-extensions 2>&1) -join "`n"
    $stillMissing = $missingExt | Where-Object { $after -notmatch [regex]::Escape($_) }
    if ($stillMissing) { Bad "扩展没装上：$($stillMissing -join ', ')"; $failures++ }
    else { Ok "扩展装好：$($missingExt -join ', ')" }
  }
  Info "插件自带的 vsix 在第 9 步装（那一步不依赖扩展市场）"
}

# ── 5. 串口驱动（CH340 / CH343 / CP210x）────────────────────────────────────
Step 5 $total "串口驱动（CH340）"
if ($SkipCh340) {
  Miss "按 -SkipCh340 跳过"
} else {
  # CH340 的驱动来源只有两个靠谱的：Windows Update（插上设备自动装），或 WCH 官网的安装包。
  # WCH 的下载页是 JS 单页，没有稳定直链（三个候选 URL 都只返回 text/html），
  # 所以脚本不替你从第三方镜像下驱动 —— 那玩意儿能伪造签名。这里做的是：
  #   有 → 报告（并说明来源）
  #   没有但插着设备 → 告诉你去重插/联网，Windows Update 会装
  #   你手上有安装包 → -Ch340Installer 指给它，脚本静默装
  $driverDump = (pnputil /enum-drivers 2>&1 | Out-String)
  $wchBlocks = ($driverDump -split "(`r?`n){2,}") | Where-Object { $_ -match '(?i)(ch34[0-9a-z]*ser\.inf|provider name:\s*wch)' }
  $devices = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '(?i)CH34[0-9]|USB-SERIAL CH34|CP210' }
  $deviceNames = @($devices | ForEach-Object { $_.Name })

  if ($wchBlocks) {
    $infNames = [regex]::Matches(($wchBlocks -join "`n"), '(?im)^Original Name:\s*(\S+)') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
    $signed = [bool](($wchBlocks -join "`n") -match 'Microsoft Windows Hardware Compatibility Publisher')
    Ok "CH34x 驱动已装：$($infNames -join ', ')$(if ($signed) { '（签名者 Microsoft，来自 Windows Update）' })"
  } elseif ($CheckOnly -or $Offline) {
    Miss "没装 CH340 驱动$(if ($Offline) { '（离线模式不装）' } else { '' })"
    Info "插上 CH340 设备并联网，Windows 10/11 会自动从 Windows Update 装（本机就是这么来的）"
  } elseif ($Ch340Installer) {
    if (-not (Test-Path $Ch340Installer)) { Bad "找不到安装包：$Ch340Installer"; $failures++ }
    elseif ($Ch340Installer -match '\.inf$') {
      Info "用 pnputil 装 INF：$Ch340Installer"
      $out = pnputil /add-driver $Ch340Installer /install 2>&1 | Out-String
      if ($LASTEXITCODE -eq 0) { Ok "INF 已提交" } else { Bad "pnputil 失败"; ($out -split "`n" | Select-Object -Last 4) | ForEach-Object { Info $_.Trim() }; $failures++ }
    } else {
      Info "静默运行安装包：$Ch340Installer /S"
      $proc = Start-Process $Ch340Installer -ArgumentList @("/S") -Wait -PassThru
      if ($proc.ExitCode -eq 0) { Ok "安装包退出码 0" } else { Miss "安装包退出码 $($proc.ExitCode)（有的版本不支持 /S，需要图形界面点一下）" }
    }
  } else {
    Miss "没装 CH340 驱动"
    Info "最省事的办法：插上设备并联网，Windows Update 会自动装（用 -Ch340Installer 也能指定本地安装包）"
    Info "官方下载页：https://www.wch.cn/downloads/CH341SER_EXE.html"
  }

  if ($deviceNames.Count -gt 0) {
    Ok "已识别串口设备：$($deviceNames -join ' / ')"
    $ports = [System.IO.Ports.SerialPort]::GetPortNames()
    if ($ports) { Info "当前串口：$($ports -join ', ')" }
  } else {
    Info "现在没插着 CH34x / CP210x 设备（不影响安装，插上就能用）"
  }
}

# ── 6. Arduino ────────────────────────────────────────────────────────────────
Step 6 $total "Arduino（arduino-cli + 核心）"
if ($SkipArduino) {
  Miss "按 -SkipArduino 跳过"
} else {
  $arduinoCli = Get-ChildItem $ToolsRoot -Filter "arduino-cli.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($arduinoCli) {
    Ok "arduino-cli：$($arduinoCli.FullName)"
    $cli = $arduinoCli.FullName
  } elseif ($CheckOnly -or $Offline) {
    Miss "没装 arduino-cli"
    $cli = $null
  } else {
    try {
      $asset = Get-LatestAsset "arduino/arduino-cli" "Windows_64bit\.zip$"
      $dest = Join-Path $ToolsRoot "arduino-cli"
      Install-PortableZip -Name "arduino-cli" -Url $asset.browser_download_url -Destination $dest
      $cli = (Get-ChildItem $dest -Filter "arduino-cli.exe" -Recurse | Select-Object -First 1).FullName
      Ok "arduino-cli 装到 $dest（$($asset.name)）"
    } catch { Bad "arduino-cli 下载失败：$($_.Exception.Message)"; $failures++; $cli = $null }
  }

  if ($cli) {
    $cores = (& $cli core list 2>&1) -join "`n"
    $needCores = @()
    if ($cores -notmatch "arduino:avr") { $needCores += "arduino:avr" }
    if ($WithEsp32Core -and $cores -notmatch "esp32:esp32") { $needCores += "esp32:esp32" }
    if (-not $needCores) {
      Ok "核心齐：$((($cores -split "`n" | Select-String -Pattern '^\S+:\S+\s').Line | ForEach-Object { ($_ -split '\s+')[0] }) -join ', ')"
    } elseif ($CheckOnly -or $Offline) {
      Miss "缺核心：$($needCores -join ', ')（约 $(if ($needCores -contains 'esp32:esp32') { '1.2 GB' } else { '60 MB' }))"
    } else {
      Info "安装核心 $($needCores -join ', ')（要下载，几分钟）"
      & $cli core update-index | Out-Null
      foreach ($core in $needCores) {
        Write-Host "    装 $core…" -ForegroundColor DarkGray
        & $cli core install $core | Out-Null
      }
      $after = (& $cli core list 2>&1) -join "`n"
      $missingCore = $needCores | Where-Object { $after -notmatch [regex]::Escape($_) }
      if ($missingCore) { Bad "核心没装上：$($missingCore -join ', ')"; $failures++ } else { Ok "核心装好：$($needCores -join ', ')" }
    }
  }
}

# ── 7. ARM 工具链（GCC / CMake / Ninja / OpenOCD）─────────────────────────────
Step 7 $total "ARM 工具链（arm-none-eabi-gcc / cmake / ninja / openocd）"
if ($SkipToolchain) {
  Miss "按 -SkipToolchain 跳过（去掉这个开关会装 arm-none-eabi-gcc 320 MB + cmake / ninja / openocd）"
} else {
  $toolchain = @(
    @{ Name = "armgcc";  Command = "arm-none-eabi-gcc"; Version = "--version"; Repo = "xpack-dev-tools/arm-none-eabi-gcc-xpack"; Sub = "bin" },
    @{ Name = "cmake";   Command = "cmake";             Version = "--version"; Repo = "xpack-dev-tools/cmake-xpack";              Sub = "bin" },
    @{ Name = "ninja";   Command = "ninja";             Version = "--version"; Repo = "xpack-dev-tools/ninja-build-xpack";        Sub = "bin" },
    @{ Name = "openocd"; Command = "openocd";           Version = "--version"; Repo = "xpack-dev-tools/openocd-xpack";            Sub = "bin" }
  )
  foreach ($tool in $toolchain) {
    $present = Get-ChildItem $ToolsRoot -Filter "$($tool.Command).exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($present) {
      $version = Read-Version $present.FullName @($tool.Version)
      Ok "$($tool.Command)：$($version -replace '\s+', ' ')"
      continue
    }
    if ($CheckOnly -or $Offline) { Miss "没装 $($tool.Command)"; continue }
    try {
      $asset = Get-LatestAsset $tool.Repo "win32-x64\.zip$"
      $dest = Join-Path $ToolsRoot $tool.Name
      Install-PortableZip -Name $tool.Name -Url $asset.browser_download_url -Destination $dest
      $exe = Get-ChildItem $dest -Filter "$($tool.Command).exe" -Recurse | Select-Object -First 1
      if ($exe) { Ok "$($tool.Command) 装到 $dest（$($asset.name)）" } else { Bad "$($tool.Name) 解压后没找到 $($tool.Command).exe"; $failures++ }
    } catch { Bad "$($tool.Command) 下载失败：$($_.Exception.Message)"; $failures++ }
  }

}
# ── 8. Keil 与 ESP-IDF（只检测，不安装）──────────────────────────────────────
Step 8 $total "Keil 与 ESP-IDF（只检测；这两个要你自己装）"
$uv4 = @(
  "$env:LOCALAPPDATA\Keil_v5\UV4\UV4.exe",
  "D:\Keil_v5\UV4\UV4.exe",
  "C:\Keil_v5\UV4\UV4.exe",
  "C:\Program Files\Keil_v5\UV4\UV4.exe",
  "C:\Program Files (x86)\Keil_v5\UV4\UV4.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($uv4) {
  $root = Split-Path (Split-Path $uv4 -Parent) -Parent
  $families = @()
  if (Test-Path (Join-Path $root "C51\BIN\c51.exe")) { $families += "C51" }
  if ((Test-Path (Join-Path $root "ARM\ARMCLANG\bin\armclang.exe")) -or (Test-Path (Join-Path $root "ARM\ARMCC\bin\armcc.exe"))) { $families += "ARM" }
  Ok "Keil UV4：$uv4（可编：$($families -join ' + ')）"
  Info "一台机器可以有两份（C51 一份、MDK 一份），插件会按工程器件家族自己选"
} else {
  Miss "没找到 Keil（不装也能用：Keil 工程之外的三种照常）"
  Info "要装的话：https://www.keil.com/demo/eval/arm.htm  → 见 docs/keil-arm-install.md（含直链与 SHA256）"
}

$idf = @("$env:IDF_PATH", "D:\Espressif\frameworks\esp-idf-v4.4.8", "C:\Espressif\frameworks") |
  Where-Object { $_ -and (Test-Path (Join-Path $_ "export.ps1")) } | Select-Object -First 1
if ($idf) { Ok "ESP-IDF：$idf" }
else {
  if (-not $env:IDF_PATH) { Miss "没找到 ESP-IDF（不影响其它三种工程）" } else { Bad "IDF_PATH 指向 $env:IDF_PATH，但里面没有 export.ps1"; $failures++ }
  Info "装法：Espressif 的 IDF 安装器，或 git clone + install.bat"
}

# ── 9. 插件部署 ───────────────────────────────────────────────────────────────
Step 9 $total "插件部署（源码 → profile）"
if ($SkipTools -eq $false -and $CheckOnly) { Info "环境检查模式下不改插件；去掉 -CheckOnly 才会动" }

# 源码位置：显式 -LocalPath > 已存在的 profile 联接 > 默认安装目录（不存在就 clone 一个）
$profileLink = Join-Path (Join-Path (Join-Path $env:USERPROFILE ".dsh\profiles\$Profile") "node_modules") "dsh-wechat-media"
$checkout = if ($LocalPath) { $LocalPath } elseif ((Test-Path $profileLink) -and (Get-Item $profileLink -Force).Target) { (Get-Item $profileLink -Force).Target } else { $InstallDir }
if ($LocalPath) { Ok "用本地检出：$LocalPath" }
elseif ($checkout -ne $InstallDir) { Ok "沿用 profile 里已联接的源码：$checkout" }

if (-not (Test-Path (Join-Path $checkout "package.json"))) {
  if ($CheckOnly) {
    Miss "插件源码不在 $checkout"
  } elseif ($LocalPath) {
    Bad "指定的 -LocalPath 里没有 package.json：$LocalPath"
    $failures++
  } elseif ($Offline) {
    Bad "插件源码不在这里，而离线模式不 clone：$checkout"
    Info "把仓库拷进这台机器，然后用 -LocalPath <路径> 指过去"
    $failures++
  } elseif (Have "git") {
    Info "git clone $Source → $InstallDir"
    & git clone --depth 1 $Source $InstallDir 2>&1 | Out-Null
    if (Test-Path (Join-Path $InstallDir "package.json")) { Ok "已检出到 $InstallDir" } else { Bad "clone 失败"; $failures++ }
  } else {
    Info "没有 git，改用 zip 下载"
    try {
      $zip = Join-Path $env:TEMP "dsh-wechat-media.zip"
      $null = Save-Installer (($Source -replace '\.git$', '') + '/archive/refs/heads/main.zip') "dsh-wechat-media.zip"; $zip = Join-Path $env:TEMP "dsh-wechat-media.zip"
      Expand-Archive $zip -DestinationPath $env:TEMP -Force
      $inner = Get-ChildItem $env:TEMP -Directory -Filter "dsh-wechat-media-*" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
      Move-Item $inner.FullName $InstallDir -Force
      Remove-Item $zip -Force
      if (Test-Path (Join-Path $InstallDir "package.json")) { Ok "已下载到 $InstallDir" } else { Bad "zip 解压后没有 package.json"; $failures++ }
    } catch { Bad "下载失败：$($_.Exception.Message)"; $failures++ }
  }
} else {
  Ok "插件源码在 $checkout"
  if ((Have "git") -and (Test-Path (Join-Path $checkout ".git")) -and -not $LocalPath -and -not $CheckOnly -and -not $Offline) {
    Info "更新源码（git pull --ff-only）"
    & git -C $checkout pull --ff-only 2>&1 | Out-Null
  }
}

$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
$nodeModules = Join-Path $profileDir "node_modules"
$linkPath = Join-Path $nodeModules "dsh-wechat-media"
if ($CheckOnly) {
  if (Test-Path (Join-Path $profileDir "package.json")) { Ok "profile 配置在（$profileDir）" } else { Miss "profile 配置还没有" }
  if (Test-Path $linkPath) { Ok "已联接：$((Get-Item $linkPath -Force).Target)" } else { Miss "还没联接到 profile" }
} else {
  New-Item -ItemType Directory -Force $nodeModules | Out-Null
  # 只有"不存在"或"是联接"时才重建；指向别处的真实目录要人来看
  if (Test-Path $linkPath) {
    $existing = Get-Item $linkPath -Force
    if ($existing.LinkType) {
      if ($existing.Target -ne $checkout) { Remove-Item $linkPath -Force; Ok "旧联接指向 $($existing.Target)，已替换" }
    } else {
      Bad "$linkPath 是真实目录，不是联接 —— 不清自删，请自己确认后移走"
      $failures++
    }
  }
  if (-not (Test-Path $linkPath)) {
    New-Item -ItemType Junction -Path $linkPath -Target $checkout | Out-Null
    Ok "已联接：$linkPath → $checkout"
  }

  # package.json：备份 → 合并依赖与 bundles → 写回
  $profilePkg = Join-Path $profileDir "package.json"
  if (Test-Path $profilePkg) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Copy-Item $profilePkg "$profilePkg.bak-$stamp" -Force
    $json = Get-Content $profilePkg -Raw -Encoding utf8 | ConvertFrom-Json
  } else {
    # 全新 profile：bundles 里必须有 DSH 自己的基础层，否则 DSH 起不来（只有我们的插件是不够的）
    $json = [pscustomobject]@{
      name         = "dsh-profile-$Profile"
      private      = $true
      dependencies = [pscustomobject]@{}
      dsh          = [pscustomobject]@{ profile = [pscustomobject]@{ bundles = @("@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app") } }
    }
  }
  if (-not $json.dependencies) { $json | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force }
  $wantLink = "link:" + ($checkout -replace '\\', '/')
  $json.dependencies | Add-Member -NotePropertyName "dsh-wechat-media" -NotePropertyValue $wantLink -Force
  $bundles = @()
  if ($json.dsh -and $json.dsh.profile -and $json.dsh.profile.bundles) { $bundles = @($json.dsh.profile.bundles) }
  if ($bundles -notcontains "dsh-wechat-media") { $bundles += "dsh-wechat-media" }
  if (-not $json.dsh) { $json | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
  if (-not $json.dsh.profile) { $json.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }
  $json.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
  New-Item -ItemType Directory -Force $profileDir | Out-Null
  $json | ConvertTo-Json -Depth 8 | Set-Content $profilePkg -Encoding utf8
  Ok "profile 已配置：$profilePkg（bundles 含 dsh-wechat-media）"
}

# ── 10. 插件自带的 VS Code 扩展（vsix）────────────────────────────────────────
Step 10 $total "插件自带的 VS Code 扩展"
if (-not $code) {
  Miss "没有 VS Code，跳过 vsix"
} else {
  # 版本号从文件名末尾取 x.y.z。早先用 `-replace '^.*?-'` 切到第一个连字符，得到的是
  # "wechat-media-vscode-0.6.1"，[version] 转换失败，排序退化成任意顺序 → 选到了 0.5.0。
  $vsix = Get-ChildItem $checkout -Filter "dsh-wechat-media-vscode-*.vsix" -ErrorAction SilentlyContinue |
    ForEach-Object {
      $m = [regex]::Match($_.BaseName, '-(\d+\.\d+\.\d+)$')
      [pscustomobject]@{ File = $_; Version = if ($m.Success) { [version]$m.Groups[1].Value } else { [version]"0.0.0" } }
    } |
    Sort-Object Version |
    Select-Object -Last 1 |
    ForEach-Object { $_.File }
  if (-not $vsix) {
    Miss "仓库里没有 vsix（插件会在发布时打包，这里只装现成的）"
  } else {
    # 身份从 vsix 里读，不从文件名猜：vsix 是个 zip，extension/package.json 里有 publisher/name/version
    $identity = $null
    try {
      Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
      $zip = [IO.Compression.ZipFile]::OpenRead($vsix.FullName)
      try {
        # 老 vsix 里条目名可能是反斜杠（Windows 的 ZipFile.CreateFromDirectory 就这么写），两种都要认
        $entry = $zip.Entries | Where-Object { $_.FullName -match '^extension[\\/]package\.json$' } | Select-Object -First 1
        if ($entry) {
          $reader = New-Object IO.StreamReader($entry.Open())
          $meta = $reader.ReadToEnd() | ConvertFrom-Json
          $reader.Close()
          $identity = "$($meta.publisher).$($meta.name)@$($meta.version)"
        }
      } finally { $zip.Dispose() }
    } catch { Info "读 vsix 里的 package.json 失败：$($_.Exception.Message)" }

    if (-not $identity) {
      Miss "vsix 结构看不懂（缺 extension/package.json），跳过：$($vsix.Name)"
    } else {
      $installed = (& code --list-extensions --show-versions 2>&1) -join "`n"
      if ($installed -match [regex]::Escape($identity)) {
        Ok "已装：$identity（$($vsix.Name)）"
      } elseif ($CheckOnly) {
        Miss "没装：$identity（仓库里有 $($vsix.Name)）"
      } else {
        Info "装 $($vsix.Name)（$identity）"
        & code --install-extension $vsix.FullName --force 2>&1 |
          Select-String -Pattern "successfully|已成功|already" | ForEach-Object { Info $_.Line.Trim() }
        $after = (& code --list-extensions --show-versions 2>&1) -join "`n"
        if ($after -match [regex]::Escape($identity)) { Ok "装好：$identity" }
        else { Bad "装完没在列表里：$identity"; $failures++ }
      }
    }
  }
}

# ── 11. 自检（让插件自己回答，不靠猜）────────────────────────────────────────
Step 11 $total "自检"
if ($CheckOnly) {
  Info "体检模式不跑测试；去掉 -CheckOnly 才会验证"
} elseif (-not (Test-Path (Join-Path $checkout "scripts\probe-tools.mjs"))) {
  Miss "插件里没有 scripts\probe-tools.mjs，跳过自检"
} else {
  # scripts\probe-tools.mjs 调的是插件自己的 which() 与 serialSupport()，所以这里看到的就是它运行时看到的。
  Info "用插件自己的解析器确认工具链"
  Push-Location $checkout
  $probeLines = & node "scripts\probe-tools.mjs" 2>&1
  Pop-Location
  $missed = @()
  foreach ($line in $probeLines) {
    if ($line -match "^([^|]+)\|(ok|miss)\|(.*)$") {
      $name = $Matches[1]; $state = $Matches[2]; $where = $Matches[3]
      if ($state -eq "ok") { Ok "$name：$where" } else { $missed += $name; Miss "$name：插件找不到" }
    }
  }
  if ($missed.Count -gt 0) {
    Info "这几项只影响对应功能（没有 stcgal 就烧不了 STC），不影响插件启动和聊天"
  }

  # 光有 --version 不算"能用"：用仓库里的 STM32 模板真编一个固件出来。
  # 这条是我自己吃亏换来的 —— 之前装完工具链、版本号都对，结果第一次真编译才发现问题是别的。
  $template = Join-Path $checkout "scripts\stm32-template"
  $gcc = Get-ChildItem $ToolsRoot -Filter "arm-none-eabi-gcc.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  $cmake = Get-ChildItem $ToolsRoot -Filter "cmake.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ((Test-Path $template) -and $gcc -and $cmake) {
    Info "用 scripts\stm32-template 真编一个固件（这是'工具链能用'的证据）"
    $buildDir = Join-Path $env:TEMP ("dsh-toolchain-check-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
    # 工具链得在这个子进程的 PATH 上：把它们各自的 bin 目录拼进来
    $before = $env:PATH
    foreach ($tool in @($gcc, $cmake)) {
      $bin = Split-Path $tool.FullName -Parent
      if ($env:PATH -notlike "*$bin*") { $env:PATH = "$bin;$env:PATH" }
    }
    try {
      $configure = & $cmake.FullName -S $template -B $buildDir -G Ninja -DCMAKE_TOOLCHAIN_FILE="$template\cmake\arm-none-eabi.cmake" 2>&1
      if ($LASTEXITCODE -eq 0) {
        $build = & $cmake.FullName --build $buildDir 2>&1
        $sizeLine = ($build | Select-String -Pattern '^\s*\d+\s+\d+\s+\d+\s+\d+\s+\w+\s+.*stm32_template\.elf' | Select-Object -Last 1)
        $elf = Join-Path $buildDir "stm32_template.elf"
        if ($LASTEXITCODE -eq 0 -and (Test-Path $elf)) {
          # 只报 text/data/bss 三个数，别把临时路径塞进结果里（那对读的人没用）
          $summary = ""
          if ($sizeLine) {
            $nums = [regex]::Matches($sizeLine.Line.Trim(), '^\s*(\d+)\s+(\d+)\s+(\d+)')
            if ($nums.Count -gt 0) {
              $g = $nums[0].Groups
              $summary = "（text $($g[1].Value) · data $($g[2].Value) · bss $($g[3].Value)）"
            }
          }
          Ok "工具链真能编：$(Format-Bytes (Get-Item $elf).Length) 的 .elf 已生成$summary"
        } else {
          Bad "工具链在，但模板编不过（最后几行）"
          ($build | Select-Object -Last 6) | ForEach-Object { Info $_ }
        }
      } else {
        Bad "cmake 配置失败"
        ($configure | Select-Object -Last 6) | ForEach-Object { Info $_ }
      }
    } finally {
      $env:PATH = $before
      Remove-Item $buildDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  } elseif (-not $SkipToolchain -and -not $CheckOnly) {
    Miss "没有 arm-none-eabi-gcc / cmake，跳过'真编一个'的检查"
  }

  if (-not $NoSelfTest -and (Test-Path (Join-Path $checkout "test\smoke.test.mjs"))) {
    Info "跑冒烟测试（不需要硬件、不需要网络）"
    Push-Location $checkout
    $smoke = & node "test\smoke.test.mjs" 2>&1
    $smokeExit = $LASTEXITCODE
    Pop-Location
    if ($smokeExit -eq 0) {
      Ok "冒烟测试通过：插件能加载，工具与路由都注册了"
    } else {
      Bad "冒烟测试失败"
      ($smoke | Select-Object -Last 12) | ForEach-Object { Info $_ }
      $failures++
    }
  }
}
# ── 汇总 ──────────────────────────────────────────────────────────────────────
Write-Host "`n============================================" -ForegroundColor White
if ($failures -eq 0) {
  Write-Host " 完成" -ForegroundColor Green
} else {
  Write-Host " 完成，但有 $failures 项需要注意（上面标 ✖ 的）" -ForegroundColor Yellow
}
Write-Host "============================================" -ForegroundColor White
$script:Report | Format-Table -AutoSize | Out-String | Write-Host

if ($CheckOnly) {
  Write-Host "这是体检模式。去掉 -CheckOnly 就会按上面的清单动手。" -ForegroundColor Yellow
} else {
  Write-Host @"
下一步：
  1. 重启 DSH（插件在启动时加载，不重启看不到新工具）
  2. 启动后确认：GET http://127.0.0.1:19387/dsh-wechat-media/state 应返回 version 字段
  3. 危险能力默认关，用到了再开：/serial on · /keil on · /ssh on · /task command on
"@ -ForegroundColor Cyan
}
exit $failures
