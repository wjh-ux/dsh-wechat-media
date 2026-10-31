# 修复 DSH profile 的 package.json（以及可能的其它 JSON）
#
# 为什么需要它：Windows PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写 UTF-8 BOM，
# 而 DSH 用 JSON.parse 读这些文件 —— 于是启动时报
#   Unexpected token '﻿', "﻿{ "n"... is not valid JSON
# 早期版本的 deploy-windows.ps1 就是这样把 DSH 写崩的（v1.24.11 起不会了）。
#
# 用法（DSH 不需要能启动）：
#   .\repair-profile-json.ps1                      # 修 desktop
#   .\repair-profile-json.ps1 -Profile staging
#   .\repair-profile-json.ps1 -CheckOnly           # 只看，不改
#   .\repair-profile-json.ps1 -RestoreBackup       # 用脚本留下的 .bak-* 覆盖（插件入口会丢）
#
# 它做的事：
#   1. 报告每个 JSON 的头三字节（BOM）、是否可解析
#   2. 去掉 BOM，重新校验
#   3. 仍不可解析时，列出可用的 .bak-* 备份；-RestoreBackup 时才恢复
#   4. 写回一律用不带 BOM 的 UTF-8

[CmdletBinding()]
param(
  [string]$Profile = "desktop",
  [string]$DshHome = $(Join-Path $env:USERPROFILE ".dsh"),
  [switch]$All,          # 扫整个 .dsh（除 node_modules / browser-profile / dsh-runtimes）
  [switch]$CheckOnly,
  [switch]$RestoreBackup
)

$ErrorActionPreference = "Stop"
$profileDir = Join-Path (Join-Path $DshHome "profiles") $Profile

function Test-JsonText([string]$text) {
  try { $null = $text | ConvertFrom-Json; return @{ Ok = $true; Message = "" } }
  catch { return @{ Ok = $false; Message = $_.Exception.Message } }
}

function Get-Head([string]$path) {
  $bytes = [IO.File]::ReadAllBytes($path)
  if ($bytes.Length -eq 0) { return "空文件" }
  $n = [Math]::Min(3, $bytes.Length)
  return (($bytes[0..($n - 1)]) -join ',')
}

if (-not $All -and -not (Test-Path $profileDir)) {
  Write-Host "没有这个 profile：$profileDir" -ForegroundColor Red
  Write-Host "现有的 profile：" -ForegroundColor Yellow
  Get-ChildItem (Join-Path $DshHome "profiles") -Directory -ErrorAction SilentlyContinue | ForEach-Object { "  $($_.Name)" }
  exit 2
}

Write-Host "profile：$profileDir" -ForegroundColor Cyan
if ($All) {
  Write-Host "扫描整个 $DshHome（跳过 node_modules / browser-profile / dsh-runtimes）" -ForegroundColor Cyan
  $files = @(Get-ChildItem $DshHome -Recurse -Include *.json -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch 'node_modules|browser-profile|dsh-runtimes' -and $_.Name -notlike "*.bak-*" })
} else {
  $files = @(Get-ChildItem $profileDir -Filter *.json -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike "*.bak-*" })
}

if (-not $files) { Write-Host "这个 profile 下没有 .json 文件" -ForegroundColor Yellow; exit 0 }

$problems = 0
foreach ($file in $files) {
  $head = Get-Head $file.FullName
  $bytes = [IO.File]::ReadAllBytes($file.FullName)
  $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  $text = [IO.File]::ReadAllText($file.FullName)
  if ($text.Length -gt 0 -and [int][char]$text[0] -eq 0xFEFF) { $text = $text.Substring(1) }
  $result = Test-JsonText $text

  $state = if ($result.Ok) { "可解析" } else { "不可解析" }
  $label = if ($All) { $file.FullName.Replace($DshHome, "~") } else { $file.Name }
  Write-Host ("  {0,-52} 头3字节={1,-12} BOM={2,-5} {3}" -f $label, $head, $hasBom, $state) -ForegroundColor $(if ($result.Ok -and -not $hasBom) { "Green" } else { "Yellow" })

  if (-not $result.Ok) {
    $problems++
    Write-Host "     解析错误：$($result.Message)" -ForegroundColor Red
    $baks = Get-ChildItem $profileDir -Filter "$($file.Name).bak-*" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
    if ($baks) {
      Write-Host "     可用备份（新→旧）：" -ForegroundColor Yellow
      $baks | Select-Object -First 3 | ForEach-Object { Write-Host "       $($_.Name)  $($_.Length) 字节  $($_.LastWriteTime)" }
    } else {
      Write-Host "     没有 .bak-* 备份" -ForegroundColor Yellow
    }
  }

  if ($CheckOnly) { continue }

  if ($hasBom) {
    [IO.File]::WriteAllText($file.FullName, $text, [Text.UTF8Encoding]::new($false))
    $newHead = Get-Head $file.FullName
    if ($result.Ok) { Write-Host "     已去掉 BOM（头3字节现在是 $newHead）" -ForegroundColor Green }
    else { Write-Host "     已去掉 BOM（头3字节现在是 $newHead），但内容仍不可解析" -ForegroundColor Yellow }
  } elseif (-not $result.Ok -and $RestoreBackup) {
    $bak = Get-ChildItem $profileDir -Filter "$($file.Name).bak-*" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($bak) {
      Copy-Item $bak.FullName $file.FullName -Force
      $restored = Test-JsonText ([IO.File]::ReadAllText($file.FullName))
      if ($restored.Ok) { Write-Host "     已从 $($bak.Name) 恢复，内容可解析" -ForegroundColor Green }
      else { Write-Host "     从 $($bak.Name) 恢复后仍不可解析" -ForegroundColor Red }
      Write-Host "     注意：恢复会丢掉插件的 entry，修好后重跑 deploy-windows.ps1 再加回来" -ForegroundColor Yellow
    } else {
      Write-Host "     没有备份可恢复" -ForegroundColor Red
    }
  }
}

Write-Host ""
if ($problems -gt 0 -and -not $RestoreBackup -and -not $CheckOnly) {
  Write-Host "有 $problems 个文件内容本身不可解析（不只是 BOM）。" -ForegroundColor Yellow
  Write-Host "如果上面列出了备份，可以加 -RestoreBackup 用最新的备份覆盖：" -ForegroundColor Yellow
  Write-Host "  .\repair-profile-json.ps1 -Profile $Profile -RestoreBackup" -ForegroundColor Gray
}

if ($CheckOnly) {
  Write-Host "体检模式：没有改任何文件。" -ForegroundColor Cyan
} else {
  Write-Host "完成。现在启动 DSH（不需要重启机器）。" -ForegroundColor Green
}
exit ([int]($problems -gt 0))
