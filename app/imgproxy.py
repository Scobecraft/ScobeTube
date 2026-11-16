"""Bilder-Proxy: Vorschaubilder werden vom Server geladen statt direkt vom Browser.

So erfahren YouTube, Spotify & Co. nicht die IP-Adressen der Nutzer (Datenschutz).
Abgesichert gegen Missbrauch: nur vom Server signierte Adressen, keine internen Netze,
nur Bilder, Größenlimit, Zwischenspeicher mit Ablaufzeit.
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import secrets
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from urllib.parse import quote, urlparse

from . import config

MAX_BYTES = 8 * 1024 * 1024
CACHE_DAYS = 7
_key: bytes | None = None


def _secret() -> bytes:
    global _key
    if _key is None:
        path = config.STATE_DIR / "img.key"
        try:
            _key = path.read_bytes()
        except OSError:
            _key = secrets.token_bytes(32)
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(_key)
                path.chmod(0o600)
            except OSError:
                pass
    return _key


def sign(url: str) -> str:
    return hmac.new(_secret(), url.encode(), hashlib.sha256).hexdigest()[:32]


def wrap(url: str | None) -> str | None:
    """Externe Bild-URL → signierte Proxy-URL. Lokale/leere URLs bleiben unverändert."""
    if not url or not url.startswith(("http://", "https://")):
        return url
    return f"api/img?u={quote(url, safe='')}&s={sign(url)}"


def valid(url: str, signature: str) -> bool:
    return bool(url) and hmac.compare_digest(sign(url), signature or "")


def _check_host(host: str) -> None:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise ValueError("Host nicht gefunden") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise ValueError("Interne Adressen sind nicht erlaubt")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # Weiterleitungen selbst prüfen
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def _cache_paths(url: str) -> tuple[Path, Path]:
    h = hashlib.sha256(url.encode()).hexdigest()
    d = config.STATE_DIR / "imgcache" / h[:2]
    return d / h, d / (h + ".json")


def fetch(url: str) -> tuple[bytes, str]:
    data_path, meta_path = _cache_paths(url)
    try:
        if time.time() - data_path.stat().st_mtime < CACHE_DAYS * 86400:
            return data_path.read_bytes(), json.loads(meta_path.read_text())["type"]
    except (OSError, ValueError, KeyError):
        pass

    current = url
    for _ in range(4):
        parsed = urlparse(current)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError("Ungültige Adresse")
        _check_host(parsed.hostname)
        req = urllib.request.Request(current, headers={"User-Agent": "Mozilla/5.0 (compatible; ScobeTube)",
                                                       "Accept": "image/*"})
        try:
            resp = _opener.open(req, timeout=12)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get("Location"):
                current = urllib.parse.urljoin(current, e.headers["Location"])
                continue
            raise ValueError(f"Bild nicht verfügbar ({e.code})") from e
        with resp:
            ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if not ctype.startswith("image/") or ctype == "image/svg+xml":
                raise ValueError("Kein Bild")
            data = resp.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                raise ValueError("Bild zu groß")
        try:
            data_path.parent.mkdir(parents=True, exist_ok=True)
            data_path.write_bytes(data)
            meta_path.write_text(json.dumps({"type": ctype, "url": url}))
        except OSError:
            pass
        return data, ctype
    raise ValueError("Zu viele Weiterleitungen")


def cleanup() -> int:
    root = config.STATE_DIR / "imgcache"
    cutoff = time.time() - CACHE_DAYS * 86400
    n = 0
    for p in root.rglob("*") if root.exists() else []:
        try:
            if p.is_file() and p.stat().st_mtime < cutoff:
                p.unlink()
                n += 1
        except OSError:
            pass
    return n
