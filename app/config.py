"""Konfiguration über Umgebungsvariablen."""
import json
import os
from pathlib import Path


def _bool(name: str, default: bool) -> bool:
    val = os.environ.get(name)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on", "ja")


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


DOWNLOAD_DIR = Path(os.environ.get("DOWNLOAD_DIR", "/downloads")).resolve()
STATE_DIR = Path(os.environ.get("STATE_DIR", "/data")).resolve()

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = _int("PORT", 8081)
URL_PREFIX = "/" + os.environ.get("URL_PREFIX", "").strip("/")
if URL_PREFIX == "/":
    URL_PREFIX = ""

MAX_CONCURRENT = max(1, _int("MAX_CONCURRENT_DOWNLOADS", 3))
OUTPUT_TEMPLATE = os.environ.get("OUTPUT_TEMPLATE", "%(title)s.%(ext)s")
PLAYLIST_SUBFOLDER = _bool("PLAYLIST_SUBFOLDER", True)
PLAYLIST_LIMIT = _int("PLAYLIST_LIMIT", 0)  # 0 = unbegrenzt
WINDOWS_FILENAMES = _bool("WINDOWS_FILENAMES", True)

# Heruntergeladene Dateien nach so vielen Stunden automatisch löschen (0 = nie)
try:
    RETENTION_HOURS = max(0.0, float(os.environ.get("RETENTION_HOURS", "10")))
except ValueError:
    RETENTION_HOURS = 10.0

# Session-Cookie nur über HTTPS senden: auto (erkennt HTTPS), true, false
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "auto").lower()
# IPs von Reverse-Proxys, deren X-Forwarded-For/-Proto vertraut wird (kommagetrennt, "*" = alle)
TRUSTED_PROXIES = os.environ.get("TRUSTED_PROXIES", "127.0.0.1")

COOKIES_FILE = Path(os.environ.get("COOKIES_FILE", str(STATE_DIR / "cookies.txt")))
YTDLP_CHANNEL = os.environ.get("YTDLP_CHANNEL", "stable").lower()  # stable | nightly

try:
    YTDL_EXTRA_OPTIONS = json.loads(os.environ.get("YTDL_OPTIONS", "{}") or "{}")
    if not isinstance(YTDL_EXTRA_OPTIONS, dict):
        YTDL_EXTRA_OPTIONS = {}
except json.JSONDecodeError:
    YTDL_EXTRA_OPTIONS = {}

APP_VERSION = "1.0.0"
