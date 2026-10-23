@echo off
rem Stop the running keepalive monitor (pid kept in keepalive.lock next to this script).
powershell -NoProfile -Command "$lock = '%~dp0keepalive.lock'; $m = Select-String -Path $lock -Pattern 'pid=(\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($m) { $p = [int]$m.Matches[0].Groups[1].Value; Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; Write-Output \"stopped pid $p\" } else { Write-Output 'no pid found in lock file' }"
