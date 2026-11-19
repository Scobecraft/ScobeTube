"""ScobeTube-Konto mit Spotify verbinden: Verlauf, Top-Interpreten/-Songs und Hörprofil.

Anmeldung über OAuth 2.0 mit PKCE – dafür braucht es nur die Client-ID einer eigenen
Spotify-App (developer.spotify.com), kein Client-Secret. Gespeichert wird pro Benutzer nur der
Zugangs-Token (Datei mit Rechten 0600); „Trennen“ löscht ihn sofort.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.request
from collections import Counter
from typing import Any
from urllib.parse import urlencode

from . import config, imgproxy

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API = "https://api.spotify.com/v1"
SCOPES = "user-read-private user-read-email user-read-recently-played user-top-read user-read-currently-playing"
APP_FILE = config.STATE_DIR / "spotify_app.json"
LINKS_FILE = config.STATE_DIR / "spotify_links.json"
RANGES = ("short_term", "medium_term", "long_term")

_lock = threading.RLock()
_links: dict[str, Any] | None = None
_pending: dict[str, dict[str, Any]] = {}     # state → {user, verifier, redirect, ts}
_cache: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}


class NotLinked(Exception):
    pass


# ------------------------------------------------------------ app-einstellungen
def app_settings() -> dict[str, Any]:
    try:
        data = json.loads(APP_FILE.read_text("utf-8"))
    except (OSError, ValueError):
        data = {}
    return {"client_id": data.get("client_id") or os.environ.get("SPOTIFY_CLIENT_ID", "")}


def set_client_id(client_id: str) -> None:
    cid = client_id.strip()
    if cid and (len(cid) != 32 or not all(c in "0123456789abcdef" for c in cid.lower())):
        raise ValueError("Die Client-ID ist 32 Zeichen lang (nur 0-9 und a-f)")
    APP_FILE.parent.mkdir(parents=True, exist_ok=True)
    APP_FILE.write_text(json.dumps({"client_id": cid}), "utf-8")


def configured() -> bool:
    return bool(app_settings()["client_id"])


# ------------------------------------------------------------ token-speicher
def _load() -> dict[str, Any]:
    global _links
    if _links is None:
        try:
            _links = json.loads(LINKS_FILE.read_text("utf-8"))
        except (OSError, ValueError):
            _links = {}
    return _links


def _save() -> None:
    LINKS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = LINKS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(_load()), "utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(LINKS_FILE)


def linked(username: str) -> dict[str, Any] | None:
    with _lock:
        link = _load().get(username.lower())
        return {"name": link.get("name"), "since": link.get("since"), "id": link.get("spotify_id")} if link else None


def unlink(username: str) -> bool:
    with _lock:
        gone = _load().pop(username.lower(), None)
        _save()
        for key in [k for k in _cache if k[0] == username.lower()]:
            _cache.pop(key, None)
        return gone is not None


# ------------------------------------------------------------ oauth (pkce)
def start(username: str, redirect_uri: str) -> str:
    cid = app_settings()["client_id"]
    if not cid:
        raise RuntimeError("Spotify ist noch nicht eingerichtet – der Admin muss zuerst eine Client-ID hinterlegen")
    verifier = secrets.token_urlsafe(64)[:96]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(24)
    now = time.time()
    with _lock:
        for k in [k for k, v in _pending.items() if now - v["ts"] > 600]:
            _pending.pop(k, None)
        _pending[state] = {"user": username.lower(), "verifier": verifier, "redirect": redirect_uri, "ts": now}
    return AUTH_URL + "?" + urlencode({
        "client_id": cid, "response_type": "code", "redirect_uri": redirect_uri, "scope": SCOPES,
        "state": state, "code_challenge_method": "S256", "code_challenge": challenge})


def _token_request(fields: dict[str, str]) -> dict[str, Any]:
    req = urllib.request.Request(TOKEN_URL, data=urlencode(fields).encode(), method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode()).get("error_description")
        except (ValueError, AttributeError):
            msg = None
        raise RuntimeError(msg or f"Spotify lehnt die Anmeldung ab (HTTP {e.code})") from e


def drop(state: str) -> None:
    with _lock:
        _pending.pop(state, None)


def finish(state: str, code: str) -> tuple[str, dict[str, Any]]:
    """Code gegen Token tauschen. Der Benutzer ergibt sich aus dem einmaligen „state“."""
    with _lock:
        p = _pending.pop(state, None) if state else None
    if not p or time.time() - p["ts"] > 600:
        raise RuntimeError("Die Verbindung ist abgelaufen – bitte noch einmal versuchen")
    username = p["user"]
    tok = _token_request({"grant_type": "authorization_code", "code": code, "redirect_uri": p["redirect"],
                          "client_id": app_settings()["client_id"], "code_verifier": p["verifier"]})
    link = {"access": tok["access_token"], "refresh": tok.get("refresh_token"),
            "expires": time.time() + int(tok.get("expires_in", 3600)) - 60, "since": time.time()}
    with _lock:
        _load()[username.lower()] = link
    me = _get(username, "/me")
    with _lock:
        link["name"] = me.get("display_name") or me.get("id")
        link["spotify_id"] = me.get("id")
        _save()
    return username, linked(username) or {}


def _access(username: str) -> str:
    with _lock:
        link = _load().get(username.lower())
        if not link:
            raise NotLinked()
        if time.time() < link.get("expires", 0):
            return link["access"]
        refresh = link.get("refresh")
    if not refresh:
        unlink(username)
        raise NotLinked()
    try:
        tok = _token_request({"grant_type": "refresh_token", "refresh_token": refresh,
                              "client_id": app_settings()["client_id"]})
    except RuntimeError:
        unlink(username)   # Zugriff in Spotify entzogen → Verbindung sauber lösen
        raise NotLinked() from None
    with _lock:
        link["access"] = tok["access_token"]
        link["refresh"] = tok.get("refresh_token") or refresh
        link["expires"] = time.time() + int(tok.get("expires_in", 3600)) - 60
        _save()
        return link["access"]


def _get(username: str, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    url = API + path + ("?" + urlencode(params) if params else "")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {_access(username)}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            body = r.read()
            return json.loads(body.decode()) if body else {}
    except urllib.error.HTTPError as e:
        if e.code == 401:
            with _lock:
                link = _load().get(username.lower())
                if link:
                    link["expires"] = 0
            raise RuntimeError("Spotify-Anmeldung abgelaufen – bitte neu laden") from e
        if e.code == 403:
            raise RuntimeError("Spotify verweigert den Zugriff. In der Entwickler-Ansicht deiner Spotify-App muss "
                               "dein Spotify-Konto unter „User Management“ eingetragen sein.") from e
        if e.code == 429:
            raise RuntimeError("Spotify bremst gerade (zu viele Anfragen) – kurz warten") from e
        raise RuntimeError(f"Spotify-Fehler (HTTP {e.code})") from e


# ------------------------------------------------------------ daten aufbereiten
def _img(images: list[dict[str, Any]] | None) -> str | None:
    if not images:
        return None
    best = sorted(images, key=lambda i: abs((i.get("width") or 300) - 300))[0]
    return imgproxy.wrap(best.get("url"))


def _track(t: dict[str, Any]) -> dict[str, Any]:
    alb = t.get("album") or {}
    return {"id": t.get("id"), "name": t.get("name"), "artists": [a.get("name") for a in t.get("artists") or []],
            "album": alb.get("name"), "image": _img(alb.get("images")), "duration": (t.get("duration_ms") or 0) / 1000,
            "url": (t.get("external_urls") or {}).get("spotify"), "popularity": t.get("popularity"),
            "explicit": t.get("explicit"), "release": alb.get("release_date")}


def _artist(a: dict[str, Any]) -> dict[str, Any]:
    return {"id": a.get("id"), "name": a.get("name"), "image": _img(a.get("images")), "genres": a.get("genres") or [],
            "url": (a.get("external_urls") or {}).get("spotify"), "popularity": a.get("popularity"),
            "followers": (a.get("followers") or {}).get("total")}


def profile(top_tracks: list[dict], top_artists: list[dict], long_artists: list[dict], recent: list[dict]) -> dict[str, Any]:
    """Hörprofil aus den Rohdaten (reine Rechnung, damit testbar)."""
    genres: Counter[str] = Counter()
    for rank, a in enumerate(top_artists):
        for g in a.get("genres") or []:
            genres[g] += max(1, 20 - rank)
    total_g = sum(genres.values()) or 1
    pops = [t["popularity"] for t in top_tracks if isinstance(t.get("popularity"), (int, float))]
    decades: Counter[str] = Counter()
    for t in top_tracks:
        y = (t.get("release") or "")[:4]
        if y.isdigit():
            decades[f"{y[:3]}0er"] += 1
    short_ids = {a["id"] for a in top_artists}
    long_ids = {a["id"] for a in long_artists}
    loyalty = round(100 * len(short_ids & long_ids) / len(short_ids)) if short_ids and long_ids else None
    rec_artists = Counter(a for r in recent for a in r["artists"][:1])
    rec_tracks = Counter((r["name"], ", ".join(r["artists"])) for r in recent)
    on_repeat = rec_tracks.most_common(1)[0] if rec_tracks else None
    explicit = [t for t in top_tracks if t.get("explicit") is not None]
    durations = [t["duration"] for t in top_tracks if t.get("duration")]
    mainstream = round(sum(pops) / len(pops)) if pops else None
    return {
        "genres": [{"name": g, "share": round(100 * w / total_g)} for g, w in genres.most_common(8)],
        "mainstream": mainstream,
        "mainstream_label": None if mainstream is None else
            "Voll im Trend" if mainstream >= 70 else "Gute Mischung" if mainstream >= 45 else "Underground-Entdecker",
        "decades": [{"name": d, "count": n} for d, n in sorted(decades.items())],
        "loyalty": loyalty,
        "recent_minutes": round(sum(r["duration"] for r in recent) / 60),
        "recent_unique_artists": len(rec_artists),
        "recent_top_artist": rec_artists.most_common(1)[0][0] if rec_artists else None,
        "on_repeat": {"name": on_repeat[0][0], "artists": on_repeat[0][1], "plays": on_repeat[1]}
                     if on_repeat and on_repeat[1] > 1 else None,
        "explicit_share": round(100 * sum(1 for t in explicit if t["explicit"]) / len(explicit)) if explicit else None,
        "avg_length": round(sum(durations) / len(durations)) if durations else None,
    }


def overview(username: str, time_range: str = "short_term", fresh: bool = False) -> dict[str, Any]:
    if time_range not in RANGES:
        time_range = "short_term"
    key = (username.lower(), time_range)
    hit = _cache.get(key)
    if hit and not fresh and time.time() - hit[0] < 120:
        return hit[1]
    me = _get(username, "/me")
    top_t = [_track(t) for t in _get(username, "/me/top/tracks", {"limit": 30, "time_range": time_range}).get("items", [])]
    top_a = [_artist(a) for a in _get(username, "/me/top/artists", {"limit": 20, "time_range": time_range}).get("items", [])]
    long_a = top_a if time_range == "long_term" else \
        [_artist(a) for a in _get(username, "/me/top/artists", {"limit": 20, "time_range": "long_term"}).get("items", [])]
    recent = []
    for r in _get(username, "/me/player/recently-played", {"limit": 50}).get("items", []):
        t = _track(r.get("track") or {})
        t["played_at"] = r.get("played_at")
        recent.append(t)
    now = None
    try:
        cur = _get(username, "/me/player/currently-playing")
        if cur and cur.get("item") and cur.get("currently_playing_type") == "track":
            now = {**_track(cur["item"]), "playing": cur.get("is_playing"), "progress": (cur.get("progress_ms") or 0) / 1000}
    except RuntimeError:
        pass
    data = {
        "me": {"name": me.get("display_name") or me.get("id"), "image": _img(me.get("images")),
               "followers": (me.get("followers") or {}).get("total"), "country": me.get("country"),
               "product": me.get("product"), "url": (me.get("external_urls") or {}).get("spotify")},
        "range": time_range, "now": now, "top_tracks": top_t, "top_artists": top_a, "recent": recent,
        "profile": profile(top_t, top_a, long_a, recent), "fetched": time.time(),
    }
    _cache[key] = (time.time(), data)
    return data
