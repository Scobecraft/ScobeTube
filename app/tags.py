"""Tags (Titel, Interpret, Album, Cover) von Audiodateien lesen und ändern."""
from __future__ import annotations

import base64
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from mutagen import File as MutagenFile
from mutagen.flac import FLAC, Picture
from mutagen.id3 import APIC, ID3, TALB, TIT2, TPE1, TPE2, ID3NoHeaderError
from mutagen.mp4 import MP4, MP4Cover
from mutagen.oggopus import OggOpus
from mutagen.oggvorbis import OggVorbis
from mutagen.wave import WAVE

EDITABLE = {".mp3", ".m4a", ".mp4a", ".aac", ".flac", ".opus", ".ogg", ".wav"}
MAX_COVER_BYTES = 15 * 1024 * 1024


def supported(path: Path) -> bool:
    return path.suffix.lower() in EDITABLE


def _first(v: Any) -> str:
    if isinstance(v, list):
        v = v[0] if v else ""
    return str(v) if v is not None else ""


# ------------------------------------------------------------------ lesen
def read(path: Path) -> dict[str, Any]:
    ext = path.suffix.lower()
    out = {"title": "", "artist": "", "album": "", "has_cover": False}
    if ext in (".mp3", ".wav"):
        tags = _id3(path, create=False)
        if tags is not None:
            out["title"] = _first(tags.get("TIT2"))
            out["artist"] = _first(tags.get("TPE1"))
            out["album"] = _first(tags.get("TALB"))
            out["has_cover"] = bool(tags.getall("APIC"))
        return out
    f = MutagenFile(path, easy=True)
    if f is not None and f.tags is not None:
        out["title"] = _first(f.tags.get("title"))
        out["artist"] = _first(f.tags.get("artist"))
        out["album"] = _first(f.tags.get("album"))
    out["has_cover"] = read_cover(path) is not None
    return out


def read_cover(path: Path) -> tuple[bytes, str] | None:
    ext = path.suffix.lower()
    try:
        if ext in (".mp3", ".wav"):
            tags = _id3(path, create=False)
            pics = tags.getall("APIC") if tags is not None else []
            return (pics[0].data, pics[0].mime or "image/jpeg") if pics else None
        if ext in (".m4a", ".mp4a", ".aac"):
            covr = (MP4(path).tags or {}).get("covr") or []
            if covr:
                fmt = "image/png" if covr[0].imageformat == MP4Cover.FORMAT_PNG else "image/jpeg"
                return bytes(covr[0]), fmt
            return None
        if ext == ".flac":
            pics = FLAC(path).pictures
            return (pics[0].data, pics[0].mime) if pics else None
        if ext in (".opus", ".ogg"):
            f = MutagenFile(path)
            for b64 in (f.tags or {}).get("metadata_block_picture", []) if f else []:
                pic = Picture(base64.b64decode(b64))
                return pic.data, pic.mime
    except Exception:  # noqa: BLE001
        return None
    return None


# --------------------------------------------------------------- schreiben
def _id3(path: Path, create: bool):
    if path.suffix.lower() == ".wav":
        w = WAVE(path)
        if w.tags is None:
            if not create:
                return None
            w.add_tags()
        w.tags._scobetube_owner = w  # zum Speichern merken
        return w.tags
    try:
        return ID3(path)
    except ID3NoHeaderError:
        return ID3() if create else None


def _save_id3(path: Path, tags) -> None:
    owner = getattr(tags, "_scobetube_owner", None)
    if owner is not None:
        owner.save()
    else:
        tags.save(path, v2_version=3)


def write(path: Path, title: str | None, artist: str | None, album: str | None, cover_jpeg: bytes | None) -> None:
    ext = path.suffix.lower()
    if ext in (".mp3", ".wav"):
        tags = _id3(path, create=True)
        for frame, value in ((TIT2, title), (TPE1, artist), (TALB, album)):
            if value is not None:
                tags.delall(frame.__name__)
                if value:
                    tags.add(frame(encoding=3, text=[value]))
        if artist:
            tags.delall("TPE2")
            tags.add(TPE2(encoding=3, text=[artist]))
        if cover_jpeg:
            tags.delall("APIC")
            tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="Cover", data=cover_jpeg))
        _save_id3(path, tags)
        return

    f = MutagenFile(path, easy=True)
    if f is None:
        raise ValueError("Dateiformat wird nicht unterstützt")
    if f.tags is None:
        f.add_tags()
    for key, value in (("title", title), ("artist", artist), ("album", album)):
        if value is not None:
            if value:
                f.tags[key] = [value]
            elif key in f.tags:
                del f.tags[key]
    if artist and ext in (".m4a", ".mp4a", ".aac", ".flac", ".opus", ".ogg"):
        try:
            f.tags["albumartist"] = [artist]
        except (KeyError, ValueError):
            pass
    f.save()

    if not cover_jpeg:
        return
    if ext in (".m4a", ".mp4a", ".aac"):
        m = MP4(path)
        m.tags["covr"] = [MP4Cover(cover_jpeg, imageformat=MP4Cover.FORMAT_JPEG)]
        m.save()
    elif ext == ".flac":
        fl = FLAC(path)
        fl.clear_pictures()
        fl.add_picture(_picture(cover_jpeg))
        fl.save()
    elif ext in (".opus", ".ogg"):
        o = OggOpus(path) if ext == ".opus" else _ogg(path)
        o.tags["metadata_block_picture"] = [base64.b64encode(_picture(cover_jpeg).write()).decode("ascii")]
        o.save()


def _ogg(path: Path):
    try:
        return OggVorbis(path)
    except Exception:  # noqa: BLE001
        return OggOpus(path)


def _picture(jpeg: bytes) -> Picture:
    pic = Picture()
    pic.type = 3
    pic.mime = "image/jpeg"
    pic.desc = "Cover"
    pic.data = jpeg
    return pic


# ------------------------------------------------------------------ cover
def normalize_cover(data: bytes) -> bytes:
    """Prüft ein hochgeladenes Bild und rendert es sauber als JPEG (max. 1200 px)."""
    if len(data) > MAX_COVER_BYTES:
        raise ValueError("Bild ist zu groß (max. 15 MB)")
    sig = data[:12]
    if not (sig.startswith(b"\xff\xd8\xff") or sig.startswith(b"\x89PNG") or
            (sig[:4] == b"RIFF" and sig[8:12] == b"WEBP") or sig[:6] in (b"GIF87a", b"GIF89a")):
        raise ValueError("Bitte ein JPG-, PNG-, WebP- oder GIF-Bild hochladen")
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / "in", Path(tmp) / "out.jpg"
        src.write_bytes(data)
        proc = subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", str(src), "-frames:v", "1",
             "-vf", "scale='min(1200,iw)':'min(1200,ih)':force_original_aspect_ratio=decrease",
             "-q:v", "3", str(dst)],
            capture_output=True, timeout=60)
        if proc.returncode != 0 or not dst.exists():
            raise ValueError("Das Bild konnte nicht gelesen werden")
        return dst.read_bytes()


def set_track(path: Path, number: int, total: int) -> None:
    """Tracknummer setzen (z. B. bei aufgeteilten Kapiteln)."""
    ext = path.suffix.lower()
    if ext in (".mp3", ".wav"):
        from mutagen.id3 import TRCK
        t = _id3(path, create=True)
        t.delall("TRCK")
        t.add(TRCK(encoding=3, text=[f"{number}/{total}"]))
        _save_id3(path, t)
        return
    f = MutagenFile(path, easy=True)
    if f is None:
        return
    if f.tags is None:
        f.add_tags()
    f.tags["tracknumber"] = [f"{number}/{total}"] if ext != ".m4a" else [f"{number}/{total}"]
    f.save()
