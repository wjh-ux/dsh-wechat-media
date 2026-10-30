@echo off
rem ---------------------------------------------------------------------------
rem  dsh-wechat-media Keil bridge: the entry uVision's Tools menu calls.
rem
rem  Add it in uVision (Tools - Customize Tools Menu...):
rem      Menu Content  : Keil: build (DSH)
rem      Command       : C:\Windows\System32\cmd.exe
rem      Arguments     : /c "<this folder>\dsh-keil.cmd" "#P"
rem      Initial Folder: (leave empty)
rem      tick "Run Independent" so uVision does not freeze during a build.
rem
rem  "#P" is uVision's own substitution for the current project file, so this
rem  works on whatever project is open - no per-project setup.
rem
rem  scripts\keil\install-tools-menu.ps1 writes those registry entries for you.
rem ---------------------------------------------------------------------------
setlocal
set "HERE=%~dp0"

if "%~1"=="" (
  echo Usage: dsh-keil.cmd ^<project.uvprojx^> [build^|rebuild^|clean^|flash] [target]
  echo In uVision's Tools menu the project path comes from #P automatically.
  goto :usage
)

node "%HERE%keil-cli.mjs" %*
set "CODE=%ERRORLEVEL%"

rem Keep the window open when uVision launched us: a console that vanishes on a
rem failed build is the same as no output at all.
if not "%DSH_KEIL_NO_PAUSE%"=="1" (
  echo.
  if not "%CODE%"=="0" echo exit code %CODE% ^(0 ok / 2 build failed / 3 could not run^)
  pause
)
exit /b %CODE%

:usage
if not "%DSH_KEIL_NO_PAUSE%"=="1" pause
exit /b 3
