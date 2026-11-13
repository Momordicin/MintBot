@echo off
rem start-cli.cmd - build, then start MintBot with a console window showing build output and Electron main-process logs
rem Usage: double-click; close a running MintBot first, since the build rewrites out/
rem Files: package.json (build:all and start scripts) / start.cmd
cd /d "%~dp0"
call pnpm build:all
if errorlevel 1 (
  echo Build failed. See the output above.
  pause
  exit /b 1
)
call pnpm start
if errorlevel 1 pause
