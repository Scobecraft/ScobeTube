"""Spotify-Unterstützung.

Spotify-Audio ist DRM-geschützt und wird NICHT von Spotify geladen. Stattdessen:
1. Metadaten (Titel, Interpreten, Album, Cover, Länge) von Spotifys öffentlichen Seiten lesen,
2. denselben Song auf YouTube Music suchen (Abgleich über Länge und Titel),
3. von dort laden und die Spotify-Metadaten samt Cover in die Datei schreiben.
"""
from __future__ import annotations

import html
import json
import logging
import re
import unicodedata
import urllib.request
from typing import Any
from urllib.parse import quote_plus

import yt_dlp
from yt_dlp.postprocessor.common import PostProcessor

log = logging.getLogger("scobetube.spotify")

URL_RE = re.compile(
    r"(?:https?://(?:open|play)\.spotify\.com/(?:intl-[a-z]{2}(?:-[a-z]{2})?/)?(?:embed/)?|spotify:)"
    r"(track|album|playlist|artist)[/:]([A-Za-z0-9]{22})", re.I)
_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


def parse_url(url: str) -> tuple[str, str] | None:
    m = URL_RE.search(url or "")
    return (m.group(1).lower(), m.group(2)) if m else None


def _get(url: str, ua: str = _UA) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=20) as r:  # noqa: S310 – feste Spotify-Hosts
        return r.read(3_000_000).decode("utf-8", "replace")


def _entity(kind: str, sid: str) -> dict[str, Any]:
    page = _get(f"https://open.spotify.com/embed/{kind}/{sid}")
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', page, re.S)
    if not m:
        raise RuntimeError("Spotify-Seite konnte nicht gelesen werden")
    try:
        return json.loads(m.group(1))["props"]["pageProps"]["state"]["data"]["entity"]
    except (KeyError, TypeError, json.JSONDecodeError) as e:
        raise RuntimeError("Spotify hat unerwartete Daten geliefert (privat oder nicht verfügbar?)") from e


def _cover(entity: dict[str, Any]) -> str | None:
    imgs = ((entity.get("visualIdentity") or {}).get("image") or []) or \
           ((entity.get("coverArt") or {}).get("sources") or [])
    if not imgs:
        return None
    return max(imgs, key=lambda i: i.get("maxWidth") or i.get("width") or 0).get("url")


def _artists(value: Any) -> list[str]:
    if isinstance(value, list):
        return [a.get("name", "") for a in value if a.get("name")]
    if isinstance(value, str):
        return [a.strip() for a in value.replace("\xa0", " ").split(",") if a.strip()]
    return []


def resolve(url: str) -> dict[str, Any]:
    """Liest einen Spotify-Link. Gibt Titel, Cover und die Trackliste zurück."""
    parsed = parse_url(url)
    if not parsed:
        raise ValueError("Kein Spotify-Link")
    kind, sid = parsed
    e = _entity(kind, sid)
    if kind == "track":
        tracks = [{"id": sid, "title": e.get("title") or e.get("name"), "artists": _artists(e.get("artists")),
                   "duration": (e.get("duration") or 0) / 1000 or None, "cover": _cover(e)}]
    else:
        tracks = []
        for t in e.get("trackList") or []:
            uri = t.get("uri") or ""
            if not uri.startswith("spotify:track:"):
                continue  # Podcasts u. Ä. überspringen
            tracks.append({"id": uri.split(":")[-1], "title": t.get("title"), "artists": _artists(t.get("subtitle")),
                           "duration": (t.get("duration") or 0) / 1000 or None})
    return {"kind": kind, "id": sid, "title": e.get("title") or e.get("name") or "Spotify",
            "subtitle": e.get("subtitle"), "cover": _cover(e), "tracks": tracks}


def track_details(track: dict[str, Any]) -> dict[str, Any]:
    """Ergänzt Album, Jahr und großes Cover von der Track-Seite (best effort)."""
    out = dict(track)
    try:
        # schlichte Kennung → Spotify liefert serverseitig gerenderte Meta-Daten
        page = _get(f"https://open.spotify.com/track/{track['id']}", ua="Mozilla/5.0 (compatible; ScobeTube)")
        meta = {m.group(1): html.unescape(m.group(2)) for m in
                re.finditer(r'<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"', page)}
        parts = [p.strip() for p in meta.get("og:description", "").split("·")]
        # Format: "Interpret · Album · Song · Jahr"
        if len(parts) >= 4 and parts[-2].lower() in ("song", "lied", "titel"):
            out.setdefault("album", parts[1])
            if parts[-1].isdigit():
                out.setdefault("year", int(parts[-1]))
        if meta.get("og:image"):
            out["cover"] = meta["og:image"]
        if not out.get("title") and meta.get("og:title"):
            out["title"] = meta["og:title"]
        if not out.get("duration") and meta.get("music:duration", "").isdigit():
            out["duration"] = int(meta["music:duration"])
    except Exception as e:  # noqa: BLE001
        log.debug("Spotify-Details für %s nicht verfügbar: %s", track.get("id"), e)
    return out


# ------------------------------------------------------------- abgleich
def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\((?:feat|ft|with)[^)]*\)|\[(?:feat|ft)[^]]*\]", " ", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


_BAD_WORDS = ("live", "cover", "karaoke", "instrumental", "remix", "sped up", "slowed", "nightcore", "8d", "reverb",
              "acoustic", "piano version", "lyrics video")


def _score(track: dict[str, Any], cand: dict[str, Any]) -> float:
    title, artists = _norm(track.get("title", "")), [_norm(a) for a in track.get("artists", [])]
    ctitle = _norm(cand.get("title", ""))
    cart = _norm(" ".join(filter(None, [cand.get("uploader"), cand.get("channel"), cand.get("artist")])))
    score = 0.0
    words = set(title.split())
    if words:
        score += 40 * len(words & set(ctitle.split())) / len(words)
    if artists and any(a and (a in cart or a in ctitle) for a in artists):
        score += 30
    dur, cdur = track.get("duration"), cand.get("duration")
    if dur and cdur:
        diff = abs(dur - cdur)
        score += 30 if diff <= 3 else 22 if diff <= 7 else 10 if diff <= 15 else -20 if diff > 40 else 0
    for w in _BAD_WORDS:
        if w in ctitle and w not in title:
            score -= 25
    if "topic" in cart:  # offizielle Auto-Uploads von YouTube Music
        score += 8
    return score


def find_match(track: dict[str, Any], base_opts: dict[str, Any]) -> str | None:
    query = f"{', '.join(track.get('artists') or [])} - {track.get('title', '')}".strip(" -")
    opts = dict(base_opts)
    opts.update({"extract_flat": "in_playlist", "skip_download": True, "playlistend": 6})
    candidates: list[dict[str, Any]] = []
    searches = [f"https://music.youtube.com/search?q={quote_plus(query)}#songs", f"ytsearch6:{query} audio"]
    with yt_dlp.YoutubeDL(opts) as ydl:
        for s in searches:
            try:
                info = ydl.extract_info(s, download=False)
            except Exception as e:  # noqa: BLE001
                log.debug("Suche %s fehlgeschlagen: %s", s, e)
                continue
            candidates += [c for c in (info or {}).get("entries") or [] if c and (c.get("url") or c.get("id"))]
            best = max(candidates, key=lambda c: _score(track, c), default=None)
            if best and _score(track, best) >= 75:
                break
    if not candidates:
        return None
    best = max(candidates, key=lambda c: _score(track, c))
    if _score(track, best) < 35:
        return None
    vid = best.get("id")
    return f"https://www.youtube.com/watch?v={vid}" if vid else best.get("url")


class SpotifyMetadataPP(PostProcessor):
    """Ersetzt die YouTube-Metadaten durch die von Spotify (vor dem Download)."""

    def __init__(self, track: dict[str, Any], downloader=None):
        super().__init__(downloader)
        self.track = track

    def run(self, info):
        t = self.track
        artists = t.get("artists") or []
        if t.get("title"):
            info["track"] = t["title"]
            info["title"] = f"{', '.join(artists)} - {t['title']}" if artists else t["title"]
        if artists:
            info["artist"] = ", ".join(artists)
            info["artists"] = artists
            info["album_artist"] = artists[0]
            info["uploader"] = artists[0]
        if t.get("album"):
            info["album"] = t["album"]
        if t.get("year"):
            info["release_year"] = t["year"]
            info["upload_date"] = f"{t['year']}0101"
        if t.get("cover"):
            info["thumbnails"] = [{"url": t["cover"], "id": "spotify"}]
            info["thumbnail"] = t["cover"]
        for k in ("description", "comment", "synopsis"):
            info.pop(k, None)
        return [], info
