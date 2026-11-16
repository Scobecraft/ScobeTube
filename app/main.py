"""ScobeTube – Web-API und Oberfläche."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import re
import shutil
import subprocess
import zipfile
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode, urlparse

import yt_dlp
from fastapi import APIRouter, FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import config
from . import tags
from .sysmon import sysmon
from .auth import COOKIE_NAME, PERMISSIONS, User, limiter, users
from .downloader import (AUDIO_FORMATS, AUDIO_QUALITIES, SEARCH_PREFIX, VIDEO_FORMATS, VIDEO_QUALITIES, Item,
                         Options, manager)
from .downloader import search as search_media

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("scobetube")

STATIC_DIR = Path(__file__).parent / "static"
URL_RE = re.compile(r"https?://[^\s<>\"']+", re.I)

# scrypt braucht ~64 MB RAM pro Prüfung – parallele Prüfungen begrenzen
_hash_slots = asyncio.Semaphore(2)
_setup_lock = asyncio.Lock()


STARTED_AT = time.time()


async def _cleanup_loop() -> None:
    while True:
        try:
            await asyncio.to_thread(manager.cleanup_expired)
        except Exception as e:  # noqa: BLE001
            log.error("Auto-Löschung fehlgeschlagen: %s", e)
        await asyncio.sleep(300)


def _container_uptime() -> float | None:
    """Laufzeit des Containers = Alter von Prozess 1 (im Docker-Container: tini).

    Übersteht auch Neustarts von ScobeTube selbst (z. B. nach einem yt-dlp-Update).
    """
    try:
        boot_uptime = float(Path("/proc/uptime").read_text().split()[0])
        stat = Path("/proc/1/stat").read_text()
        # Feld 22 = Startzeit in Ticks seit Systemstart (Felder nach dem Prozessnamen in Klammern zählen)
        start_ticks = int(stat.rsplit(")", 1)[1].split()[19])
        return max(0.0, boot_uptime - start_ticks / os.sysconf("SC_CLK_TCK"))
    except (OSError, ValueError, IndexError):
        return None


@asynccontextmanager
async def lifespan(_: FastAPI):
    config.STATE_DIR.mkdir(parents=True, exist_ok=True)
    users.load()
    manager.start(asyncio.get_running_loop())
    cleaner = asyncio.create_task(_cleanup_loop())
    monitor = asyncio.create_task(sysmon.run())
    log.info("ScobeTube %s gestartet – yt-dlp %s – Downloads: %s – Auto-Löschung: %s",
             config.APP_VERSION, yt_dlp.version.__version__, config.DOWNLOAD_DIR,
             f"{config.RETENTION_HOURS:g} Std." if config.RETENTION_HOURS else "aus")
    yield
    cleaner.cancel()
    monitor.cancel()
    manager.save()


app = FastAPI(title="ScobeTube", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
api = APIRouter(prefix="/api")


# ------------------------------------------------------- sicherheit
PUBLIC_PATHS = {"/login", "/healthz", "/manifest.webmanifest", "/api/auth/status", "/api/auth/login",
                "/api/auth/setup"}
PUBLIC_STATIC = {"/static/style.css", "/static/login.css", "/static/login.js", "/static/icon.svg"}
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

CSP = ("default-src 'self'; "
       "script-src 'self'; "
       "style-src 'self' https://fonts.googleapis.com; "
       "font-src 'self' https://fonts.gstatic.com; "
       "img-src 'self' data: blob: https:; "
       "connect-src 'self'; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'")
SECURITY_HEADERS = {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
}


def _local_path(request: Request) -> str:
    path = request.url.path
    root = request.scope.get("root_path", "")
    if root and path.startswith(root):
        path = path[len(root):] or "/"
    return path


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "?"


def _same_origin(request: Request) -> bool:
    """Schutz vor CSRF: schreibende Anfragen müssen von unserer eigenen Seite kommen."""
    if request.headers.get("x-scobetube") != "1":
        return False
    if request.headers.get("sec-fetch-site", "same-origin") not in ("same-origin", "none"):
        return False
    origin = request.headers.get("origin")
    if origin:
        host = request.headers.get("host", "")
        if urlparse(origin).netloc.lower() != host.lower():
            return False
    return True


@app.middleware("http")
async def security(request: Request, call_next):
    path = _local_path(request)
    request.state.user = None
    request.state.session_key = None

    if request.method in UNSAFE_METHODS and not _same_origin(request):
        response: Response = JSONResponse({"detail": "Anfrage abgelehnt (CSRF-Schutz)"}, status_code=403)
    else:
        user, key = users.session_user(request.cookies.get(COOKIE_NAME))
        request.state.user, request.state.session_key = user, key
        public = path in PUBLIC_PATHS or path in PUBLIC_STATIC
        if user or public:
            response = await call_next(request)
        elif path.startswith("/api/") or path.startswith("/static/"):
            response = JSONResponse({"detail": "Nicht angemeldet"}, status_code=401)
        else:
            # relative Weiterleitung – funktioniert auch hinter einem URL-Präfix
            target = "login"
            if path == "/" and request.url.query:
                target += "?" + urlencode({"next": request.url.query})
            response = RedirectResponse(target, status_code=303)
    for k, v in SECURITY_HEADERS.items():
        response.headers.setdefault(k, v)
    if path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    return response


def _user(request: Request) -> User:
    user = request.state.user
    if not user:
        raise HTTPException(401, "Nicht angemeldet")
    return user


def _need(request: Request, perm: str) -> User:
    user = _user(request)
    if not user.has(perm):
        raise HTTPException(403, f"Dafür fehlt dir das Recht „{PERMISSIONS[perm]}“")
    return user


def _visible(user: User):
    if user.has("view_all"):
        return lambda item: True
    name = user.username.lower()
    return lambda item: (item.owner or "").lower() == name


def _item_for(user: User, item_id: str) -> Item:
    item = manager.get(item_id)
    if not item or not _visible(user)(item):
        raise HTTPException(404, "Nicht gefunden")
    return item


def _set_session_cookie(request: Request, response: Response, token: str, ttl: int | None) -> None:
    secure = config.COOKIE_SECURE == "true" or (config.COOKIE_SECURE == "auto" and request.url.scheme == "https")
    response.set_cookie(COOKIE_NAME, token, max_age=ttl, httponly=True, secure=secure, samesite="strict",
                        path=(config.URL_PREFIX or "") + "/")


async def _json(request: Request) -> dict[str, Any]:
    try:
        data = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(400, "Ungültige Anfrage") from None
    if not isinstance(data, dict):
        raise HTTPException(400, "Ungültige Anfrage")
    return data


_EMPTY_USAGE = {"downloads": 0, "bytes_total": 0, "files_now": 0, "bytes_now": 0}


def _me(user: User) -> dict[str, Any]:
    usage = manager.usage().get(user.username.lower(), _EMPTY_USAGE)
    return {**user.public(), "effective": user.effective_permissions(), "usage": usage}


# ------------------------------------------------------------ anmeldung
@api.get("/auth/status")
async def auth_status(request: Request):
    user = request.state.user
    return {"setup": users.needs_setup, "user": _me(user) if user else None}


@api.post("/auth/setup")
async def auth_setup(request: Request):
    data = await _json(request)
    async with _setup_lock:
        if not users.needs_setup:
            raise HTTPException(409, "Es gibt bereits einen Administrator")
        try:
            async with _hash_slots:
                user = await asyncio.to_thread(users.create, str(data.get("username", "")).strip(),
                                               str(data.get("password", "")), ["admin"])
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
    log.info("Admin-Konto „%s“ eingerichtet (IP %s)", user.username, _client_ip(request))
    token, ttl = users.create_session(user, False, _client_ip(request), request.headers.get("user-agent", ""))
    response = JSONResponse({"ok": True, "user": _me(user)})
    _set_session_cookie(request, response, token, None)
    return response


@api.post("/auth/login")
async def auth_login(request: Request):
    data = await _json(request)
    username = str(data.get("username", "")).strip()[:64]
    password = str(data.get("password", ""))[:512]
    remember = bool(data.get("remember"))
    ip = _client_ip(request)

    wait = limiter.retry_after(ip, username)
    if wait:
        mins = max(1, round(wait / 60))
        raise HTTPException(429, f"Zu viele Fehlversuche. Bitte in {mins} Minute{'n' if mins != 1 else ''} erneut versuchen.")
    async with _hash_slots:
        user = await asyncio.to_thread(users.authenticate, username, password)
    if not user:
        limiter.failed(ip, username)
        log.warning("Fehlgeschlagene Anmeldung für „%s“ von %s", username, ip)
        await asyncio.sleep(random.uniform(0.4, 0.9))
        raise HTTPException(401, "Benutzername oder Passwort falsch")
    limiter.succeeded(ip, username)
    token, ttl = users.create_session(user, remember, ip, request.headers.get("user-agent", ""))
    log.info("Anmeldung: %s von %s", user.username, ip)
    response = JSONResponse({"ok": True, "user": _me(user)})
    _set_session_cookie(request, response, token, ttl if remember else None)
    return response


@api.post("/auth/logout")
async def auth_logout(request: Request):
    if request.state.session_key:
        users.revoke(request.state.session_key)
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE_NAME, path=(config.URL_PREFIX or "") + "/")
    return response


@api.get("/auth/me")
async def auth_me(request: Request):
    return {"user": _me(_user(request)), "permissions": PERMISSIONS}


@api.post("/auth/password")
async def change_password(request: Request):
    user = _user(request)
    data = await _json(request)
    current, new = str(data.get("current", "")), str(data.get("new", ""))
    async with _hash_slots:
        ok = await asyncio.to_thread(users.authenticate, user.username, current)
    if not ok:
        await asyncio.sleep(random.uniform(0.4, 0.9))
        raise HTTPException(400, "Das aktuelle Passwort ist falsch")
    try:
        async with _hash_slots:
            await asyncio.to_thread(users.update, user.username, password=new)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    # Alle Sitzungen wurden beendet – hier direkt neu anmelden
    token, ttl = users.create_session(user, False, _client_ip(request), request.headers.get("user-agent", ""))
    response = JSONResponse({"ok": True})
    _set_session_cookie(request, response, token, None)
    return response


# ---------------------------------------------------- benutzerverwaltung
@api.get("/users")
async def list_users(request: Request):
    _need(request, "admin")
    usage = manager.usage()
    rows = [{**u.public(), "usage": usage.get(u.username.lower(), _EMPTY_USAGE)} for u in users.list()]
    known = {u.username.lower() for u in users.list()}
    # Downloads gelöschter Konten trotzdem mitzählen
    deleted = {"downloads": 0, "bytes_total": 0, "files_now": 0, "bytes_now": 0}
    for name, u in usage.items():
        if name not in known:
            for k in deleted:
                deleted[k] += u.get(k, 0)
    return {"users": rows, "permissions": PERMISSIONS, "deleted_users": deleted}


@api.post("/users")
async def create_user(request: Request):
    admin = _need(request, "admin")
    data = await _json(request)
    try:
        async with _hash_slots:
            user = await asyncio.to_thread(users.create, str(data.get("username", "")).strip(),
                                           str(data.get("password", "")), data.get("permissions", []))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    log.info("%s hat Benutzer „%s“ angelegt", admin.username, user.username)
    return user.public()


@api.patch("/users/{username}")
async def update_user(username: str, request: Request):
    admin = _need(request, "admin")
    data = await _json(request)
    if username.lower() == admin.username.lower() and (data.get("disabled") or
                                                       ("permissions" in data and "admin" not in data["permissions"])):
        raise HTTPException(400, "Du kannst dich nicht selbst sperren oder dir die Admin-Rechte nehmen")
    try:
        async with _hash_slots:
            user = await asyncio.to_thread(
                users.update, username,
                permissions=data.get("permissions") if "permissions" in data else None,
                disabled=data.get("disabled") if "disabled" in data else None,
                password=str(data["password"]) if data.get("password") else None)
    except KeyError:
        raise HTTPException(404, "Benutzer nicht gefunden") from None
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    log.info("%s hat Benutzer „%s“ geändert", admin.username, user.username)
    return user.public()


@api.delete("/users/{username}")
async def delete_user(username: str, request: Request):
    admin = _need(request, "admin")
    if username.lower() == admin.username.lower():
        raise HTTPException(400, "Du kannst dich nicht selbst löschen")
    try:
        users.delete(username)
    except KeyError:
        raise HTTPException(404, "Benutzer nicht gefunden") from None
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    log.info("%s hat Benutzer „%s“ gelöscht", admin.username, username)
    return {"ok": True}


# ------------------------------------------------------------------ api
@api.get("/info")
async def info(request: Request):
    _user(request)
    return {
        "version": config.APP_VERSION,
        "ytdlp": yt_dlp.version.__version__,
        "ytdlp_channel": config.YTDLP_CHANNEL,
        "cookies": config.COOKIES_FILE.is_file(),
        "max_concurrent": config.MAX_CONCURRENT,
        "retention_hours": config.RETENTION_HOURS,
        "started_at": STARTED_AT,
        "server_time": time.time(),
        "container_uptime": _container_uptime(),
        "formats": {
            "video": {"formats": VIDEO_FORMATS, "qualities": VIDEO_QUALITIES},
            "audio": {"formats": AUDIO_FORMATS, "qualities": AUDIO_QUALITIES},
        },
    }


@api.get("/items")
async def items(request: Request):
    return manager.snapshot(_visible(_user(request)))


def _extract_urls(text: str) -> list[str]:
    urls = URL_RE.findall(text or "")
    seen, out = set(), []
    for u in urls:
        u = u.rstrip(".,;)")
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out[:200]


@api.post("/add")
async def add(request: Request):
    user = _need(request, "download")
    data = await _json(request)
    urls = _extract_urls(str(data.get("urls") or data.get("url") or ""))
    if not urls:
        raise HTTPException(400, "Keine gültige URL gefunden")
    try:
        options = Options.parse(data)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    created = manager.add(urls, options, owner=user.username)
    return {"added": [i.id for i in created]}


@api.get("/add")
async def add_get(url: str = "", kind: str = "", format: str = "", quality: str = ""):
    """Lesezeichen / Kurzbefehle: füllt nur das Formular aus – gestartet wird per Klick (CSRF-sicher)."""
    params = {k: v for k, v in {"url": url, "kind": kind, "format": format, "quality": quality}.items() if v}
    return RedirectResponse("../?" + urlencode(params), status_code=303)


@api.get("/search")
async def search(request: Request, q: str, source: str = "soundcloud"):
    _need(request, "download")
    q = q.strip()[:200]
    if not q:
        raise HTTPException(400, "Bitte einen Suchbegriff eingeben")
    if source not in SEARCH_PREFIX:
        raise HTTPException(400, "Unbekannte Quelle")
    try:
        results = await asyncio.wait_for(asyncio.to_thread(search_media, source, q), timeout=45)
    except asyncio.TimeoutError:
        raise HTTPException(504, "Die Suche hat zu lange gedauert") from None
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Suche fehlgeschlagen: {str(e)[:300]}") from e
    return {"results": results}


@api.post("/items/{item_id}/cancel")
async def cancel(item_id: str, request: Request):
    _item_for(_need(request, "download"), item_id)
    if not manager.cancel(item_id):
        raise HTTPException(409, "Download ist nicht aktiv")
    return {"ok": True}


@api.post("/items/{item_id}/retry")
async def retry(item_id: str, request: Request):
    _item_for(_need(request, "download"), item_id)
    if not manager.retry(item_id):
        raise HTTPException(409, "Download läuft noch")
    return {"ok": True}


@api.delete("/items/{item_id}")
async def delete(item_id: str, request: Request, delete_file: bool = False):
    _item_for(_need(request, "delete"), item_id)
    manager.remove(item_id, delete_file)
    return {"ok": True}


@api.post("/clear")
async def clear(request: Request):
    user = _need(request, "delete")
    data = await _json(request)
    n = manager.clear(str(data.get("which", "done")), bool(data.get("delete_files")), _visible(user))
    return {"removed": n}


@api.get("/files/{item_id}")
async def file(item_id: str, request: Request, inline: bool = False):
    item = _item_for(_need(request, "files"), item_id)
    path = manager.file_path(item)
    if not path or not path.is_file():
        raise HTTPException(404, "Datei nicht gefunden")
    disp = "inline" if inline else "attachment"
    headers = {"Content-Disposition": f"{disp}; filename*=UTF-8''{quote(path.name)}"}
    return FileResponse(path, headers=headers)


MEDIA_TYPES = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".opus": "audio/ogg", ".ogg": "audio/ogg",
               ".flac": "audio/flac", ".wav": "audio/wav", ".mp4": "video/mp4", ".webm": "video/webm",
               ".mkv": "video/x-matroska", ".aac": "audio/aac"}


def _editable_audio(request: Request, item_id: str) -> tuple[Item, Path]:
    item = _item_for(_need(request, "download"), item_id)
    if item.status != "done":
        raise HTTPException(409, "Der Download ist noch nicht fertig")
    path = manager.file_path(item)
    if not path or not path.is_file():
        raise HTTPException(404, "Datei nicht gefunden")
    if item.options.kind != "audio" or not tags.supported(path):
        raise HTTPException(400, "Tags lassen sich nur bei Audiodateien (MP3, M4A, FLAC, Opus, WAV) bearbeiten")
    return item, path


@api.get("/items/{item_id}/meta")
async def get_meta(item_id: str, request: Request):
    _, path = _editable_audio(request, item_id)
    return await asyncio.to_thread(tags.read, path)


@api.get("/items/{item_id}/cover")
async def get_cover(item_id: str, request: Request):
    item = _item_for(_user(request), item_id)
    path = manager.file_path(item)
    found = await asyncio.to_thread(tags.read_cover, path) if path and path.is_file() else None
    if not found:
        raise HTTPException(404, "Kein Cover vorhanden")
    data, mime = found
    if mime not in ("image/jpeg", "image/png"):
        mime = "image/jpeg"
    return Response(data, media_type=mime, headers={"Cache-Control": "private, max-age=86400"})


def _clean_name(text: str) -> str:
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", text).strip(" .")
    return text[:180] or "Unbenannt"


@api.post("/items/{item_id}/meta")
async def set_meta(item_id: str, request: Request):
    item, path = _editable_audio(request, item_id)
    form = await request.form()
    field = lambda k: (str(form.get(k) or "").strip()[:300])  # noqa: E731
    title, artist, album = field("title"), field("artist"), field("album")
    rename = form.get("rename") in ("1", "true", "on")
    cover = None
    upload = form.get("cover")
    if upload is not None and hasattr(upload, "read"):
        raw = await upload.read(tags.MAX_COVER_BYTES + 1)
        if raw:
            try:
                cover = await asyncio.to_thread(tags.normalize_cover, raw)
            except ValueError as e:
                raise HTTPException(400, str(e)) from e
    try:
        await asyncio.to_thread(tags.write, path, title, artist, album, cover)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Tags konnten nicht gespeichert werden: {e}") from e

    if rename and title:
        stem = _clean_name(f"{artist} - {title}" if artist else title)
        target = path.with_name(stem + path.suffix)
        n = 2
        while target.exists() and target != path:
            target = path.with_name(f"{stem} ({n}){path.suffix}")
            n += 1
        if target != path:
            path.rename(target)
            item.filename = str(target.relative_to(config.DOWNLOAD_DIR))
            path = target
    if title:
        item.title = f"{artist} - {title}" if artist else title
    if artist:
        item.uploader = artist
    if cover:
        item.thumbnail = f"api/items/{item.id}/cover?v={int(time.time())}"
    item.filesize = path.stat().st_size
    manager._update(item)
    return item.public()


@api.get("/play/{item_id}")
async def play(item_id: str, request: Request):
    """Datei zum Abspielen im Browser (mit Spulen über Range-Anfragen)."""
    item = _item_for(_need(request, "files"), item_id)
    path = manager.file_path(item)
    if not path or not path.is_file():
        raise HTTPException(404, "Datei nicht gefunden")
    return FileResponse(path, media_type=MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream"),
                        headers={"Content-Disposition": "inline", "Cache-Control": "private, max-age=3600"})


class _ZipBuffer:
    """Nimmt die ZIP-Ausgabe auf, damit sie Stück für Stück gestreamt werden kann."""

    def __init__(self) -> None:
        self.chunks: list[bytes] = []
        self.pos = 0

    def write(self, b: bytes) -> int:
        self.chunks.append(bytes(b))
        self.pos += len(b)
        return len(b)

    def tell(self) -> int:
        return self.pos

    def flush(self) -> None:
        pass

    def take(self) -> bytes:
        data = b"".join(self.chunks)
        self.chunks.clear()
        return data


@api.get("/zip")
async def zip_download(request: Request, ids: str):
    user = _need(request, "files")
    wanted = [i for i in ids.split(",") if i][:1000]
    files: list[tuple[Path, str]] = []
    seen: set[str] = set()
    playlists = set()
    for item_id in wanted:
        item = manager.get(item_id)
        if not item or not _visible(user)(item) or item.status != "done":
            continue
        path = manager.file_path(item)
        if not path or not path.is_file():
            continue
        name = item.filename or path.name
        base, dot, ext = name.rpartition(".")
        n = 2
        while name.lower() in seen:  # doppelte Namen vermeiden
            name = f"{base} ({n}).{ext}" if dot else f"{name} ({n})"
            n += 1
        seen.add(name.lower())
        files.append((path, name))
        playlists.add(item.playlist)
    if not files:
        raise HTTPException(404, "Keine fertigen Dateien ausgewählt")

    title = next(iter(playlists)) if len(playlists) == 1 and None not in playlists else \
        "ScobeTube-" + time.strftime("%Y-%m-%d_%H-%M")
    zipname = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", title).strip(" .")[:120] + ".zip"

    def generate():
        buf = _ZipBuffer()
        # ZIP_STORED: Medien sind schon komprimiert – so geht es schnell und schont die CPU
        with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
            for path, name in files:
                info = zipfile.ZipInfo.from_file(path, arcname=name)
                with path.open("rb") as src, zf.open(info, "w", force_zip64=True) as dst:
                    while chunk := src.read(1024 * 1024):
                        dst.write(chunk)
                        if buf.pos and len(buf.chunks) > 4:
                            yield buf.take()
                yield buf.take()
        yield buf.take()

    log.info("%s lädt ZIP mit %d Dateien", user.username, len(files))
    return StreamingResponse(generate(), media_type="application/zip",
                             headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(zipname)}"})


@api.get("/events")
async def events(request: Request):
    _user(request)
    token = request.cookies.get(COOKIE_NAME)
    q = manager.subscribe()

    async def stream():
        try:
            user, _ = users.session_user(token)
            if not user:
                return
            yield _sse("init", {"items": manager.snapshot(_visible(user))})
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event, data = await asyncio.wait_for(q.get(), timeout=15)
                except asyncio.TimeoutError:
                    event, data = None, None
                # Sitzung und Rechte bei jedem Ereignis neu prüfen
                user, _ = users.session_user(token)
                if not user:
                    yield _sse("logout", {})
                    break
                if event is None:
                    yield ": ping\n\n"
                    continue
                if user.has("view_all") or (data.get("owner") or "").lower() == user.username.lower():
                    yield _sse(event, data)
        finally:
            manager.unsubscribe(q)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@api.post("/cookies")
async def upload_cookies(file: UploadFile, request: Request):
    _need(request, "settings")
    content = await file.read(5 * 1024 * 1024 + 1)
    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(400, "Datei zu groß")
    text = content.decode("utf-8", errors="replace")
    if "\t" not in text:
        raise HTTPException(400, "Das sieht nicht nach einer cookies.txt (Netscape-Format) aus")
    config.COOKIES_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(config.COOKIES_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    return {"ok": True}


@api.delete("/cookies")
async def delete_cookies(request: Request):
    _need(request, "settings")
    config.COOKIES_FILE.unlink(missing_ok=True)
    return {"ok": True}


def _dir_size(root: Path) -> tuple[int, int]:
    size = files = 0
    for p in root.rglob("*"):
        try:
            if p.is_file() and not p.is_symlink():
                size += p.stat().st_size
                files += 1
        except OSError:
            pass
    return size, files


@api.get("/system")
async def system(request: Request):
    user = _user(request)
    if not (user.has("settings") or user.is_admin):
        raise HTTPException(403, "Dafür fehlt dir das Recht „Einstellungen“")
    return {**sysmon.snapshot(), "started_at": STARTED_AT, "container_uptime": _container_uptime(),
            "active": manager.active_count()}


@api.get("/storage")
async def storage(request: Request):
    _user(request)
    used, files = await asyncio.to_thread(_dir_size, config.DOWNLOAD_DIR)
    disk = shutil.disk_usage(config.DOWNLOAD_DIR)
    return {"downloads": used, "files": files, "disk_total": disk.total, "disk_free": disk.free,
            "disk_used": disk.total - disk.free}


@api.post("/storage/purge")
async def purge(request: Request):
    user = _need(request, "storage")
    count, freed = await asyncio.to_thread(manager.purge_downloads)
    log.info("%s hat den Speicher geleert (%d Dateien)", user.username, count)
    return {"files": count, "freed": freed}


_updating = False


@api.post("/update-ytdlp")
async def update_ytdlp(request: Request):
    global _updating
    _need(request, "settings")
    if _updating:
        raise HTTPException(409, "Update läuft bereits")
    if manager.active_count():
        raise HTTPException(409, "Bitte warten, bis laufende Downloads fertig sind")
    _updating = True
    try:
        cmd = [sys.executable, "-m", "pip", "install", "-U", "--no-cache-dir", "--disable-pip-version-check"]
        if config.YTDLP_CHANNEL == "nightly":
            cmd.append("--pre")
        cmd.append("yt-dlp[default]")
        proc = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True, timeout=300)
        if proc.returncode != 0:
            raise HTTPException(500, "Update fehlgeschlagen: " + (proc.stderr or proc.stdout)[-500:])
        new = await asyncio.to_thread(
            subprocess.run, [sys.executable, "-c", "import yt_dlp.version as v;print(v.__version__)"],
            capture_output=True, text=True)
        new_version = new.stdout.strip()
        if new_version and new_version != yt_dlp.version.__version__:
            asyncio.get_running_loop().call_later(1.0, _restart)
            return {"updated": True, "version": new_version, "restarting": True}
        return {"updated": False, "version": yt_dlp.version.__version__}
    finally:
        _updating = False


def _restart() -> None:
    log.info("Starte neu, um die neue yt-dlp-Version zu laden …")
    manager.save()
    os.execv(sys.executable, [sys.executable, "-m", "app"])


app.include_router(api)


@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.get("/manifest.webmanifest")
async def manifest():
    return JSONResponse({
        "name": "ScobeTube", "short_name": "ScobeTube", "start_url": "./", "display": "standalone",
        "background_color": "#07060d", "theme_color": "#07060d",
        "icons": [{"src": "static/icon.svg", "sizes": "any", "type": "image/svg+xml"}],
    }, media_type="application/manifest+json")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/login")
async def login_page(request: Request):
    if request.state.user:
        return RedirectResponse("./", status_code=303)
    return FileResponse(STATIC_DIR / "login.html", headers={"Cache-Control": "no-store"})


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-store"})


# Unterstützung für einen URL-Präfix (z. B. hinter einem Reverse-Proxy unter /scobetube)
if config.URL_PREFIX:
    root = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    root.mount(config.URL_PREFIX, app)

    @root.get("/")
    async def _root_redirect():
        return RedirectResponse(config.URL_PREFIX + "/")

    application = root
else:
    application = app
