# 議事録文字起こしアプリ（MAI-Transcribe-2）

Microsoft の文字起こしモデル **MAI-Transcribe-2**（Azure Speech）を使って、会議の録音から話者別の議事録を作るローカルアプリです。
IT に不慣れな方でも使えるよう、起動はダブルクリック、設定はブラウザ画面で行います。

- Python 3.8+ の標準ライブラリのみで動作（追加インストール不要）
- 話者分離・フィラー除去・専門用語の指定・M4A/MP4 の自動変換
- 文字起こしごとの料金（概算）表示、月予算の管理
- TXT / Word / Markdown で書き出し

**使い方・Azure の準備・料金の説明は [はじめにお読みください.md](はじめにお読みください.md) をご覧ください。**
料金と APIキー の詳しい説明：[docs/料金とAPIキーのしくみ.md](docs/料金とAPIキーのしくみ.md)

> APIキー（`config.json`）と文字起こし結果（`data/`）は `.gitignore` によりリポジトリに含まれません。

## 開発者向け：APIキーの流出防止

このリポジトリには、APIキーを誤ってコミット・プッシュしないためのチェック（`.githooks/`）が入っています。
クローンした後に一度だけ、次のコマンドで有効にしてください。

```bash
git config core.hooksPath .githooks
```

- `config.json`（APIキーの保存先）と `data/` は `.gitignore` で除外済み
- それでも `git add -f` したり、コードにキーを直接書いたりすると、コミット時とプッシュ時に自動で止まります
- GitHub 側でも Secret scanning の Push protection を有効にしています
