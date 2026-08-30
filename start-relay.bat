@echo off
REM ============================================================
REM  Chat relay per delt.io - kliko dy here kete skedar.
REM  Lere kete dritare HAPUR sa kohe luan (chat-i kalon ketu).
REM ============================================================
cd /d "%~dp0"
echo Duke nisur relay-n e chat-it...
node relay.js
echo.
echo Relay-i u mbyll. Shtyp nje buton per ta mbyllur dritaren.
pause >nul
