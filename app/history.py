"""Download-Verlauf pro Benutzer – bleibt auch, wenn die Datei längst automatisch gelöscht wurde.
Jeder Benutzer kann einzelne Einträge oder den ganzen Verlauf löschen und das Aufzeichnen abschalten.
"""
from __future__ import annotations

import json
import threading
import time
from typing import Any

from . import config, imgproxy

FILE = config.STATE_DIR / "history.json"
PER_USER = 3000

_lock = threading.Lock()
_data: dict[str, Any] | None = None


def _load() -> dict[str, Any]:
    global _data
    if _data is None:
        try:
            _data = json.loads(FILE.read_text("utf-8"))
        except (OSError, ValueError):
            _data = {}
    return _data


def _save() -> None:
    FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(_load(), ensure_ascii=False), "utf-8")
    tmp.replace(FILE)


def _user(name: str) -> dict[str, Any]:
    return _load().setdefault(name.lower(), {"enabled": True, "entries": []})


def enabled(name: str) -> bool:
    with _lock:
        return _load().get(name.lower(), {}).get("enabled", True)


def add(item) -> None:
    if not item.owner:
        return
    with _lock:
        u = _user(item.owner)
        if not u.get("enabled", True):
            return
        sp = item.spotify or {}
        entry = {
            "id": item.id, "ts": item.finished or time.time(), "title": item.title or item.url, "url": item.url,
            "source": item.source, "kind": item.options.kind, "format": item.options.format,
            "quality": item.options.quality, "uploader": item.uploader, "duration": item.duration,
            "thumbnail": item.thumbnail if (item.thumbnail or "").startswith("http") else None,
            "filesize": item.filesize, "artist": ", ".join(sp.get("artists") or []) or None,
        }
        u["entries"] = [e for e in u["entries"] if e["id"] != item.id]
        u["entries"].append(entry)
        u["entries"] = u["entries"][-PER_USER:]
        _save()


def list_for(name: str, q: str = "", kind: str = "", offset: int = 0, limit: int = 60) -> dict[str, Any]:
    with _lock:
        u = _load().get(name.lower(), {"enabled": True, "entries": []})
        entries = list(reversed(u["entries"]))
        enabled_ = u.get("enabled", True)
    ql = q.lower().strip()
    if ql:
        entries = [e for e in entries if ql in f"{e.get('title')} {e.get('uploader')} {e.get('artist')} {e.get('url')}".lower()]
    if kind in ("video", "audio"):
        entries = [e for e in entries if e.get("kind") == kind]
    page = entries[offset:offset + limit]
    return {"entries": [{**e, "thumbnail": imgproxy.wrap(e.get("thumbnail"))} for e in page],
            "total": len(entries), "more": offset + limit < len(entries), "enabled": enabled_}


def delete(name: str, entry_id: str) -> bool:
    with _lock:
        u = _user(name)
        before = len(u["entries"])
        u["entries"] = [e for e in u["entries"] if e["id"] != entry_id]
        _save()
        return len(u["entries"]) != before


def get(name: str, entry_id: str) -> dict[str, Any] | None:
    with _lock:
        return next((e for e in _load().get(name.lower(), {}).get("entries", []) if e["id"] == entry_id), None)


def clear(name: str) -> int:
    with _lock:
        u = _user(name)
        n = len(u["entries"])
        u["entries"] = []
        _save()
        return n


def set_enabled(name: str, on: bool) -> None:
    with _lock:
        _user(name)["enabled"] = bool(on)
        _save()


def forget_user(name: str) -> None:
    with _lock:
        _load().pop(name.lower(), None)
        _save()
