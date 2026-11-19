"""Aktivitätsprotokoll für Admins: Anmeldungen, Fehlversuche, Downloads, Admin-Aktionen.

Einträge liegen als JSON-Zeilen in STATE_DIR/audit.log und werden nach einer einstellbaren
Anzahl Tage automatisch gelöscht (Standard 30).
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Any

from . import config

log = logging.getLogger("scobetube.audit")

LOG_FILE = config.STATE_DIR / "audit.log"
SETTINGS_FILE = config.STATE_DIR / "audit.json"
RETENTION_CHOICES = (7, 30, 90, 180, 365)
MAX_ENTRIES = 50_000

# Kategorien für den Filter in der Oberfläche
CATEGORIES = {
    "login": "Anmeldung",
    "login_failed": "Fehlversuch",
    "download": "Download",
    "file": "Dateien",
    "security": "Sicherheit",
    "admin": "Admin",
    "quota": "Speicher",
}

_lock = threading.Lock()
_retention: int | None = None
_seq = 0


def _env_days() -> int:
    try:
        return max(1, int(os.environ.get("AUDIT_DAYS", "30")))
    except ValueError:
        return 30


def retention_days() -> int:
    global _retention
    if _retention is None:
        try:
            _retention = int(json.loads(SETTINGS_FILE.read_text("utf-8")).get("days", _env_days()))
        except (OSError, ValueError, TypeError):
            _retention = _env_days()
    return _retention


def set_retention(days: int) -> int:
    global _retention
    if days not in RETENTION_CHOICES:
        raise ValueError("Ungültige Aufbewahrungsdauer")
    _retention = days
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps({"days": days}), "utf-8")
    prune()
    return days


def record(category: str, action: str, user: str | None = None, ip: str | None = None,
           detail: str | None = None, target: str | None = None) -> None:
    """Eintrag schreiben – Fehler beim Schreiben dürfen die eigentliche Aktion nie stören."""
    global _seq
    with _lock:
        _seq += 1
        entry = {"id": f"{time.time_ns():x}{_seq % 4096:03x}", "ts": time.time(), "cat": category, "action": action,
                 "user": user or None, "ip": ip or None, "target": target or None,
                 "detail": (detail or "")[:500] or None}
        try:
            LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
            with LOG_FILE.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            os.chmod(LOG_FILE, 0o600)
        except OSError as e:
            log.warning("Aktivitätsprotokoll nicht schreibbar: %s", e)


def _read() -> list[dict[str, Any]]:
    try:
        lines = LOG_FILE.read_text("utf-8").splitlines()
    except OSError:
        return []
    out = []
    for ln in lines:
        try:
            out.append(json.loads(ln))
        except ValueError:
            continue
    return out


def query(*, user: str = "", category: str = "", q: str = "", before: str = "", limit: int = 100) -> dict[str, Any]:
    with _lock:
        entries = _read()
    entries.reverse()   # neueste zuerst
    user_l, q_l = user.lower(), q.lower()
    out, more = [], False
    for e in entries:
        if before and e.get("id", "") >= before:
            continue
        if user_l and (e.get("user") or "").lower() != user_l and (e.get("target") or "").lower() != user_l:
            continue
        if category and e.get("cat") != category:
            continue
        if q_l and q_l not in " ".join(str(e.get(k) or "") for k in ("action", "detail", "user", "ip", "target")).lower():
            continue
        if len(out) >= limit:
            more = True
            break
        out.append(e)
    return {"entries": out, "more": more, "days": retention_days(), "total": len(entries)}


def prune() -> int:
    """Alte Einträge entfernen (Aufbewahrungsdauer) und die Datei klein halten."""
    cutoff = time.time() - retention_days() * 86400
    with _lock:
        entries = _read()
        keep = [e for e in entries if e.get("ts", 0) >= cutoff][-MAX_ENTRIES:]
        removed = len(entries) - len(keep)
        if removed:
            tmp = LOG_FILE.with_suffix(".tmp")
            tmp.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in keep), "utf-8")
            os.chmod(tmp, 0o600)
            tmp.replace(LOG_FILE)
    return removed


def clear() -> None:
    with _lock:
        try:
            LOG_FILE.unlink()
        except FileNotFoundError:
            pass


def recent_failures(username: str, window: float = 3600) -> int:
    """Wie viele Fehlversuche gab es für dieses Konto in der letzten Stunde?"""
    cutoff = time.time() - window
    name = username.lower()
    with _lock:
        entries = _read()
    return sum(1 for e in entries if e.get("cat") == "login_failed" and e.get("ts", 0) >= cutoff
               and (e.get("target") or "").lower() == name)
