"""Speicher-Kontingente: Jeder Benutzer darf standardmäßig 10 GB auf dem Server belegen
(Admins unbegrenzt). Wer mehr braucht, schickt eine Anfrage an die Admins.
"""
from __future__ import annotations

import json
import os
import secrets
import threading
import time
from typing import Any

from . import config

GB = 1024 ** 3
FILE = config.STATE_DIR / "quota_requests.json"

try:
    DEFAULT_GB = max(0.0, float(os.environ.get("QUOTA_GB", "10")))
except ValueError:
    DEFAULT_GB = 10.0

_lock = threading.Lock()
_reqs: list[dict[str, Any]] | None = None


def limit_bytes(user) -> int | None:
    """None = unbegrenzt."""
    if user is None or user.is_admin:
        return None
    gb = user.quota_gb if user.quota_gb is not None else DEFAULT_GB
    return None if gb <= 0 else int(gb * GB)


def info(user, used: int) -> dict[str, Any]:
    lim = limit_bytes(user)
    return {"limit": lim, "used": used, "default_gb": DEFAULT_GB,
            "custom": user.quota_gb is not None, "quota_gb": user.quota_gb,
            "full": lim is not None and used >= lim, "pending": pending_for(user.username)}


# ------------------------------------------------------------- anfragen
def _load() -> list[dict[str, Any]]:
    global _reqs
    if _reqs is None:
        try:
            _reqs = json.loads(FILE.read_text("utf-8"))
        except (OSError, ValueError):
            _reqs = []
    return _reqs


def _save() -> None:
    FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(_load(), ensure_ascii=False), "utf-8")
    tmp.replace(FILE)


def pending_for(username: str) -> dict[str, Any] | None:
    with _lock:
        return next((r for r in _load() if r["user"].lower() == username.lower() and r["status"] == "pending"), None)


def request(username: str, gb: float, reason: str) -> dict[str, Any]:
    if not 1 <= gb <= 10_000:
        raise ValueError("Bitte zwischen 1 und 10000 GB angeben")
    if pending_for(username):
        raise ValueError("Du hast schon eine offene Anfrage")
    with _lock:
        r = {"id": secrets.token_hex(6), "user": username, "gb": round(gb, 1), "reason": reason.strip()[:300],
             "created": time.time(), "status": "pending", "decided_by": None, "decided_at": None, "granted_gb": None}
        _load().append(r)
        del _load()[:-500]
        _save()
        return r


def cancel(username: str) -> bool:
    with _lock:
        for r in _load():
            if r["user"].lower() == username.lower() and r["status"] == "pending":
                r["status"] = "cancelled"
                r["decided_at"] = time.time()
                _save()
                return True
    return False


def list_requests(only_pending: bool = False) -> list[dict[str, Any]]:
    with _lock:
        rows = [r for r in _load() if not only_pending or r["status"] == "pending"]
    return sorted(rows, key=lambda r: r["created"], reverse=True)[:100]


def decide(req_id: str, admin: str, approve: bool, granted_gb: float | None = None) -> dict[str, Any]:
    with _lock:
        r = next((r for r in _load() if r["id"] == req_id), None)
        if not r:
            raise KeyError(req_id)
        if r["status"] != "pending":
            raise ValueError("Diese Anfrage wurde schon bearbeitet")
        r["status"] = "approved" if approve else "rejected"
        r["decided_by"], r["decided_at"] = admin, time.time()
        r["granted_gb"] = (granted_gb or r["gb"]) if approve else None
        _save()
        return dict(r)
