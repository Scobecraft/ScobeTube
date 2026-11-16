"""Verteilung der Android-App: aktuelle APK bereitstellen, hochladen oder automatisch von GitHub holen."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import tempfile
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any

from . import config

log = logging.getLogger("scobetube.app")

APP_PACKAGE = "de.scobecraft.scobetube"
MAX_APK = 200 * 1024 * 1024
PULL_EVERY = 6 * 3600
# Öffentliches GitHub-Repo, dessen Releases (Tag „app-v1.2.3“ mit .apk) automatisch geholt werden. Leer = aus.
RELEASE_REPO = os.environ.get("APP_RELEASE_REPO", "Scobecraft/ScobeTube").strip()

_lock = threading.Lock()


def _dir() -> Path:
    d = config.STATE_DIR / "app"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _apk() -> Path:
    return _dir() / "scobetube.apk"


def _meta_path() -> Path:
    return _dir() / "app.json"


def _meta() -> dict[str, Any]:
    try:
        return json.loads(_meta_path().read_text("utf-8"))
    except (OSError, ValueError):
        return {}


def code_from_name(name: str) -> int:
    """1.2.3 → 10203 (gleiche Formel wie im Android-Build)."""
    parts = [int(re.sub(r"\D", "", p) or 0) for p in name.split(".")[:3]] + [0, 0, 0]
    return parts[0] * 10000 + parts[1] * 100 + parts[2]


def info() -> dict[str, Any]:
    m = _meta()
    available = _apk().is_file() and bool(m.get("version_code"))
    return {
        "available": available,
        "version_name": m.get("version_name"), "version_code": m.get("version_code"),
        "notes": m.get("notes") or "", "size": m.get("size"), "sha256": m.get("sha256"),
        "updated": m.get("updated"), "source": m.get("source"), "tag": m.get("tag"),
        "download": "app/download", "repo": RELEASE_REPO or None,
    }


def apk_path() -> Path | None:
    p = _apk()
    return p if p.is_file() else None


def _read_manifest(path: Path) -> tuple[str, int, str]:
    from pyaxmlparser import APK  # erst hier laden (schwergewichtig)
    logging.getLogger("pyaxmlparser").setLevel(logging.ERROR)
    a = APK(str(path))
    if not a.is_valid_APK():
        raise ValueError("Die Datei ist keine gültige Android-App (APK)")
    return a.package, int(a.version_code or 0), str(a.version_name or "")


def store(data: bytes, notes: str = "", source: str = "Upload", tag: str | None = None,
          allow_same: bool = True) -> dict[str, Any]:
    if len(data) > MAX_APK:
        raise ValueError("Die APK ist zu groß")
    if not data.startswith(b"PK"):
        raise ValueError("Das ist keine APK-Datei")
    with _lock:
        with tempfile.NamedTemporaryFile(dir=_dir(), suffix=".apk", delete=False) as tmp:
            tmp.write(data)
            tmp_path = Path(tmp.name)
        try:
            package, code, name = _read_manifest(tmp_path)
            if package != APP_PACKAGE:
                raise ValueError(f"Falsche App ({package}) – erwartet wird {APP_PACKAGE}")
            current = _meta().get("version_code") or 0
            if code < current or (code == current and not allow_same):
                raise ValueError(f"Version {name} ist nicht neuer als die aktuelle Version")
            meta = {"version_name": name, "version_code": code, "notes": notes.strip()[:5000],
                    "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                    "updated": time.time(), "source": source, "tag": tag}
            os.replace(tmp_path, _apk())
            tmp_meta = _meta_path().with_suffix(".tmp")
            tmp_meta.write_text(json.dumps(meta, ensure_ascii=False, indent=1), "utf-8")
            os.replace(tmp_meta, _meta_path())
            log.info("Android-App %s (%d) bereitgestellt – Quelle: %s", name, code, source)
            return info()
        finally:
            tmp_path.unlink(missing_ok=True)


def _get(url: str, limit: int) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "ScobeTube", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310 – feste GitHub-Hosts
        data = r.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Antwort zu groß")
    return data


def pull_github() -> dict[str, Any]:
    """Prüft die GitHub-Releases auf eine neuere APK und holt sie. Gibt {updated, info, message} zurück."""
    if not RELEASE_REPO:
        return {"updated": False, "message": "Automatisches Holen ist ausgeschaltet (APP_RELEASE_REPO leer)"}
    releases = json.loads(_get(f"https://api.github.com/repos/{RELEASE_REPO}/releases?per_page=15", 2_000_000))
    current = _meta().get("version_code") or 0
    for rel in releases:
        if rel.get("draft") or rel.get("prerelease"):
            continue
        tag = rel.get("tag_name") or ""
        if not tag.startswith("app-v"):
            continue
        asset = next((a for a in rel.get("assets") or [] if a.get("name", "").endswith(".apk")), None)
        if not asset:
            continue
        if code_from_name(tag[5:]) <= current:
            return {"updated": False, "message": f"Aktuell – neueste Version auf GitHub ist {tag[5:]}"}
        data = _get(asset["browser_download_url"], MAX_APK)
        new = store(data, notes=rel.get("body") or "", source="GitHub", tag=tag, allow_same=False)
        return {"updated": True, "message": f"Version {new['version_name']} von GitHub geholt", "info": new}
    return {"updated": False, "message": "Auf GitHub gibt es noch kein App-Release (Tag „app-v…“ mit APK)"}


async def run() -> None:
    await asyncio.sleep(30)
    while True:
        if RELEASE_REPO:
            try:
                res = await asyncio.to_thread(pull_github)
                if res.get("updated"):
                    log.info(res["message"])
            except Exception as e:  # noqa: BLE001
                log.info("App-Release-Prüfung bei GitHub fehlgeschlagen: %s", e)
        await asyncio.sleep(PULL_EVERY)
