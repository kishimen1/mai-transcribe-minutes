"""動作確認用の模擬 Azure サーバー（本物の API キーなしで画面の流れを試せます）

使い方: python3 tools/mock_azure.py → 初期設定のエンドポイントに http://127.0.0.1:9900 を入れる
"""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.headers.get("Ocp-Apim-Subscription-Key") != "test-key":
            self.send_response(401); self.end_headers()
            self.wfile.write(b'{"message":"Access denied due to invalid subscription key."}'); return
        assert b'"MAI-Transcribe-2"' in body, "model not set"
        segs = [(0, "1", "それでは定例会議を始めます。"), (4200, "1", "まず先週の進捗から確認しましょう。"),
                (9000, "2", "はい、営業部の佐藤です。新規案件が3件ありました。"), (15000, "3", "開発のほうは予定どおりです。")]
        res = {"durationMilliseconds": 20000,
               "combinedPhrases": [{"text": "".join(s[2] for s in segs)}],
               "phrases": [{"offsetMilliseconds": o, "durationMilliseconds": 4000, "speaker": int(sp), "text": t,
                            "locale": "ja-JP", "confidence": 0} for o, sp, t in segs]}
        data = json.dumps(res, ensure_ascii=False).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)


HTTPServer(("127.0.0.1", 9900), H).serve_forever()
