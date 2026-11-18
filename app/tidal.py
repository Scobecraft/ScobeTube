"""Tidal-Unterstützung – nach demselben Prinzip wie Spotify.

Tidal-Audio ist DRM-geschützt und wird NICHT von Tidal geladen. ScobeTube liest nur die öffentlichen
Angaben (Titel, Interpreten, Album, Cover, Länge, ISRC) von Tidals Einbettungs- und Song-Seiten,
sucht denselben Song auf YouTube Music und schreibt die Tidal-Angaben samt Cover in die Datei.
"""
from __future__ import annotations

import html
import json
import logging
import re
import urllib.request
from typing import Any

log = logging.getLogger("scobetube.tidal")

URL_RE = re.compile(
    r"https?://(?:www\.|listen\.|embed\.)?tidal\.com/(?:browse/)?(?:[a-z]{2}/)?"
    r"(track|album|playlist|mix|tracks|albums|playlists|mixes)/(?:[a-z0-9-]+/)?([A-Za-z0-9-]+)", re.I)
_KIND = {"tracks": "track", "albums": "album", "playlists": "playlist", "mixes": "mix"}
_UA = "Mozilla/5.0 (compatible; ScobeTube)"


def parse_url(url: str) -> tuple[str, str] | None:
    m = URL_RE.search(url or "")
    if not m:
        return None
    kind = _KIND.get(m.group(1).lower(), m.group(1).lower())
    return kind, m.group(2)


def _get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=20) as r:  # noqa: S310 – feste Tidal-Hosts
        return r.read(3_000_000).decode("utf-8", "replace")


def _embed(kind: str, tid: str) -> tuple[dict[str, Any], str]:
    page = _get(f"https://embed.tidal.com/{kind}s/{tid}")
    m = re.search(r"tidalMediaSessionMetadata\s*=\s*(\{.*?\});", page, re.S)
    if not m:
        raise RuntimeError("Tidal-Seite konnte nicht gelesen werden (privat oder nicht verfügbar?)")
    return json.loads(m.group(1)), page


def _artists(text: str) -> list[str]:
    return [a.strip() for a in re.split(r",\s*|\s+&\s+", text or "") if a.strip()]


def _best_art(meta: dict[str, Any]) -> str | None:
    arts = meta.get("artwork") or []
    if not arts:
        return None
    return max(arts, key=lambda a: int(str(a.get("sizes", "0x0")).split("x")[0] or 0)).get("src")


def _iso_duration(d: str | None) -> float | None:
    m = re.fullmatch(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?", d or "")
    if not m:
        return None
    h, mi, s = (float(x) if x else 0.0 for x in m.groups())
    return h * 3600 + mi * 60 + s or None


def _title_of(kind: str, tid: str, embed_page: str) -> str:
    """Name von Album/Playlist – aus der Tidal-Seite (og:title), sonst aus dem Embed."""
    try:
        page = _get(f"https://tidal.com/{kind}/{tid}")
        m = re.search(r'<meta property="og:title" content="([^"]*)"', page)
        if m:
            return html.unescape(m.group(1)).strip()
    except Exception:  # noqa: BLE001
        pass
    m = re.search(r"<title>(.*?)</title>", embed_page, re.S)
    return html.unescape(m.group(1)).replace(" on TIDAL", "").strip() if m else "Tidal"


def resolve(url: str) -> dict[str, Any]:
    parsed = parse_url(url)
    if not parsed:
        raise ValueError("Kein Tidal-Link")
    kind, tid = parsed
    if kind == "mix":
        raise ValueError("Tidal-Mixe sind persönlich und nicht öffentlich lesbar – bitte einen Song, ein Album oder eine Playlist teilen")
    meta, page = _embed(kind, tid)
    tracks = []
    for track_id, t in meta.items():
        tracks.append({"id": str(track_id), "title": t.get("title"), "artists": _artists(t.get("artist", "")),
                       "album": t.get("album"), "cover": _best_art(t), "duration": None})
    if not tracks:
        raise RuntimeError("Keine Songs gefunden")
    title = tracks[0]["title"] if kind == "track" else _title_of(kind, tid, page)
    return {"kind": kind, "id": tid, "title": title or "Tidal", "cover": tracks[0].get("cover"), "tracks": tracks}


def track_details(track: dict[str, Any]) -> dict[str, Any]:
    """Ergänzt Länge, alle Interpreten, Album, Jahr und ISRC von der Song-Seite (best effort)."""
    out = dict(track)
    try:
        page = _get(f"https://tidal.com/track/{track['id']}")
        for m in re.finditer(r'<script type="application/ld\+json">(.*?)</script>', page, re.S):
            try:
                d = json.loads(m.group(1))
            except ValueError:
                continue
            if d.get("@type") != "MusicRecording":
                continue
            out["duration"] = _iso_duration(d.get("duration")) or out.get("duration")
            artists = [a.get("name") for a in d.get("byArtist") or [] if a.get("name")]
            if artists:
                out["artists"] = artists
            if (d.get("inAlbum") or {}).get("name"):
                out.setdefault("album", d["inAlbum"]["name"])
            if d.get("isrcCode"):
                out["isrc"] = d["isrcCode"]
            if d.get("name"):
                out["title"] = d["name"]
        year = re.search(r'<meta property="music:release_date" content="(\d{4})', page)
        if year:
            out["year"] = int(year.group(1))
    except Exception as e:  # noqa: BLE001
        log.debug("Tidal-Details für %s nicht verfügbar: %s", track.get("id"), e)
    return out
