@echo off
REM ────────────────────────────────────────────────────────────────────
REM  deploy-proxy.bat — one-click деплой proxy-server на VPS.
REM
REM  Использование:
REM     deploy-proxy.bat "комментарий к коммиту"
REM
REM  Цепочка:
REM    1. git status
REM    2. git add -A && git commit && git push
REM    3. SSH на VPS: git pull + docker compose up -d --build
REM    4. Tail логов
REM
REM  Требует SSH-ключи к 38.180.120.16 (см. HANDOFF_VPS.md).
REM ────────────────────────────────────────────────────────────────────

if "%~1"=="" (
  echo Usage: deploy-proxy.bat "commit message"
  exit /b 1
)

cd /d "%~dp0"

echo === git status ===
git status

echo.
echo === git add/commit/push ===
git add -A || exit /b 1
git commit -m "%~1" || exit /b 1
git push || exit /b 1

echo.
echo === VPS pull + docker rebuild ===
ssh root@38.180.120.16 -p 2233 "cd /opt/lampa_kinopub && git pull --ff-only && docker compose up -d --build"
if errorlevel 1 (
  echo SSH/docker step failed
  exit /b 1
)

echo.
echo === recent logs ===
ssh root@38.180.120.16 -p 2233 "cd /opt/lampa_kinopub && docker compose logs --tail=20 proxy"

echo.
echo === health check ===
curl -s --max-time 5 https://kinopub.fastcdn.pics/health
echo.
