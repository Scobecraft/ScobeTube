"""Download-Warteschlange auf Basis von yt-dlp."""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import yt_dlp
from yt_dlp.utils import DownloadCancelled

from . import config

log = logging.getLogger("scobetube")

VIDEO_FORMATS = ("mp4", "mkv", "webm")
AUDIO_FORMATS = ("mp3", "original", "m4a", "opus", "flac", "wav")
VIDEO_QUALITIES = ("best", "2160", "1440", "1080", "720", "480", "360")
AUDIO_QUALITIES = ("best", "320", "256", "192", "128")

ACTIVE = ("preparing", "queued", "downloading", "processing")
FINISHED = ("done", "error", "cancelled")


@dataclass
class Options:
    kind: str = "video"          # video | audio
    format: str = "mp4"
    quality: str = "best"
    playlist: bool = True
    subtitles: bool = False
    thumbnail: bool = True

    @classmethod
    def parse(cls, data: dict[str, Any]) -> "Options":
        kind = data.get("kind", "video")
        if kind not in ("video", "audio"):
            raise ValueError("Ungültiger Typ")
        fmt = data.get("format") or ("mp4" if kind == "video" else "mp3")
        allowed = VIDEO_FORMATS if kind == "video" else AUDIO_FORMATS
        if fmt not in allowed:
            raise ValueError(f"Ungültiges Format: {fmt}")
        quality = str(data.get("quality") or "best")
        if quality not in (VIDEO_QUALITIES if kind == "video" else AUDIO_QUALITIES):
            raise ValueError(f"Ungültige Qualität: {quality}")
        return cls(
            kind=kind,
            format=fmt,
            quality=quality,
            playlist=bool(data.get("playlist", True)),
            subtitles=bool(data.get("subtitles", False)),
            thumbnail=bool(data.get("thumbnail", True)),
        )


@dataclass
class Item:
    url: str
    options: Options
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    title: str = ""
    thumbnail: str | None = None
    uploader: str | None = None
    duration: float | None = None
    playlist: str | None = None
    status: str = "preparing"
    progress: float = 0.0
    speed: float | None = None
    eta: float | None = None
    downloaded: float | None = None
    total: float | None = None
    filename: str | None = None   # relativ zu DOWNLOAD_DIR
    filesize: int | None = None
    error: str | None = None
    created: float = field(default_factory=time.time)
    finished: float | None = None
    owner: str | None = None      # Benutzername
    source: str | None = None     # z. B. "youtube", "soundcloud"

    def public(self) -> dict[str, Any]:
        d = asdict(self)
        d["title"] = self.title or self.url
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Item":
        d = dict(d)
        d["options"] = Options(**d.get("options", {}))
        known = cls.__dataclass_fields__.keys()
        return cls(**{k: v for k, v in d.items() if k in known})


class Manager:
    def __init__(self) -> None:
        self.items: dict[str, Item] = {}
        self.lock = threading.RLock()
        self.executor = ThreadPoolExecutor(max_workers=config.MAX_CONCURRENT, thread_name_prefix="dl")
        self.resolver = ThreadPoolExecutor(max_workers=4, thread_name_prefix="resolve")
        self.cancel_flags: dict[str, threading.Event] = {}
        self.subscribers: set[asyncio.Queue] = set()
        self.loop: asyncio.AbstractEventLoop | None = None
        self._last_emit: dict[str, float] = {}
        self._save_pending = False
        self.state_file = config.STATE_DIR / "state.json"
        self.tmp_dir = config.STATE_DIR / "tmp"

    # ------------------------------------------------------------------ setup
    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        config.DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
        config.STATE_DIR.mkdir(parents=True, exist_ok=True)
        shutil.rmtree(self.tmp_dir, ignore_errors=True)
        self.tmp_dir.mkdir(parents=True, exist_ok=True)
        self._load()

    def _load(self) -> None:
        if not self.state_file.exists():
            return
        try:
            data = json.loads(self.state_file.read_text("utf-8"))
        except Exception as e:  # noqa: BLE001
            log.warning("Status-Datei konnte nicht gelesen werden: %s", e)
            return
        for raw in data.get("items", []):
            try:
                item = Item.from_dict(raw)
            except Exception:  # noqa: BLE001
                continue
            self.items[item.id] = item
        # Unterbrochene Downloads wieder einreihen
        for item in list(self.items.values()):
            if item.status in ACTIVE:
                item.progress = 0
                if item.status == "preparing":
                    self._submit_resolve(item)
                else:
                    self._enqueue(item)
        log.info("%d Einträge geladen", len(self.items))

    def save(self) -> None:
        with self.lock:
            data = {"items": [asdict(i) for i in self.items.values()]}
        tmp = self.state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
        tmp.replace(self.state_file)

    def _schedule_save(self) -> None:
        if self._save_pending or not self.loop:
            return
        self._save_pending = True

        def do_save() -> None:
            self._save_pending = False
            try:
                self.save()
            except Exception as e:  # noqa: BLE001
                log.error("Speichern fehlgeschlagen: %s", e)

        self.loop.call_soon_threadsafe(lambda: self.loop.call_later(0.5, do_save))

    # ----------------------------------------------------------------- events
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self.subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subscribers.discard(q)

    def emit(self, event: str, data: Any) -> None:
        if not self.loop:
            return

        def push() -> None:
            for q in list(self.subscribers):
                try:
                    q.put_nowait((event, data))
                except asyncio.QueueFull:
                    pass

        self.loop.call_soon_threadsafe(push)

    def _update(self, item: Item, persist: bool = True) -> None:
        self.emit("update", item.public())
        if persist:
            self._schedule_save()

    def snapshot(self, visible=None) -> list[dict[str, Any]]:
        with self.lock:
            return [i.public() for i in self.items.values() if visible is None or visible(i)]

    # --------------------------------------------------------------- yt-dlp
    def _base_opts(self) -> dict[str, Any]:
        opts: dict[str, Any] = {
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "cachedir": str(config.STATE_DIR / "cache"),
            "windowsfilenames": config.WINDOWS_FILENAMES,
            "socket_timeout": 30,
            "retries": 10,
            "fragment_retries": 10,
        }
        if config.COOKIES_FILE.is_file():
            opts["cookiefile"] = str(config.COOKIES_FILE)
        opts.update(config.YTDL_EXTRA_OPTIONS)
        return opts

    def _download_opts(self, item: Item) -> dict[str, Any]:
        o = item.options
        opts = self._base_opts()
        target = config.DOWNLOAD_DIR
        if item.playlist and config.PLAYLIST_SUBFOLDER:
            target = target / _safe_dirname(item.playlist)
        pps: list[dict[str, Any]] = []

        if o.kind == "audio":
            opts["format"] = "bestaudio/best"
            # "original" = Tonspur ohne Neukodierung übernehmen (z. B. SoundCloud-MP3/Opus)
            codec = "best" if o.format == "original" else o.format
            pp: dict[str, Any] = {"key": "FFmpegExtractAudio", "preferredcodec": codec}
            if o.format in ("mp3", "m4a", "opus") and o.quality != "best":
                pp["preferredquality"] = o.quality
            elif o.format == "mp3":
                pp["preferredquality"] = "0"  # beste VBR-Qualität
            pps.append(pp)
            thumb_ok = o.format in ("mp3", "m4a", "opus", "flac", "original")
        else:
            sort = []
            if o.quality != "best":
                sort.append(f"res:{o.quality}")
            if o.format == "mp4":
                sort += ["ext:mp4:m4a", "vcodec:h264"]
            elif o.format == "webm":
                sort += ["ext:webm:webm"]
            opts["format"] = "bv*+ba/b"
            opts["format_sort"] = sort
            opts["merge_output_format"] = o.format
            if o.format == "webm":
                opts["format"] = "bv*[ext=webm]+ba[ext=webm]/bv*+ba/b"
            thumb_ok = o.format in ("mp4", "mkv")
            if o.format in ("mp4", "mkv"):
                # Einzeldateien (ohne Zusammenführen) ins gewünschte Format umpacken
                pps.append({"key": "FFmpegVideoRemuxer", "preferedformat": o.format})
            if o.subtitles:
                opts["writesubtitles"] = True
                opts["subtitleslangs"] = ["de.*", "en.*", "de", "en"]
                pps.append({"key": "FFmpegEmbedSubtitle", "already_have_subtitle": False})

        pps.append({"key": "FFmpegMetadata", "add_metadata": True, "add_chapters": True})
        if o.thumbnail and thumb_ok:
            opts["writethumbnail"] = True
            pps.append({"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"})
            pps.append({"key": "EmbedThumbnail", "already_have_thumbnail": False})

        opts["postprocessors"] = pps
        opts["paths"] = {"home": str(target), "temp": str(self.tmp_dir / item.id)}
        opts["outtmpl"] = {"default": config.OUTPUT_TEMPLATE}
        opts["noplaylist"] = True
        opts["progress_hooks"] = [lambda d: self._on_progress(item, d)]
        opts["postprocessor_hooks"] = [lambda d: self._on_postprocess(item, d)]
        return opts

    # -------------------------------------------------------------- resolve
    def add(self, urls: list[str], options: Options, owner: str | None = None) -> list[Item]:
        created = []
        for url in urls:
            item = Item(url=url, options=options, owner=owner)
            with self.lock:
                self.items[item.id] = item
            self.emit("added", item.public())
            self._submit_resolve(item)
            created.append(item)
        self._schedule_save()
        return created

    def _submit_resolve(self, item: Item) -> None:
        item.status = "preparing"
        self.resolver.submit(self._resolve, item)

    def _resolve(self, item: Item) -> None:
        opts = self._base_opts()
        opts.update({"extract_flat": "in_playlist", "skip_download": True,
                     "noplaylist": not item.options.playlist})
        if config.PLAYLIST_LIMIT > 0:
            opts["playlistend"] = config.PLAYLIST_LIMIT
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(item.url, download=False)
        except Exception as e:  # noqa: BLE001
            self._fail(item, e)
            return
        if item.status == "cancelled":
            return

        if info.get("_type") in ("playlist", "multi_video") and info.get("entries") is not None:
            entries = [e for e in info["entries"] if e]
            ptitle = info.get("title") or info.get("id") or "Playlist"
            if not entries:
                self._fail(item, Exception("Playlist ist leer"))
                return
            # Platzhalter entfernen, Einträge einzeln einreihen
            with self.lock:
                self.items.pop(item.id, None)
            self.emit("removed", {"id": item.id, "owner": item.owner})
            for e in entries:
                url = e.get("webpage_url") or e.get("url")
                if not url:
                    continue
                child = Item(url=url, options=item.options, playlist=ptitle, owner=item.owner)
                child.title = e.get("title") or ""
                child.thumbnail = _thumb(e)
                child.duration = e.get("duration")
                child.uploader = e.get("uploader") or e.get("channel")
                child.source = _source(e) or _source(info)
                with self.lock:
                    self.items[child.id] = child
                self.emit("added", child.public())
                self._enqueue(child)
            self._schedule_save()
            return

        item.title = info.get("title") or item.title
        item.thumbnail = _thumb(info)
        item.duration = info.get("duration")
        item.uploader = info.get("uploader") or info.get("channel")
        item.source = _source(info)
        item.url = info.get("webpage_url") or item.url
        self._enqueue(item)

    # ------------------------------------------------------------- download
    def _enqueue(self, item: Item) -> None:
        item.status = "queued"
        item.error = None
        item.progress = 0
        flag = threading.Event()
        self.cancel_flags[item.id] = flag
        self._update(item)
        self.executor.submit(self._download, item, flag)

    def _download(self, item: Item, flag: threading.Event) -> None:
        # Veraltete Aufträge (abgebrochen / neu eingereiht) überspringen
        if item.status != "queued" or flag.is_set() or self.cancel_flags.get(item.id) is not flag:
            return
        item.status = "downloading"
        self._update(item)
        tmp = self.tmp_dir / item.id
        try:
            with yt_dlp.YoutubeDL(self._download_opts(item)) as ydl:
                info = ydl.extract_info(item.url, download=True)
            path = None
            reqs = (info or {}).get("requested_downloads") or []
            if reqs:
                path = reqs[0].get("filepath")
            path = path or (info or {}).get("filepath")
            if path:
                p = Path(path).resolve()
                try:
                    item.filename = str(p.relative_to(config.DOWNLOAD_DIR))
                except ValueError:
                    item.filename = p.name
                if p.exists():
                    item.filesize = p.stat().st_size
            if info:
                item.title = info.get("title") or item.title
                item.thumbnail = item.thumbnail or _thumb(info)
            item.status = "done"
            item.progress = 100
            item.speed = item.eta = None
            item.finished = time.time()
            self._update(item)
        except DownloadCancelled:
            item.status = "cancelled"
            item.speed = item.eta = None
            item.finished = time.time()
            self._update(item)
        except Exception as e:  # noqa: BLE001
            if flag.is_set():
                item.status = "cancelled"
                item.finished = time.time()
                self._update(item)
            else:
                self._fail(item, e)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
            if self.cancel_flags.get(item.id) is flag:
                self.cancel_flags.pop(item.id, None)
            self._last_emit.pop(item.id, None)

    def _on_progress(self, item: Item, d: dict[str, Any]) -> None:
        flag = self.cancel_flags.get(item.id)
        if flag and flag.is_set():
            raise DownloadCancelled("Abgebrochen")
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes")
            if total and done:
                item.progress = round(min(99.9, done / total * 100), 1)
            item.speed = d.get("speed")
            item.eta = d.get("eta")
            item.downloaded = done
            item.total = total
            now = time.monotonic()
            if now - self._last_emit.get(item.id, 0) > 0.4:
                self._last_emit[item.id] = now
                self._update(item, persist=False)
        elif d.get("status") == "finished":
            item.progress = 99.9
            self._update(item, persist=False)

    def _on_postprocess(self, item: Item, d: dict[str, Any]) -> None:
        if d.get("status") == "started" and item.status != "processing":
            item.status = "processing"
            item.speed = item.eta = None
            self._update(item, persist=False)

    def _fail(self, item: Item, e: Exception) -> None:
        msg = str(e)
        if msg.startswith("ERROR: "):
            msg = msg[7:]
        msg = re.sub(r"\x1b\[[0-9;]*m", "", msg)
        if "confirm you" in msg and "not a bot" in msg:
            msg = ("YouTube verlangt eine Anmeldung („Bist du ein Bot?“). Lösung: In den Einstellungen "
                   "eine cookies.txt hochladen oder yt-dlp aktualisieren.")
        elif "Video unavailable" in msg:
            msg = "Video nicht verfügbar (gelöscht, privat oder in deinem Land gesperrt)."
        item.status = "error"
        item.error = msg[:1000]
        item.speed = item.eta = None
        item.finished = time.time()
        log.warning("Fehler bei %s: %s", item.url, msg)
        self._update(item)

    # -------------------------------------------------------------- actions
    def get(self, item_id: str) -> Item | None:
        return self.items.get(item_id)

    def cancel(self, item_id: str) -> bool:
        item = self.items.get(item_id)
        if not item or item.status not in ACTIVE:
            return False
        flag = self.cancel_flags.get(item_id)
        if flag:
            flag.set()
        if item.status in ("queued", "preparing"):
            item.status = "cancelled"
            item.finished = time.time()
            self._update(item)
        return True

    def retry(self, item_id: str) -> bool:
        item = self.items.get(item_id)
        if not item or item.status not in FINISHED:
            return False
        item.finished = None
        item.filename = None
        item.filesize = None
        if item.title:
            self._enqueue(item)
        else:
            self._submit_resolve(item)
            self._update(item)
        return True

    def remove(self, item_id: str, delete_file: bool) -> bool:
        item = self.items.get(item_id)
        if not item:
            return False
        if item.status in ACTIVE:
            self.cancel(item_id)
        if delete_file:
            self.delete_file(item)
        with self.lock:
            self.items.pop(item_id, None)
        self.emit("removed", {"id": item_id, "owner": item.owner})
        self._schedule_save()
        return True

    def delete_file(self, item: Item) -> None:
        path = self.file_path(item)
        if path and path.is_file():
            try:
                path.unlink()
                parent = path.parent
                if parent != config.DOWNLOAD_DIR and not any(parent.iterdir()):
                    parent.rmdir()
            except OSError as e:
                log.warning("Datei konnte nicht gelöscht werden: %s", e)

    def clear(self, which: str, delete_files: bool, visible=None) -> int:
        statuses = {"done": ("done",), "failed": ("error", "cancelled"), "finished": FINISHED}.get(which, ())
        ids = [i.id for i in self.items.values() if i.status in statuses and (visible is None or visible(i))]
        for i in ids:
            self.remove(i, delete_files)
        return len(ids)

    def file_path(self, item: Item) -> Path | None:
        if not item.filename:
            return None
        p = (config.DOWNLOAD_DIR / item.filename).resolve()
        if config.DOWNLOAD_DIR not in p.parents:
            return None
        return p

    def purge_downloads(self) -> tuple[int, int]:
        """Löscht alle Dateien im Download-Ordner und entfernt fertige Einträge.

        Laufende Downloads schreiben in einen separaten Temp-Ordner und bleiben unberührt.
        Gibt (Anzahl Dateien, freigegebene Bytes) zurück.
        """
        active_files = {self.file_path(i) for i in self.items.values() if i.status in ACTIVE}
        count = freed = 0
        root = config.DOWNLOAD_DIR
        for path in sorted(root.rglob("*"), key=lambda p: len(p.parts), reverse=True):
            try:
                if path.is_symlink() or path.is_file():
                    if path in active_files:
                        continue
                    size = path.lstat().st_size
                    path.unlink()
                    count += 1
                    freed += size
                elif path.is_dir() and not any(path.iterdir()):
                    path.rmdir()
            except OSError as e:
                log.warning("Konnte %s nicht löschen: %s", path, e)
        for item in [i for i in self.items.values() if i.status in FINISHED]:
            with self.lock:
                self.items.pop(item.id, None)
            self.emit("removed", {"id": item.id, "owner": item.owner})
        self._schedule_save()
        log.info("Speicher geleert: %d Dateien, %d Bytes", count, freed)
        return count, freed

    def active_count(self) -> int:
        return sum(1 for i in self.items.values() if i.status in ("downloading", "processing"))


def _source(info: dict[str, Any]) -> str | None:
    key = str(info.get("extractor_key") or info.get("ie_key") or info.get("extractor") or "").lower()
    for name in ("soundcloud", "youtube", "vimeo", "twitch", "tiktok", "instagram", "twitter", "bandcamp",
                 "mixcloud", "reddit", "facebook", "dailymotion"):
        if name in key:
            return name
    return key.split(":")[0] or None


SEARCH_PREFIX = {"soundcloud": "scsearch", "youtube": "ytsearch"}


def search(source: str, query: str, limit: int = 12) -> list[dict[str, Any]]:
    prefix = SEARCH_PREFIX[source]
    opts = manager._base_opts()
    opts.update({"extract_flat": "in_playlist", "skip_download": True})
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"{prefix}{limit}:{query}", download=False)
    out = []
    for e in (info or {}).get("entries") or []:
        if not e:
            continue
        url = e.get("webpage_url") or e.get("url")
        if not url:
            continue
        out.append({"url": url, "title": e.get("title") or url, "uploader": e.get("uploader") or e.get("channel"),
                    "duration": e.get("duration"), "thumbnail": _thumb(e), "source": source})
    return out


def _thumb(info: dict[str, Any]) -> str | None:
    if info.get("thumbnail"):
        return info["thumbnail"]
    thumbs = info.get("thumbnails") or []
    if thumbs:
        return thumbs[-1].get("url")
    if info.get("ie_key") == "Youtube" or "youtube" in str(info.get("extractor_key", "")).lower():
        vid = info.get("id")
        if vid:
            return f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
    return None


def _safe_dirname(name: str) -> str:
    bad = '<>:"/\\|?*\0'
    cleaned = "".join("_" if c in bad or ord(c) < 32 else c for c in name).strip(" .")
    return cleaned[:150] or "Playlist"


manager = Manager()
