"""ScobeTube – Web-API und Oberfläche."""
from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import os
import re
import secrets
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote

import yt_dlp
from fastapi import APIRouter, FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import config
from .downloader import AUDIO_FORMATS, AUDIO_QUALITIES, VIDEO_FORMATS, VIDEO_QUALITIES, Options, manager

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("scobetube")

STATIC_DIR = Path(__file__).parent / "static"
URL_RE = re.compile(r"https?://[^\s<>\"']+", re.I)


@asynccontextmanager
async def lifespan(_: FastAPI):
    manager.start(asyncio.get_running_loop())
    log.info("ScobeTube %s gestartet – yt-dlp %s – Downloads: %s",
             config.APP_VERSION, yt_dlp.version.__version__, config.DOWNLOAD_DIR)
    yield
    manager.save()


app = FastAPI(title="ScobeTube", lifespan=lifespan, docs_url=None, redoc_url=None)
api = APIRouter(prefix="/api")


# ------------------------------------------------------------------ auth
@app.middleware("http")
async def basic_auth(request: Request, call_next):
    if config.AUTH_USER and config.AUTH_PASSWORD and not request.url.path.endswith("/healthz"):
        ok = False
        header = request.headers.get("authorization", "")
        if header.lower().startswith("basic "):
            try:
                user, _, pw = base64.b64decode(header[6:]).decode("utf-8").partition(":")
                ok = secrets.compare_digest(user, config.AUTH_USER) and secrets.compare_digest(pw, config.AUTH_PASSWORD)
            except (binascii.Error, UnicodeDecodeError):
                ok = False
        if not ok:
            return Response(status_code=401, headers={"WWW-Authenticate": 'Basic realm="ScobeTube"'})
    return await call_next(request)


# ------------------------------------------------------------------- api
@api.get("/info")
async def info():
    return {
        "version": config.APP_VERSION,
        "ytdlp": yt_dlp.version.__version__,
        "ytdlp_channel": config.YTDLP_CHANNEL,
        "cookies": config.COOKIES_FILE.is_file(),
        "max_concurrent": config.MAX_CONCURRENT,
        "formats": {
            "video": {"formats": VIDEO_FORMATS, "qualities": VIDEO_QUALITIES},
            "audio": {"formats": AUDIO_FORMATS, "qualities": AUDIO_QUALITIES},
        },
    }


@api.get("/items")
async def items():
    return manager.snapshot()


def _extract_urls(text: str) -> list[str]:
    urls = URL_RE.findall(text or "")
    seen, out = set(), []
    for u in urls:
        u = u.rstrip(".,;)")
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


@api.post("/add")
async def add(request: Request):
    data = await request.json()
    urls = _extract_urls(data.get("urls") or data.get("url") or "")
    if not urls:
        raise HTTPException(400, "Keine gültige URL gefunden")
    try:
        options = Options.parse(data)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    created = manager.add(urls, options)
    return {"added": [i.id for i in created]}


@api.get("/add")
async def add_get(url: str, kind: str = "video", format: str = "", quality: str = "best", redirect: bool = True):
    """Für Lesezeichen / iOS-Kurzbefehle: /api/add?url=...&kind=audio&format=mp3"""
    urls = _extract_urls(url)
    if not urls:
        raise HTTPException(400, "Keine gültige URL gefunden")
    try:
        options = Options.parse({"kind": kind, "format": format, "quality": quality})
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    manager.add(urls, options)
    if redirect:
        return RedirectResponse(config.URL_PREFIX + "/", status_code=303)
    return {"ok": True}


@api.post("/items/{item_id}/cancel")
async def cancel(item_id: str):
    if not manager.cancel(item_id):
        raise HTTPException(404, "Nicht gefunden oder nicht aktiv")
    return {"ok": True}


@api.post("/items/{item_id}/retry")
async def retry(item_id: str):
    if not manager.retry(item_id):
        raise HTTPException(404, "Nicht gefunden oder noch aktiv")
    return {"ok": True}


@api.delete("/items/{item_id}")
async def delete(item_id: str, delete_file: bool = False):
    if not manager.remove(item_id, delete_file):
        raise HTTPException(404, "Nicht gefunden")
    return {"ok": True}


@api.post("/clear")
async def clear(request: Request):
    data = await request.json()
    n = manager.clear(data.get("which", "done"), bool(data.get("delete_files")))
    return {"removed": n}


@api.get("/files/{item_id}")
async def file(item_id: str, inline: bool = False):
    item = manager.get(item_id)
    path = manager.file_path(item) if item else None
    if not path or not path.is_file():
        raise HTTPException(404, "Datei nicht gefunden")
    disp = "inline" if inline else "attachment"
    headers = {"Content-Disposition": f"{disp}; filename*=UTF-8''{quote(path.name)}"}
    return FileResponse(path, headers=headers)


@api.get("/events")
async def events(request: Request):
    q = manager.subscribe()

    async def stream():
        try:
            yield _sse("init", {"items": manager.snapshot()})
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event, data = await asyncio.wait_for(q.get(), timeout=15)
                    yield _sse(event, data)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            manager.unsubscribe(q)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@api.post("/cookies")
async def upload_cookies(file: UploadFile):
    content = await file.read()
    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(400, "Datei zu groß")
    text = content.decode("utf-8", errors="replace")
    if "\t" not in text:
        raise HTTPException(400, "Das sieht nicht nach einer cookies.txt (Netscape-Format) aus")
    config.COOKIES_FILE.parent.mkdir(parents=True, exist_ok=True)
    config.COOKIES_FILE.write_text(text, "utf-8")
    try:
        os.chmod(config.COOKIES_FILE, 0o600)
    except OSError:
        pass
    return {"ok": True}


@api.delete("/cookies")
async def delete_cookies():
    config.COOKIES_FILE.unlink(missing_ok=True)
    return {"ok": True}


_updating = False


@api.post("/update-ytdlp")
async def update_ytdlp():
    global _updating
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


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})


# Unterstützung für einen URL-Präfix (z. B. hinter einem Reverse-Proxy unter /scobetube)
if config.URL_PREFIX:
    root = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)
    root.mount(config.URL_PREFIX, app)

    @root.get("/")
    async def _root_redirect():
        return RedirectResponse(config.URL_PREFIX + "/")

    application = root
else:
    application = app
