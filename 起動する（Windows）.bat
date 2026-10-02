@echo off
chcp 65001 > nul
rem ダブルクリックで議事録文字起こしアプリを起動します（Windows 用）
cd /d "%~dp0"
where py > nul 2>&1
if %errorlevel%==0 (
  py -3 app.py
  goto end
)
where python > nul 2>&1
if %errorlevel%==0 (
  python app.py
  goto end
)
echo Python が見つかりません。
echo 「はじめにお読みください.md」の「Python の準備」を参照してください。
:end
pause