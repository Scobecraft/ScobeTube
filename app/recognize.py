"""Song erkennen: kurzer Audio-Ausschnitt (Mikrofon oder Datei) → Interpret, Titel, Album, Spotify-Link.

Erkannt wird über AudD (audd.io). Ohne API-Schlüssel geht das mit einem kleinen Tageslimit,
mit Schlüssel (Admin-Einstellungen) entsprechend mehr. An AudD geht nur der Audio-Ausschnitt.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import threading
import uuid
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from . import config

API = "https://api.audd.io/"
SETTINGS_FILE = config.STATE_DIR / "recognize.json"
MAX_UPLOAD = 60 * 1024 * 1024
_lock = threading.Lock()


def settings() -> dict[str, Any]:
    try:
        data = json.loads(SETTINGS_FILE.read_text("utf-8"))
    except (OSError, ValueError):
        data = {}
    return {"enabled": data.get("enabled", True), "token": data.get("token") or os.environ.get("AUDD_TOKEN", "")}


def public() -> dict[str, Any]:
    s = settings()
    return {"enabled": s["enabled"], "has_token": bool(s["token"])}


def update(enabled: bool | None = None, token: str | None = None, clear_token: bool = False) -> dict[str, Any]:
    with _lock:
        s = settings()
        if enabled is not None:
            s["enabled"] = bool(enabled)
        if token:
            s["token"] = token.strip()[:200]
        if clear_token:
            s["token"] = ""
        SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = SETTINGS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(s), "utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(SETTINGS_FILE)
    return public()


def _clip(raw: bytes) -> bytes:
    """Beliebige Audio-/Videodatei → 12 s MP3. Bei langen Dateien ein Stück aus dem ersten Drittel."""
    if len(raw) > MAX_UPLOAD:
        raise ValueError("Datei ist zu groß (max. 60 MB)")
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / "in", Path(tmp) / "clip.mp3"
        src.write_bytes(raw)
        dur = 0.0
        try:
            out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(src)],
                                 capture_output=True, text=True, timeout=30).stdout.strip()
            dur = float(out or 0)
        except (ValueError, subprocess.SubprocessError):
            pass
        start = max(0.0, dur * 0.3) if dur > 40 else 0.0
        proc = subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{start:.1f}", "-t", "12", "-i", str(src),
                               "-vn", "-ac", "1", "-ar", "44100", "-b:a", "128k", str(dst)],
                              capture_output=True, timeout=60)
        if proc.returncode != 0 or not dst.exists() or dst.stat().st_size < 4000:
            raise ValueError("Die Aufnahme konnte nicht gelesen werden – ist Ton drauf?")
        return dst.read_bytes()


def _post(fields: dict[str, str], file_bytes: bytes) -> dict[str, Any]:
    boundary = uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.mp3"\r\n'
                 f"Content-Type: audio/mpeg\r\n\r\n".encode() + file_bytes + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(API, data=b"".join(parts), method="POST", headers={
        "Content-Type": f"multipart/form-data; boundary={boundary}", "User-Agent": "ScobeTube"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read().decode("utf-8"))


def _cover(spotify: dict[str, Any] | None, apple: dict[str, Any] | None) -> str | None:
    imgs = ((spotify or {}).get("album") or {}).get("images") or []
    if imgs:
        return imgs[0].get("url")
    art = ((apple or {}).get("artwork") or {}).get("url")
    return art.replace("{w}", "600").replace("{h}", "600") if art else None


def recognize(raw: bytes) -> dict[str, Any]:
    s = settings()
    if not s["enabled"]:
        raise PermissionError("Die Song-Erkennung ist vom Admin abgeschaltet")
    clip = _clip(raw)
    fields = {"return": "spotify,apple_music"}
    if s["token"]:
        fields["api_token"] = s["token"]
    try:
        data = _post(fields, clip)
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        raise RuntimeError(f"Erkennungsdienst nicht erreichbar ({e})") from e
    if data.get("status") != "success":
        err = (data.get("error") or {})
        code = err.get("error_code")
        if code in (901, 902):
            raise RuntimeError("Tageslimit der Song-Erkennung erreicht. Der Admin kann in den Einstellungen "
                               "einen AudD-API-Schlüssel hinterlegen.")
        if code == 900:
            raise RuntimeError("Der AudD-API-Schlüssel ist ungültig")
        raise RuntimeError(err.get("error_message") or "Erkennung fehlgeschlagen")
    r = data.get("result")
    if not r:
        return {"found": False}
    sp, am = r.get("spotify") or {}, r.get("apple_music") or {}
    return {
        "found": True, "artist": r.get("artist"), "title": r.get("title"), "album": r.get("album"),
        "release": r.get("release_date"), "timecode": r.get("timecode"), "song_link": r.get("song_link"),
        "spotify_url": (sp.get("external_urls") or {}).get("spotify"),
        "apple_url": am.get("url"), "cover": _cover(sp, am),
    }
