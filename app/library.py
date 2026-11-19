"""Mediathek: Musik geordnet (Interpret/Album/Titel) in einen Bibliotheks-Ordner legen,
den Navidrome, Jellyfin oder Plex einlesen – und danach den Scan dort anstoßen.

Die Dateien in der Mediathek gehören nicht mehr zu ScobeTube: Die Auto-Löschung fasst sie nicht an.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlparse

from . import config, lyrics

log = logging.getLogger("scobetube.library")

LIBRARY_DIR = Path(os.environ.get("LIBRARY_DIR", "/library")).resolve()
SETTINGS_FILE = config.STATE_DIR / "library.json"
SERVERS = ("none", "navidrome", "jellyfin", "plex")
LAYOUTS = {
    "artist_album": "Interpret/Album/Titel",
    "artist": "Interpret/Titel",
    "flat": "Interpret - Titel",
}
MODES = ("pinned", "audio")
RESCAN_DELAY = 20.0
UA = "ScobeTube"

_lock = threading.RLock()
_timer: threading.Timer | None = None
_settings: dict[str, Any] | None = None
DEFAULTS: dict[str, Any] = {"enabled": False, "mode": "pinned", "layout": "artist_album", "server": "none",
                            "url": "", "username": "", "secret": "", "last_scan": None, "last_error": None}


# ------------------------------------------------------------ einstellungen
def settings() -> dict[str, Any]:
    global _settings
    with _lock:
        if _settings is None:
            data = {}
            try:
                data = json.loads(SETTINGS_FILE.read_text("utf-8"))
            except (OSError, ValueError):
                pass
            _settings = {**DEFAULTS, **{k: v for k, v in data.items() if k in DEFAULTS}}
        return _settings


def _save() -> None:
    with _lock:
        SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = SETTINGS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(settings(), ensure_ascii=False), "utf-8")
        os.chmod(tmp, 0o600)   # enthält Zugangsdaten des Medienservers
        tmp.replace(SETTINGS_FILE)


def dir_status() -> tuple[bool, str]:
    try:
        LIBRARY_DIR.mkdir(parents=True, exist_ok=True)
        probe = LIBRARY_DIR / f".scobetube-{secrets.token_hex(4)}"
        probe.write_bytes(b"")
        probe.unlink()
        return True, ""
    except OSError as e:
        return False, f"Ordner {LIBRARY_DIR} ist nicht beschreibbar ({e.strerror or e})"


def public() -> dict[str, Any]:
    s = settings()
    ok, err = dir_status()
    return {**{k: v for k, v in s.items() if k != "secret"}, "has_secret": bool(s.get("secret")),
            "dir": str(LIBRARY_DIR), "dir_ok": ok, "dir_error": err, "layouts": LAYOUTS}


def update(data: dict[str, Any]) -> dict[str, Any]:
    s = settings()
    with _lock:
        if "enabled" in data:
            s["enabled"] = bool(data["enabled"])
        if data.get("mode") in MODES:
            s["mode"] = data["mode"]
        if data.get("layout") in LAYOUTS:
            s["layout"] = data["layout"]
        if data.get("server") in SERVERS:
            s["server"] = data["server"]
        if "url" in data:
            url = str(data["url"] or "").strip().rstrip("/")[:300]
            if url and urlparse(url).scheme not in ("http", "https"):
                raise ValueError("Die Adresse muss mit http:// oder https:// beginnen")
            s["url"] = url
        if "username" in data:
            s["username"] = str(data["username"] or "").strip()[:120]
        if data.get("secret"):
            s["secret"] = str(data["secret"])[:500]
        if data.get("clear_secret"):
            s["secret"] = ""
        _save()
    return public()


# ------------------------------------------------------------ export
def _safe(part: str, fallback: str) -> str:
    part = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", part or "").strip(" .")
    return (part or fallback)[:120]


def target_for(item, path: Path) -> Path:
    q = lyrics.guess(item, path)
    artist = _safe(q["artist"].split(",")[0] if q["artist"] else "", "Unbekannter Interpret")
    title = _safe(q["title"], "Unbenannt")
    album = _safe(q["album"], "Singles")
    layout = settings()["layout"]
    if layout == "artist_album":
        rel = Path(artist) / album / title
    elif layout == "artist":
        rel = Path(artist) / title
    else:
        rel = Path(f"{artist} - {title}")
    return LIBRARY_DIR / rel.with_name(rel.name + path.suffix.lower())


def wanted(item) -> bool:
    s = settings()
    if not s["enabled"] or item.status != "done" or item.options.kind != "audio":
        return False
    return s["mode"] == "audio" or bool(item.keep)


def export(item, path: Path) -> str:
    """Legt die Datei in die Mediathek (Hardlink, sonst Kopie). Gibt den relativen Pfad zurück."""
    if not path or not path.is_file():
        raise FileNotFoundError("Datei nicht gefunden")
    dest = target_for(item, path)
    old = (LIBRARY_DIR / item.library) if getattr(item, "library", None) else None
    with _lock:
        if dest.exists() and old != dest:
            try:
                same = dest.samefile(path)
            except OSError:
                same = False
            if not same:
                n = 2
                stem = dest.stem
                while dest.exists():
                    dest = dest.with_name(f"{stem} ({n}){dest.suffix}")
                    n += 1
        dest.parent.mkdir(parents=True, exist_ok=True)
        if old and old != dest and old.is_file() and LIBRARY_DIR in old.parents:
            old.unlink(missing_ok=True)
            _prune(old.parent)
        if not (dest.exists() and dest.samefile(path)):
            tmp = dest.with_name(f".{dest.name}.part")
            try:
                os.link(path, tmp)
            except OSError:
                shutil.copy2(path, tmp)
            tmp.replace(dest)
    rel = str(dest.relative_to(LIBRARY_DIR))
    log.info("In Mediathek: %s", rel)
    schedule_rescan()
    return rel


def _prune(folder: Path) -> None:
    while folder != LIBRARY_DIR and LIBRARY_DIR in folder.parents:
        try:
            folder.rmdir()
        except OSError:
            return
        folder = folder.parent


# ------------------------------------------------------------ medienserver
def _http(url: str, method: str = "GET", headers: dict[str, str] | None = None, timeout: int = 10) -> tuple[int, bytes]:
    req = urllib.request.Request(url, method=method, headers={"User-Agent": UA, "Accept": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(200_000)
    except urllib.error.HTTPError as e:
        return e.code, e.read(2000) if e.fp else b""


def _subsonic(endpoint: str) -> dict[str, Any]:
    s = settings()
    salt = secrets.token_hex(6)
    token = hashlib.md5((s["secret"] + salt).encode()).hexdigest()  # noqa: S324 – so verlangt es die Subsonic-API
    q = urlencode({"u": s["username"], "t": token, "s": salt, "v": "1.16.1", "c": UA, "f": "json"})
    code, body = _http(f"{s['url']}/rest/{endpoint}?{q}")
    if code != 200:
        raise RuntimeError(f"Navidrome antwortet mit HTTP {code}")
    resp = json.loads(body.decode("utf-8")).get("subsonic-response", {})
    if resp.get("status") != "ok":
        raise RuntimeError((resp.get("error") or {}).get("message") or "Anmeldung bei Navidrome fehlgeschlagen")
    return resp


def _need_conn() -> dict[str, Any]:
    s = settings()
    if s["server"] == "none":
        raise RuntimeError("Kein Medienserver ausgewählt")
    if not s["url"]:
        raise RuntimeError("Adresse des Medienservers fehlt")
    if not s["secret"]:
        raise RuntimeError("Passwort bzw. API-Schlüssel fehlt")
    if s["server"] == "navidrome" and not s["username"]:
        raise RuntimeError("Benutzername für Navidrome fehlt")
    return s


def test() -> str:
    s = _need_conn()
    if s["server"] == "navidrome":
        resp = _subsonic("ping.view")
        return f"Verbunden mit {resp.get('type', 'Navidrome').capitalize()} {resp.get('serverVersion', '')}".strip()
    if s["server"] == "jellyfin":
        code, body = _http(f"{s['url']}/System/Info", headers={"X-Emby-Token": s["secret"]})
        if code in (401, 403):
            raise RuntimeError("API-Schlüssel wird von Jellyfin abgelehnt")
        if code != 200:
            raise RuntimeError(f"Jellyfin antwortet mit HTTP {code}")
        info = json.loads(body.decode("utf-8"))
        return f"Verbunden mit Jellyfin {info.get('Version', '')} ({info.get('ServerName', '')})"
    code, body = _http(f"{s['url']}/library/sections?" + urlencode({"X-Plex-Token": s["secret"]}))
    if code == 401:
        raise RuntimeError("Plex-Token wird abgelehnt")
    if code != 200:
        raise RuntimeError(f"Plex antwortet mit HTTP {code}")
    try:
        n = len(json.loads(body.decode("utf-8"))["MediaContainer"].get("Directory", []))
        return f"Verbunden mit Plex ({n} Mediatheken)"
    except (ValueError, KeyError):
        return "Verbunden mit Plex"


def rescan() -> str:
    s = _need_conn()
    if s["server"] == "navidrome":
        _subsonic("startScan.view")
        msg = "Navidrome scannt die Mediathek"
    elif s["server"] == "jellyfin":
        code, _ = _http(f"{s['url']}/Library/Refresh", method="POST", headers={"X-Emby-Token": s["secret"]})
        if code not in (200, 204):
            raise RuntimeError(f"Jellyfin antwortet mit HTTP {code}")
        msg = "Jellyfin aktualisiert die Mediathek"
    else:
        code, _ = _http(f"{s['url']}/library/sections/all/refresh?" + urlencode({"X-Plex-Token": s["secret"]}))
        if code not in (200, 204):
            raise RuntimeError(f"Plex antwortet mit HTTP {code}")
        msg = "Plex aktualisiert die Mediathek"
    with _lock:
        s["last_scan"], s["last_error"] = time.time(), None
        _save()
    return msg


def _rescan_quiet() -> None:
    try:
        log.info(rescan())
    except Exception as e:  # noqa: BLE001
        log.warning("Mediathek-Scan fehlgeschlagen: %s", e)
        with _lock:
            settings()["last_error"] = str(e)
            _save()


def schedule_rescan() -> None:
    """Viele Exporte kurz hintereinander → nur ein Scan (nach 20 s Ruhe)."""
    global _timer
    if settings()["server"] == "none":
        return
    with _lock:
        if _timer:
            _timer.cancel()
        _timer = threading.Timer(RESCAN_DELAY, _rescan_quiet)
        _timer.daemon = True
        _timer.start()

