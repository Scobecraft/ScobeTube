"""Songtexte – synchronisiert (LRC) oder als reiner Text – von lrclib.net.

LRCLIB ist eine freie, offene Lyrics-Datenbank ohne Konto oder API-Schlüssel.
Übertragen werden nur Interpret, Titel, Album und Länge des Songs.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from mutagen import File as MutagenFile
from mutagen.id3 import USLT
from mutagen.mp4 import MP4

from . import config, tags

log = logging.getLogger("scobetube.lyrics")

API = "https://lrclib.net/api"
UA = "ScobeTube (https://github.com/Scobecraft/ScobeTube)"
CACHE_DIR = config.STATE_DIR / "lyrics"
MISS_TTL = 6 * 3600          # „nichts gefunden“ nicht ewig merken – vielleicht kommt es später dazu
_lock = threading.Lock()

_NOISE = re.compile(
    r"\s*[\(\[](?:official|offizielles|lyrics?|audio|video|music video|hd|hq|4k|visuali[sz]er|explicit|clean|"
    r"remaster(?:ed)?(?: \d{4})?|\d{4} remaster(?:ed)?|live|mv|m/v)[^\)\]]*[\)\]]", re.I)
_LRC_LINE = re.compile(r"^((?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+)(.*)$")
_WORD_TAG = re.compile(r"<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>")
_LRC_TIME = re.compile(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")


def clean_title(title: str) -> str:
    title = _NOISE.sub("", title or "")
    title = re.sub(r"\s*[-–|]\s*(?:official|lyrics?|audio).*$", "", title, flags=re.I)
    return re.sub(r"\s+", " ", title).strip(" -–|")


def guess(item, path: Path | None) -> dict[str, Any]:
    """Interpret/Titel/Album bestmöglich bestimmen: Spotify-/Tidal-Daten → Datei-Tags → „Interpret - Titel“."""
    artist = title = album = ""
    meta = item.spotify or {}
    if meta.get("title"):
        title = meta.get("title") or ""
        arts = meta.get("artists") or []
        artist = arts[0] if isinstance(arts, list) and arts else str(arts or "")
        album = meta.get("album") or ""
    if (not title or not artist) and path and path.is_file() and tags.supported(path):
        try:
            t = tags.read(path)
            title = title or t.get("title", "")
            artist = artist or t.get("artist", "")
            album = album or t.get("album", "")
        except Exception:  # noqa: BLE001
            pass
    if not title:
        title = item.title or ""
    if " - " in title and (not artist or artist == item.uploader):
        a, t = title.split(" - ", 1)
        artist, title = a, t
    if not artist:
        artist = re.sub(r"\s*-\s*Topic$", "", item.uploader or "")
    return {"artist": artist.strip(), "title": clean_title(title), "album": album.strip(),
            "duration": round(item.duration) if item.duration else None}


def _fetch(path: str, params: dict[str, Any]) -> Any:
    q = urlencode({k: v for k, v in params.items() if v not in (None, "")})
    req = urllib.request.Request(f"{API}/{path}?{q}", headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _pick(results: list[dict[str, Any]], q: dict[str, Any]) -> dict[str, Any] | None:
    best, best_score = None, -1e9
    for r in results or []:
        score = 0.0
        if _norm(r.get("trackName")) == _norm(q["title"]):
            score += 4
        elif _norm(q["title"]) and _norm(q["title"]) in _norm(r.get("trackName")):
            score += 2
        if q["artist"] and _norm(q["artist"].split(",")[0]) in _norm(r.get("artistName")):
            score += 3
        if r.get("syncedLyrics"):
            score += 2
        if q["duration"] and r.get("duration"):
            diff = abs(float(r["duration"]) - q["duration"])
            score -= min(diff, 60) / 5
            if diff > 20:
                score -= 5
        if score > best_score:
            best, best_score = r, score
    return best if best_score >= 3 else None


def lookup(q: dict[str, Any]) -> dict[str, Any] | None:
    if not q["title"]:
        return None
    hit = None
    if q["artist"]:
        hit = _fetch("get", {"artist_name": q["artist"], "track_name": q["title"],
                             "album_name": q["album"], "duration": q["duration"]})
        if hit and not (hit.get("syncedLyrics") or hit.get("plainLyrics") or hit.get("instrumental")):
            hit = None
    if not hit or not hit.get("syncedLyrics"):
        found = _fetch("search", {"track_name": q["title"], "artist_name": q["artist"]}) or []
        if not found and q["artist"]:
            found = _fetch("search", {"q": f"{q['artist']} {q['title']}"}) or []
        better = _pick(found, q)
        if better and (not hit or better.get("syncedLyrics")):
            hit = better
    if not hit:
        return None
    return {"synced": hit.get("syncedLyrics") or "", "plain": hit.get("plainLyrics") or "",
            "instrumental": bool(hit.get("instrumental")),
            "track": hit.get("trackName") or q["title"], "artist": hit.get("artistName") or q["artist"],
            "source": "LRCLIB"}


def get(item, path: Path | None, force: bool = False) -> dict[str, Any]:
    """Mit Cache in STATE_DIR/lyrics (pro Interpret+Titel+Länge)."""
    q = guess(item, path)
    key = hashlib.sha256(json.dumps([_norm(q["artist"]), _norm(q["title"]), q["duration"]]).encode()).hexdigest()[:24]
    cache = CACHE_DIR / f"{key}.json"
    if not force and cache.is_file():
        try:
            data = json.loads(cache.read_text("utf-8"))
            if data.get("found") or time.time() - data.get("at", 0) < MISS_TTL:
                return {**data, "query": q}
        except (OSError, ValueError):
            pass
    found = lookup(q)
    data = {"found": bool(found), "at": time.time(), **(found or {})}
    with _lock:
        try:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
        except OSError:
            pass
    return {**data, "query": q}


def parse_lrc(text: str) -> list[tuple[float, str]]:
    out: list[tuple[float, str]] = []
    for line in (text or "").splitlines():
        m = _LRC_LINE.match(line.strip())
        if not m:
            continue
        for mm, ss, frac in _LRC_TIME.findall(m.group(1)):
            t = int(mm) * 60 + int(ss) + (int(frac) / (10 ** len(frac)) if frac else 0)
            out.append((t, m.group(2).strip()))
    return sorted(out)


# ------------------------------------------------------------ einbetten
def embed(path: Path, text: str) -> None:
    """Songtext in die Datei schreiben. Synchronisierte Texte bleiben im LRC-Format –
    so zeigen Navidrome, Jellyfin, Plexamp, Poweramp & Co. sie mitlaufend an."""
    if _WORD_TAG.search(text):   # Wort-Zeitmarken <mm:ss.xx> verstehen viele Player nicht
        text = "\n".join(re.sub(r"(\])\s+", r"\1", re.sub(r"[ \t]+", " ", _WORD_TAG.sub("", ln))).strip()
                         for ln in text.splitlines())
    ext = path.suffix.lower()
    if ext in (".mp3", ".wav"):
        t = tags._id3(path, create=True)  # noqa: SLF001
        t.delall("USLT")
        t.add(USLT(encoding=3, lang="XXX", desc="", text=text))
        tags._save_id3(path, t)  # noqa: SLF001
    elif ext in (".m4a", ".mp4a", ".aac"):
        m = MP4(path)
        if m.tags is None:
            m.add_tags()
        m.tags["\xa9lyr"] = [text]
        m.save()
    elif ext in (".flac", ".opus", ".ogg"):
        f = MutagenFile(path)
        if f is None:
            raise ValueError("Dateiformat wird nicht unterstützt")
        if f.tags is None:
            f.add_tags()
        f.tags["LYRICS"] = [text]
        f.save()
    else:
        raise ValueError("Songtexte lassen sich nur in MP3, M4A, FLAC, Opus und WAV einbetten")


def auto_embed(item, path: Path) -> bool:
    """Nach dem Download (falls angehakt): Songtext suchen und einbetten. Fehler sind nicht schlimm."""
    try:
        res = get(item, path)
        text = res.get("synced") or res.get("plain")
        if text:
            embed(path, text)
            return True
    except Exception as e:  # noqa: BLE001
        log.info("Songtext für %s nicht eingebettet: %s", item.id, e)
    return False
