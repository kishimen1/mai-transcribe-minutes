#!/bin/sh
# APIキーが GitHub に送られないようにするチェック（pre-commit / pre-push から呼ばれます）
# 引数: 調べる差分の範囲。省略時はコミットしようとしている変更（ステージ済み）
# 意図して無視する場合だけ: git commit --no-verify（通常は使わないでください）

if [ -n "$1" ]; then
  files=$(git diff --name-only "$1")
  added=$(git diff -U0 "$1")
else
  files=$(git diff --cached --name-only --diff-filter=ACMR)
  added=$(git diff --cached -U0)
fi
added=$(printf '%s\n' "$added" | grep '^+' | grep -v '^+++')
ng=0

# 1. APIキーを保存するファイル・文字起こしデータそのもの
blocked=$(printf '%s\n' "$files" | grep -E '(^|/)config\.json(\.tmp)?$|^data/')
if [ -n "$blocked" ]; then
  echo "✖ APIキーや文字起こしデータのファイルが含まれています:"
  printf '   %s\n' $blocked
  ng=1
fi

# 2. 中身に APIキーらしき文字列（Azure のキーは32桁の16進数 または 84文字の英数字）
keylike=$(printf '%s\n' "$added" | grep -nE '"api_key"[[:space:]]*:[[:space:]]*"[^"]+"|Ocp-Apim-Subscription-Key:[[:space:]]*[A-Za-z0-9]{20,}|(^|[^A-Za-z0-9])[0-9a-fA-F]{32}([^A-Za-z0-9]|$)|(^|[^A-Za-z0-9])[A-Za-z0-9]{84}([^A-Za-z0-9]|$)')
if [ -n "$keylike" ]; then
  echo "✖ APIキーらしき文字列が見つかりました:"
  printf '%s\n' "$keylike" | cut -c1-120 | sed 's/^/   /'
  ng=1
fi

if [ $ng -ne 0 ]; then
  echo ""
  echo "APIキーを GitHub に送らないよう、処理を中止しました。"
  echo "該当箇所を取り除いてから、もう一度実行してください。"
  exit 1
fi
exit 0
