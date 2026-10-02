#!/usr/bin/env python3
"""
議事録文字起こしアプリ（MAI-Transcribe-2 / Azure Speech 利用）

・Python 3.8 以上の標準ライブラリだけで動きます（追加インストール不要）。
・このパソコンの中だけで動く小さなWebサーバーを起動し、ブラウザで操作します。
・APIキーはこのフォルダの config.json にだけ保存され、ブラウザ側には送られません。
"""

import datetime
import json
import mimetypes
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")
DATA_DIR = os.path.join(APP_DIR, "data")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
TRANSCRIPT_DIR = os.path.join(DATA_DIR, "transcripts")
CONFIG_PATH = os.path.join(APP_DIR, "config.json")
USAGE_PATH = os.path.join(DATA_DIR, "usage.json")

API_VERSION = "2025-10-15"
MODEL_NAME = "MAI-Transcribe-2"
HOST = "127.0.0.1"
DEFAULT_PORT = 8765

# MAI-Transcribe が使えるリージョン（2026年9月時点の公式ドキュメントより）
SUPPORTED_REGIONS = ["southeastasia", "centralindia", "eastus", "westus", "westus2", "northeurope"]
# API が直接受け付ける音声形式。それ以外は WAV に変換してから送る
DIRECT_FORMATS = {".wav", ".mp3", ".flac"}
MAX_UPLOAD_BYTES = 500 * 1024 * 1024  # API 上限（500MB 未満）

DEFAULT_CONFIG = {
    "api_key": "",
    "endpoint": "",
    "region": "southeastasia",
    "price_usd_per_hour": 0.10,
    "price_note": "MAI-Transcribe-2 のプレビュー価格（2026年12月31日までの期間限定）",
    "jpy_per_usd": 150,
    "monthly_budget_jpy": 1000,
    "default_phrases": [],
}

jobs = {}
jobs_lock = threading.Lock()
file_lock = threading.Lock()


# ---------------------------------------------------------------- 設定・記録

def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, data, private=False):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    if private:
        try:
            os.chmod(tmp, 0o600)  # 自分以外のユーザーから読めないようにする
        except OSError:
            pass
    os.replace(tmp, path)


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    cfg.update(load_json(CONFIG_PATH, {}))
    return cfg


def mask_key(key):
    if not key:
        return ""
    return key[:4] + "…" + key[-4:] if len(key) > 8 else "****"


def public_config(cfg):
    out = {k: v for k, v in cfg.items() if k != "api_key"}
    out["api_key_masked"] = mask_key(cfg.get("api_key", ""))
    out["has_key"] = bool(cfg.get("api_key"))
    return out


def transcribe_url(cfg):
    endpoint = (cfg.get("endpoint") or "").strip()
    if endpoint:
        parsed = urllib.parse.urlparse(endpoint if "://" in endpoint else "https://" + endpoint)
        # 本番は常に https。動作確認用のローカル模擬サーバーだけ http を許可する
        local = parsed.hostname in ("127.0.0.1", "localhost")
        base = (parsed.scheme if local else "https") + "://" + parsed.netloc
    else:
        base = "https://%s.api.cognitive.microsoft.com" % (cfg.get("region") or "southeastasia").strip()
    return base + "/speechtotext/transcriptions:transcribe?api-version=" + API_VERSION


def record_usage(seconds, filename, kind):
    cfg = load_config()
    with file_lock:
        usage = load_json(USAGE_PATH, [])
        usage.append({
            "time": datetime.datetime.now().isoformat(timespec="seconds"),
            "seconds": round(seconds, 1),
            "file": filename,
            "kind": kind,
            "usd": round(seconds / 3600 * float(cfg["price_usd_per_hour"]), 5),
        })
        save_json(USAGE_PATH, usage)


# ---------------------------------------------------------------- 音声処理

def find_converter():
    if shutil.which("ffmpeg"):
        return "ffmpeg"
    if sys.platform == "darwin" and shutil.which("afconvert"):
        return "afconvert"  # Mac に最初から入っている変換ツール
    return None


def convert_to_wav(src, dst):
    """どんな音声・動画でも 16kHz モノラル WAV に変換する（会議の音声には十分な品質）"""
    conv = find_converter()
    if conv == "ffmpeg":
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-vn", "-ac", "1", "-ar", "16000",
               "-c:a", "pcm_s16le", dst]
    elif conv == "afconvert":
        cmd = ["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", src, dst]
    else:
        raise UserError("この形式の音声を変換するツールが見つかりません。"
                        "MP3 / WAV / FLAC 形式のファイルを使うか、ffmpeg をインストールしてください。")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 or not os.path.exists(dst):
        raise UserError("音声の変換に失敗しました。ファイルが壊れていないか確認してください。\n"
                        + (result.stderr or "")[-500:])


def wav_duration(path):
    try:
        with wave.open(path, "rb") as w:
            return w.getnframes() / float(w.getframerate())
    except Exception:
        return None


def silent_wav_bytes(seconds=1, rate=16000):
    n = int(seconds * rate)
    data = b"\x00\x00" * n
    header = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(data))
    return header + data


# ---------------------------------------------------------------- Azure 呼び出し

class UserError(Exception):
    """利用者に見せるためのわかりやすいエラー"""


def explain_http_error(code, body):
    detail = ""
    try:
        j = json.loads(body)
        detail = j.get("message") or j.get("error", {}).get("message") or ""
    except Exception:
        detail = (body or "")[:300]
    hints = {
        400: "リクエストの内容に問題があります。音声が長すぎる・形式が対応していない・"
             "選んだリージョンで MAI-Transcribe が使えない、などが考えられます。"
             "話者分離をオンにしている場合は、オフにするか録音を短く分けると成功することがあります。",
        401: "APIキーが正しくありません。Azure ポータルの「キーとエンドポイント」からコピーし直してください。",
        403: "このリソースでは利用が許可されていません。無料プラン(F0)では使えないため、"
             "価格レベルが Standard (S0) になっているか確認してください。",
        404: "接続先（エンドポイント）が見つかりません。エンドポイントのURLかリージョンを確認してください。",
        413: "ファイルが大きすぎます（上限 500MB 未満）。",
        429: "短時間にリクエストが集中しました。1分ほど待ってからもう一度お試しください。",
    }
    msg = hints.get(code, "Azure 側でエラーが発生しました（コード %s）。時間をおいて再度お試しください。" % code)
    if detail:
        msg += "\n\n（Azure からの詳細メッセージ: %s）" % detail
    return msg


def call_transcribe(cfg, audio_path, audio_name, definition, timeout=3600, audio_bytes=None):
    if not cfg.get("api_key"):
        raise UserError("APIキーが設定されていません。「初期設定」画面で設定してください。")
    boundary = "----mai" + uuid.uuid4().hex
    ctype = mimetypes.guess_type(audio_name)[0] or "application/octet-stream"
    head = (
        "--%s\r\nContent-Disposition: form-data; name=\"definition\"\r\n"
        "Content-Type: application/json\r\n\r\n%s\r\n"
        "--%s\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"%s\"\r\n"
        "Content-Type: %s\r\n\r\n"
        % (boundary, json.dumps(definition, ensure_ascii=False), boundary,
           urllib.parse.quote(audio_name), ctype)
    ).encode("utf-8")
    tail = ("\r\n--%s--\r\n" % boundary).encode("utf-8")
    size = len(audio_bytes) if audio_bytes is not None else os.path.getsize(audio_path)

    def body():
        yield head
        if audio_bytes is not None:
            yield audio_bytes
        else:
            with open(audio_path, "rb") as f:
                while True:
                    chunk = f.read(1024 * 1024)
                    if not chunk:
                        break
                    yield chunk
        yield tail

    req = urllib.request.Request(transcribe_url(cfg), data=body(), method="POST")
    req.add_header("Ocp-Apim-Subscription-Key", cfg["api_key"])
    req.add_header("Content-Type", "multipart/form-data; boundary=" + boundary)
    req.add_header("Content-Length", str(len(head) + size + len(tail)))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise UserError(explain_http_error(e.code, e.read().decode("utf-8", "replace")))
    except urllib.error.URLError as e:
        raise UserError("Azure に接続できませんでした。インターネット接続と、エンドポイント/リージョンの"
                        "設定を確認してください。（%s）" % e.reason)
    except socket.timeout:
        raise UserError("Azure からの応答が時間内に返ってきませんでした。時間をおいて再度お試しください。")


def build_definition(opts):
    model_options = {"timestamps": "segment",
                     "transcribeStyle": "clean" if opts.get("clean", True) else "verbatim"}
    d = {"enhancedMode": {"enabled": True, "model": MODEL_NAME, "modelOptions": model_options}}
    if opts.get("diarization", True):
        d["diarization"] = {"enabled": True}
    phrases = [p.strip() for p in opts.get("phrases", []) if p and p.strip()]
    if phrases:
        d["phraseList"] = {"phrases": phrases[:500]}
    if opts.get("language") and opts["language"] != "auto":
        d["locales"] = [opts["language"]]
    return d


def simplify_result(raw):
    """Azure の応答を、画面で扱いやすい「発言のリスト」に整える"""
    segments = []
    for p in raw.get("phrases", []):
        text = (p.get("text") or "").strip()
        if not text:
            continue
        speaker = p.get("speaker")
        segments.append({
            "start": (p.get("offsetMilliseconds") or 0) / 1000.0,
            "end": ((p.get("offsetMilliseconds") or 0) + (p.get("durationMilliseconds") or 0)) / 1000.0,
            "speaker": str(speaker) if speaker is not None else "",
            "text": text,
        })
    # 同じ話者の連続した発言はひとまとめにして読みやすくする
    merged = []
    for s in segments:
        if merged and merged[-1]["speaker"] == s["speaker"] and s["start"] - merged[-1]["end"] < 2.0:
            sep = "" if re.search(r"[　-鿿＀-￯]$", merged[-1]["text"]) else " "
            merged[-1]["text"] += sep + s["text"]
            merged[-1]["end"] = s["end"]
        else:
            merged.append(dict(s))
    full_text = " ".join(c.get("text", "") for c in raw.get("combinedPhrases", []))
    return merged, full_text


# ---------------------------------------------------------------- ジョブ

def set_job(job_id, **kw):
    with jobs_lock:
        jobs[job_id].update(kw)


def run_job(job_id, upload_path, original_name, opts):
    work_files = [upload_path]
    try:
        cfg = load_config()
        ext = os.path.splitext(original_name)[1].lower()
        send_path, send_name = upload_path, original_name
        if ext not in DIRECT_FORMATS or (ext != ".flac" and find_converter()):
            # 非対応形式は必ず変換。対応形式でも変換ツールがあれば軽量な WAV にして送信を速くする
            set_job(job_id, stage="convert", message="音声を文字起こし用の形式に変換しています…")
            wav_path = os.path.join(UPLOAD_DIR, job_id + "_conv.wav")
            work_files.append(wav_path)
            try:
                convert_to_wav(upload_path, wav_path)
                send_path, send_name = wav_path, os.path.splitext(original_name)[0] + ".wav"
            except UserError:
                if ext not in DIRECT_FORMATS:
                    raise
        if os.path.getsize(send_path) >= MAX_UPLOAD_BYTES:
            raise UserError("音声ファイルが大きすぎます（500MB 以上）。録音を分けてからお試しください。")

        set_job(job_id, stage="transcribe",
                message="MAI-Transcribe-2 で文字起こし中です。1時間の会議で数分かかることがあります…")
        started = time.time()
        raw = call_transcribe(cfg, send_path, send_name, build_definition(opts))
        segments, full_text = simplify_result(raw)
        seconds = (raw.get("durationMilliseconds") or 0) / 1000.0 or (wav_duration(send_path) or 0)
        record_usage(seconds, original_name, "文字起こし")

        tid = datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + job_id[:6]
        doc = {
            "id": tid,
            "title": opts.get("title") or os.path.splitext(original_name)[0],
            "meeting_date": opts.get("meeting_date") or datetime.date.today().isoformat(),
            "file": original_name,
            "created": datetime.datetime.now().isoformat(timespec="seconds"),
            "duration_seconds": seconds,
            "processing_seconds": round(time.time() - started, 1),
            "cost_usd": round(seconds / 3600 * float(cfg["price_usd_per_hour"]), 5),
            # 後から単価や為替レートを変えても、その時点の金額を表示できるように記録しておく
            "price_usd_per_hour": float(cfg["price_usd_per_hour"]),
            "jpy_per_usd": float(cfg["jpy_per_usd"]),
            "options": opts,
            "speaker_names": {},
            "segments": segments,
            "full_text": full_text,
        }
        save_json(os.path.join(TRANSCRIPT_DIR, tid + ".json"), doc)
        set_job(job_id, stage="done", message="完了しました", transcript_id=tid)
    except UserError as e:
        set_job(job_id, stage="error", message=str(e))
    except Exception as e:  # 想定外のエラーも画面に出す
        set_job(job_id, stage="error", message="予期しないエラーが発生しました: %r" % e)
    finally:
        for p in work_files:  # 音声ファイルは文字起こし後に削除（プライバシー保護）
            try:
                os.remove(p)
            except OSError:
                pass


# ---------------------------------------------------------------- Webサーバー

class Handler(BaseHTTPRequestHandler):
    server_version = "MinutesApp/1.0"

    def log_message(self, fmt, *args):
        pass  # 端末をすっきりさせる

    # 他のWebサイトからこのアプリを勝手に操作されないようにする確認
    def _is_trusted(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            return False
        origin = self.headers.get("Origin")
        if origin and urllib.parse.urlparse(origin).hostname not in ("127.0.0.1", "localhost"):
            return False
        return True

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n).decode("utf-8")) if n else {}

    def do_GET(self):
        if not self._is_trusted():
            return self._send(403, {"error": "forbidden"})
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/config":
            return self._send(200, dict(public_config(load_config()),
                                        converter=find_converter(),
                                        supported_regions=SUPPORTED_REGIONS,
                                        today=datetime.date.today().isoformat()))
        if path == "/api/usage":
            return self._send(200, load_json(USAGE_PATH, []))
        if path.startswith("/api/jobs/"):
            with jobs_lock:
                job = jobs.get(path.rsplit("/", 1)[-1])
            return self._send(200, job) if job else self._send(404, {"error": "not found"})
        if path == "/api/transcripts":
            items = []
            for name in sorted(os.listdir(TRANSCRIPT_DIR), reverse=True):
                if name.endswith(".json"):
                    d = load_json(os.path.join(TRANSCRIPT_DIR, name), None)
                    if d:
                        items.append({k: d.get(k) for k in
                                      ("id", "title", "meeting_date", "created", "duration_seconds", "cost_usd",
                                       "price_usd_per_hour", "jpy_per_usd")})
            return self._send(200, items)
        if path.startswith("/api/transcripts/"):
            tid = os.path.basename(path)
            d = load_json(os.path.join(TRANSCRIPT_DIR, tid + ".json"), None)
            return self._send(200, d) if d else self._send(404, {"error": "not found"})
        # 画面のファイル
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            return self._send(404, "Not Found", "text/plain; charset=utf-8")
        with open(full, "rb") as f:
            data = f.read()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        return self._send(200, data, ctype)

    def do_POST(self):
        if not self._is_trusted():
            return self._send(403, {"error": "forbidden"})
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/api/config":
                body = self._json_body()
                cfg = load_config()
                for k in ("endpoint", "region", "price_usd_per_hour", "jpy_per_usd",
                          "monthly_budget_jpy", "default_phrases"):
                    if k in body:
                        cfg[k] = body[k]
                if body.get("api_key"):
                    cfg["api_key"] = body["api_key"].strip()
                save_json(CONFIG_PATH, cfg, private=True)
                return self._send(200, public_config(cfg))

            if path == "/api/test":
                cfg = load_config()
                # 1秒の無音を送って接続確認（料金はごくわずか: 約0.003円）
                raw = call_transcribe(cfg, None, "test.wav",
                                      build_definition({"diarization": False}),
                                      timeout=120, audio_bytes=silent_wav_bytes(1))
                secs = (raw.get("durationMilliseconds") or 1000) / 1000.0
                record_usage(secs, "(接続テスト)", "接続テスト")
                return self._send(200, {"ok": True})

            if path == "/api/upload":
                length = int(self.headers.get("Content-Length") or 0)
                name = urllib.parse.unquote(self.headers.get("X-Filename") or "audio")
                name = os.path.basename(name) or "audio"
                if length <= 0:
                    raise UserError("ファイルが空です。")
                if length > 4 * 1024 * 1024 * 1024:
                    raise UserError("ファイルが大きすぎます（4GB 以上）。")
                opts = json.loads(urllib.parse.unquote(self.headers.get("X-Options") or "{}"))
                job_id = uuid.uuid4().hex
                dst = os.path.join(UPLOAD_DIR, job_id + os.path.splitext(name)[1].lower())
                remaining = length
                with open(dst, "wb") as f:
                    while remaining > 0:
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            break
                        f.write(chunk)
                        remaining -= len(chunk)
                with jobs_lock:
                    jobs[job_id] = {"id": job_id, "stage": "queued", "message": "準備中…", "file": name}
                threading.Thread(target=run_job, args=(job_id, dst, name, opts), daemon=True).start()
                return self._send(200, {"job_id": job_id})

            if path.startswith("/api/transcripts/"):
                tid = os.path.basename(path)
                p = os.path.join(TRANSCRIPT_DIR, tid + ".json")
                d = load_json(p, None)
                if not d:
                    return self._send(404, {"error": "not found"})
                body = self._json_body()
                if body.get("delete"):
                    os.remove(p)
                    return self._send(200, {"ok": True})
                for k in ("title", "meeting_date", "speaker_names", "segments", "attendees", "notes"):
                    if k in body:
                        d[k] = body[k]
                save_json(p, d)
                return self._send(200, {"ok": True})

            return self._send(404, {"error": "not found"})
        except UserError as e:
            return self._send(400, {"error": str(e)})
        except Exception as e:
            return self._send(500, {"error": "予期しないエラー: %r" % e})


def main():
    for d in (DATA_DIR, UPLOAD_DIR, TRANSCRIPT_DIR):
        os.makedirs(d, exist_ok=True)
    # 前回の残りの一時ファイルを掃除
    for name in os.listdir(UPLOAD_DIR):
        try:
            os.remove(os.path.join(UPLOAD_DIR, name))
        except OSError:
            pass

    port = DEFAULT_PORT
    server = None
    for p in range(DEFAULT_PORT, DEFAULT_PORT + 20):
        try:
            server = ThreadingHTTPServer((HOST, p), Handler)
            port = p
            break
        except OSError:
            continue
    if server is None:
        print("起動できませんでした（使えるポートがありません）。")
        sys.exit(1)

    url = "http://127.0.0.1:%d/" % port
    print("=" * 60)
    print(" 議事録文字起こしアプリが起動しました")
    print(" ブラウザで次のアドレスを開いてください: " + url)
    print(" 終了するときは、この画面を閉じるか Ctrl + C を押してください")
    print("=" * 60)
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n終了しました。")


if __name__ == "__main__":
    main()
