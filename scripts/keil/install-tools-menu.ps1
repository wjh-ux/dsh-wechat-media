<#
.SYNOPSIS
  在 Keil uVision5 的 Tools 菜单里加上「编译 (DSH)」，让 uVision 里点一下就用同一套代码编译，
  并可选再加一条「编译 + 下载」。

.DESCRIPTION
  uVision 把自定义 Tools 菜单存在注册表 HKCU\Software\Keil\<产品键>\ToolM 下，每个条目五个值：

      Mtx<n>  菜单里显示的名字
      Mex<n>  命令（这里永远是 cmd.exe）
      Mag<n>  参数（这里带上 #P，uVision 自己替换成当前工程路径）
      Mid<n>  起始目录
      Mfg<n>  选项位：0x100 都不选 · 0x300 Prompt for Arguments · 0x500 Run Minimized · 0x900 Run Independent

  这个脚本按上面的契约写入，写之前先用 reg.exe 把 ToolM 整个导出成 .reg 备份，删回去只要双击那个文件。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install-tools-menu.ps1
  powershell -ExecutionPolicy Bypass -File install-tools-menu.ps1 -WithFlash
  powershell -ExecutionPolicy Bypass -File install-tools-menu.ps1 -Remove
#>
[CmdletBinding()]
param(
  [string] $PluginRoot = "",
  [switch] $WithFlash,
  [switch] $Remove
)

$ErrorActionPreference = "Stop"

if (-not $PluginRoot) {
  # scripts\keil\ → 插件根目录
  $PluginRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}
$cmd = (Join-Path $PluginRoot "scripts\keil\dsh-keil.cmd")
if (-not (Test-Path $cmd)) {
  throw "找不到 $cmd —— -PluginRoot 指错了？"
}

# 产品键：中文 Windows 上 uVision 用 ANSI 写 "µVision5"，落盘会变成「礦ision5」；英文机器上是 µVision5。
# 两个都试，优先选已经存在的那个 —— 新造一个错的键，Keil 是看不见的。
$candidates = @("礦ision5", "µVision5", "μVision5")
$base = $null
foreach ($name in $candidates) {
  $path = "HKCU:\Software\Keil\$name"
  if (Test-Path $path) {
    $base = $path
    if (Test-Path (Join-Path $path "ToolM")) { $toolm = Join-Path $path "ToolM"; break }
  }
}
if (-not $base) {
  # 一台从没跑过 uVision 的机器：建默认键，并说明为什么。
  $base = "HKCU:\Software\Keil\µVision5"
  Write-Host "没有找到 Keil 的产品键，创建 $base（先运行一次 uVision 再回来也行）"
  New-Item -Path $base -Force | Out-Null
}
$toolm = Join-Path $base "ToolM"
if (-not (Test-Path $toolm)) { New-Item -Path $toolm -Force | Out-Null }
Write-Host "ToolM：$toolm"

function Get-Entries {
  $key = Get-Item $toolm
  $names = $key.GetValueNames()
  $indexes = @()
  foreach ($valueName in $names) {
    if ($valueName -match '^Mtx(\d+)$') { $indexes += [int]$Matches[1] }
  }
  $rows = @()
  foreach ($i in ($indexes | Sort-Object)) {
    $rows += [pscustomobject]@{
      Index = $i
      Name  = [string]$key.GetValue("Mtx$i", "")
      Cmd   = [string]$key.GetValue("Mex$i", "")
      Args  = [string]$key.GetValue("Mag$i", "")
    }
  }
  return $rows
}

$existing = Get-Entries
$wanted = @(
  [pscustomobject]@{ Name = "Keil: 编译 (DSH)"; Args = "/c `"$cmd`" `"#P`"" }
)
if ($WithFlash) {
  $wanted += [pscustomobject]@{ Name = "Keil: 编译+下载 (DSH)"; Args = "/c `"$cmd`" `"#P`" flash" }
}

if ($Remove) {
  $removed = 0
  foreach ($row in $existing) {
    if ($row.Name -like "*DSH*") {
      foreach ($prefix in @("Mtx", "Mex", "Mag", "Mid", "Mfg")) {
        Remove-ItemProperty -Path $toolm -Name "$prefix$($row.Index)" -ErrorAction SilentlyContinue
      }
      $removed++
    }
  }
  Write-Host "已删除 $removed 条 DSH 菜单项（注册表未备份的那部分不需要还原，因为只删了这些值）"
  return
}

# 备份：整个 ToolM 导成一个 .reg，出问题双击即可还原。
$backupDir = Join-Path $env:USERPROFILE ".dsh\dsh-wechat-media"
New-Item -ItemType Directory -Force $backupDir | Out-Null
$backup = Join-Path $backupDir ("keil-toolm-{0}.reg" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
$regPath = "HKEY_CURRENT_USER\Software\Keil\$((Split-Path $base -Leaf))\ToolM"
& reg.exe export $regPath $backup /y | Out-Null
if (Test-Path $backup) { Write-Host "已备份注册表：$backup" } else { Write-Warning "备份失败（继续，但请记住你改了什么）" }

$cmdExe = Join-Path $env:SystemRoot "System32\cmd.exe"
foreach ($item in $wanted) {
  $already = $existing | Where-Object { $_.Name -eq $item.Name }
  if ($already) {
    # 幂等：名字相同就更新参数，不叠加条目。
    Set-ItemProperty -Path $toolm -Name "Mex$($already.Index)" -Value $cmdExe
    Set-ItemProperty -Path $toolm -Name "Mag$($already.Index)" -Value $item.Args
    Set-ItemProperty -Path $toolm -Name "Mid$($already.Index)" -Value ""
    Set-ItemProperty -Path $toolm -Name "Mfg$($already.Index)" -Value 0x00000900 -Type DWord
    Write-Host "更新：$($item.Name)（索引 $($already.Index)）"
    continue
  }
  $used = (Get-Entries).Index
  $index = 0
  while ($used -contains $index) { $index++ }
  Set-ItemProperty -Path $toolm -Name "Mtx$index" -Value $item.Name
  Set-ItemProperty -Path $toolm -Name "Mex$index" -Value $cmdExe
  Set-ItemProperty -Path $toolm -Name "Mag$index" -Value $item.Args
  Set-ItemProperty -Path $toolm -Name "Mid$index" -Value ""
  # 0x900 = Run Independent：uVision 不等编译结束，窗口自己弹出来显示结果，IDE 不卡。
  Set-ItemProperty -Path $toolm -Name "Mfg$index" -Value 0x00000900 -Type DWord
  Write-Host "新增：$($item.Name)（索引 $index）"
}

Write-Host ""
Write-Host "完成。重启 uVision（或直接打开任意工程）后，Tools 菜单里会出现："
foreach ($item in $wanted) { Write-Host ("  · {0}" -f $item.Name) }
Write-Host ""
Write-Host "在 uVision 里对任意打开的工程点它，就会编译当前工程；#P 由 uVision 自己替换成工程路径。"
