#!/bin/bash
# ダブルクリックで議事録文字起こしアプリを起動します（Mac 用）
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 が見つかりません。"
  echo "「はじめにお読みください.md」の「Python の準備」を参照してください。"
  read -p "Enter キーを押すと閉じます"
  exit 1
fi
python3 app.py
read -p "アプリが終了しました。Enter キーを押すと閉じます"
