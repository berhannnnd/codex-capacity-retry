@echo off
rem Start the codex keepalive monitor detached (no console window).
powershell -NoProfile -Command "Start-Process -WindowStyle Hidden node -ArgumentList '\"%~dp0keepalive.js\"' -WorkingDirectory '%~dp0'"
echo keepalive started. Log: %~dp0keepalive.log
