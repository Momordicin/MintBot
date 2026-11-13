@echo off
rem start.cmd - build, then start MintBot by running electron.exe directly like autostart; the console closes once MintBot starts
rem Usage: double-click (the console stays open during the build); close a running MintBot first, since the build rewrites out/
rem Files: package.json (build:all script) / electron/main/autostart.ts / start-cli.cmd
cd /d "%~dp0"
call pnpm build:all
if errorlevel 1 (
  echo Build failed. See the output above.
  pause
  exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron not found. Run: pnpm install
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
