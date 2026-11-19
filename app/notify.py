"""Benachrichtigungen pro Benutzer – die Android-App holt sie ab und zeigt sie als Push an,
im Browser erscheinen sie live als Hinweis (über /api/events).
"""
from __future__ import annotations

import json
import threading
import time
from typing import Any, Callable

from . import config

FILE = config.STATE_DIR / "notifications.json"
PER_USER = 100
MAX_AGE = 30 * 86400

_lock = threading.Lock()
_data: dict[str, Any] | None = None
listeners: list[Callable[[str, dict[str, Any]], None]] = []   # (benutzer, nachricht) → z. B. SSE


def _load() -> dict[str, Any]:
    global _data
    if _data is None:
        try:
            _data = json.loads(FILE.read_text("utf-8"))
        except (OSError, ValueError):
            _data = {}
        _data.setdefault("seq", 0)
        _data.setdefault("users", {})
    return _data


def _save() -> None:
    FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(_load(), ensure_ascii=False), "utf-8")
    tmp.replace(FILE)


def send(username: str, title: str, body: str = "", kind: str = "info", link: str = "") -> dict[str, Any]:
    with _lock:
        d = _load()
        d["seq"] += 1
        msg = {"id": d["seq"], "ts": time.time(), "title": title[:120], "body": body[:400], "kind": kind,
               "link": link[:200], "read": False}
        lst = d["users"].setdefault(username.lower(), [])
        lst.append(msg)
        cutoff = time.time() - MAX_AGE
        d["users"][username.lower()] = [m for m in lst if m["ts"] >= cutoff][-PER_USER:]
        _save()
    for fn in listeners:
        try:
            fn(username.lower(), msg)
        except Exception:  # noqa: BLE001
            pass
    return msg


def send_admins(users, title: str, body: str = "", kind: str = "info", link: str = "") -> None:
    for u in users.list():
        if u.is_admin:
            send(u.username, title, body, kind, link)


def list_for(username: str, after: int = 0) -> dict[str, Any]:
    with _lock:
        d = _load()
        lst = d["users"].get(username.lower(), [])
        return {"notifications": [m for m in lst if m["id"] > after][-50:], "latest": d["seq"],
                "unread": sum(1 for m in lst if not m["read"])}


def mark_read(username: str, upto: int | None = None) -> None:
    with _lock:
        for m in _load()["users"].get(username.lower(), []):
            if upto is None or m["id"] <= upto:
                m["read"] = True
        _save()


def clear(username: str) -> None:
    with _lock:
        _load()["users"].pop(username.lower(), None)
        _save()
