"""
Python-версия лог-сервера для kp.js (без зависимостей, на stdlib).

Запуск:
    python server.py
    # или
    py server.py

Слушает :8088 по умолчанию. Переменные окружения PORT, LOG_DIR, LOG_TOKEN — как в server.js.
"""

import os
import json
import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(os.environ.get("PORT", "8088"))
LOG_DIR = Path(os.environ.get("LOG_DIR", Path(__file__).with_name("logs")))
LOG_TOKEN = os.environ.get("LOG_TOKEN", "")
TAIL_BUFFER = 500

LOG_DIR.mkdir(parents=True, exist_ok=True)
recent: list = []

COLORS = {
    "debug": "\x1b[90m",
    "info":  "\x1b[36m",
    "warn":  "\x1b[33m",
    "error": "\x1b[31m",
}
RESET = "\x1b[0m"


def today_file() -> Path:
    return LOG_DIR / f"{datetime.date.today().isoformat()}.log"


def write_record(rec: dict) -> None:
    line = json.dumps(rec, ensure_ascii=False)
    with today_file().open("a", encoding="utf-8") as f:
        f.write(line + "\n")
    recent.append(rec)
    if len(recent) > TAIL_BUFFER:
        del recent[: len(recent) - TAIL_BUFFER]

    lvl = (rec.get("level") or "info").lower()
    color = COLORS.get(lvl, "")
    ts = datetime.datetime.fromtimestamp((rec.get("ts") or 0) / 1000).strftime("%H:%M:%S.%f")[:-3] \
        if rec.get("ts") else " " * 12
    sess = (rec.get("session") or "")[:8]
    tag = f"[{rec['tag']}] " if rec.get("tag") else ""
    msg = rec.get("message") or ""
    if "data" in rec and rec["data"] is not None:
        try:
            msg += " " + (rec["data"] if isinstance(rec["data"], str) else json.dumps(rec["data"], ensure_ascii=False))
        except Exception:
            pass
    print(f"{color}{ts} {sess} {lvl.upper():<5} {tag}{msg}{RESET}", flush=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args, **kwargs):
        # silence default access log
        pass

    def _send(self, code: int, body, ctype: str = "application/json; charset=utf-8") -> None:
        if not isinstance(body, (bytes, bytearray)):
            body = (body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Log-Token")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _check_token(self) -> bool:
        if not LOG_TOKEN:
            return True
        return self.headers.get("X-Log-Token") == LOG_TOKEN

    def do_OPTIONS(self):
        self._send(204, b"")

    def do_GET(self):
        if not self._check_token():
            return self._send(401, {"ok": False, "error": "token"})
        path = self.path.split("?", 1)[0]
        if path == "/health":
            return self._send(200, {"ok": True})
        if path == "/tail":
            return self._send(200, recent[-100:])
        return self._send(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        if not self._check_token():
            return self._send(401, {"ok": False, "error": "token"})
        path = self.path.split("?", 1)[0]
        if path not in ("/log", "/logs"):
            return self._send(404, {"ok": False, "error": "not_found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8") if length else ""
            body = json.loads(raw) if raw else None
            items = body if isinstance(body, list) else [body]
            for it in items:
                if it:
                    write_record(it)
            return self._send(200, {"ok": True, "received": len(items)})
        except Exception as e:
            return self._send(400, {"ok": False, "error": str(e)})


def main():
    print(f"kp log-server (python) listening on :{PORT}")
    print("  POST /log    one record")
    print("  POST /logs   batch")
    print("  GET  /tail   last 100 records")
    print("  GET  /health")
    if LOG_TOKEN:
        print("  AUTH: X-Log-Token header required")
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.server_close()
        print("\nshutting down")


if __name__ == "__main__":
    main()
