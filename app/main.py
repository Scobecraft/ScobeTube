"""ScobeTube – Web-API und Oberfläche."""
from __future__ import annotations

import asyncio
import hashlib
import html
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

import segno
import webauthn
import yt_dlp
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
from webauthn.helpers.structs import (AuthenticatorSelectionCriteria, AuthenticatorTransport,
                                      PublicKeyCredentialDescriptor, ResidentKeyRequirement,
                                      UserVerificationRequirement)
from fastapi import APIRouter, FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import config
from . import audit, history, imgproxy, library, lyrics, notify, quota, recognize, spotify_account, tags
from .legal import legal
from . import appdist
from .healer import healer
from .sysmon import sysmon
from . import auth
from .auth import COOKIE_NAME, PERMISSIONS, User, limiter, tickets, users
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
            await asyncio.to_thread(imgproxy.cleanup)
            await asyncio.to_thread(audit.prune)
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
    healer.load()
    healer.restart = _restart
    healer.active_count = manager.active_count
    for item_id in healer.take_retry_ids():  # nach einer Reparatur: Fehlgeschlagenes neu versuchen
        manager.retry(item_id)
    heal_task = asyncio.create_task(healer.run())
    app_task = asyncio.create_task(appdist.run())
    cleaner = asyncio.create_task(_cleanup_loop())
    monitor = asyncio.create_task(sysmon.run())
    log.info("ScobeTube %s gestartet – yt-dlp %s – Downloads: %s – Auto-Löschung: %s",
             config.APP_VERSION, yt_dlp.version.__version__, config.DOWNLOAD_DIR,
             f"{config.RETENTION_HOURS:g} Std." if config.RETENTION_HOURS else "aus")
    yield
    cleaner.cancel()
    monitor.cancel()
    heal_task.cancel()
    app_task.cancel()
    manager.save()


app = FastAPI(title="ScobeTube", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
api = APIRouter(prefix="/api")


# ------------------------------------------------------- sicherheit
PUBLIC_PATHS = {"/login", "/healthz", "/manifest.webmanifest", "/api/auth/status", "/api/auth/login",
                "/api/auth/setup", "/api/auth/login/2fa", "/rechtliches", "/api/legal", "/api/legal/reset", "/robots.txt", "/sw.js", "/share",
                "/api/app/version", "/app/download", "/api/auth/login/passkey/options", "/api/auth/login/passkey",
                "/api/spotify-account/callback"}
PUBLIC_STATIC = {"/static/style.css", "/static/login.js", "/static/webauthn.js", "/static/eggs.js", "/static/legal.js", "/static/md.js",
                 "/static/icon.svg", "/static/icon-192.png", "/static/icon-512.png",
                 "/static/icon-maskable-512.png", "/static/potato.js"}
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

CSP = ("default-src 'self'; "
       "script-src 'self'; "
       "style-src 'self'; "
       "font-src 'self'; "
       "img-src 'self' data: blob:; "
       "connect-src 'self'; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'")
SECURITY_HEADERS = {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "X-Robots-Tag": "noindex, nofollow, noarchive",   # private Instanz – nicht in Suchmaschinen
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
    """Schutz vor CSRF: schreibende Anfragen müssen von unserer eigenen Seite kommen.

    1. Eigener Header X-ScobeTube: Browser senden ihn von fremden Seiten nie mit
       (er erzwingt einen CORS-Preflight, den ScobeTube nie erlaubt).
    2. Sec-Fetch-Site (vom Browser gesetzt) darf nicht „cross-site“/„same-site“ sein.
    3. Nur bei älteren Browsern ohne Sec-Fetch-Site: Origin grob mit Host vergleichen –
       tolerant gegenüber Reverse-Proxys und Port-Weiterleitungen.
    """
    if request.headers.get("x-scobetube") != "1":
        return False
    site = request.headers.get("sec-fetch-site")
    if site is not None:
        return site in ("same-origin", "none")
    origin = request.headers.get("origin")
    if not origin or origin == "null":
        return True
    origin_host = (urlparse(origin).hostname or "").lower()
    candidates = {request.headers.get("host", ""), request.headers.get("x-forwarded-host", "")}
    hosts = {(urlparse("//" + h.split(",")[0].strip()).hostname or "").lower() for h in candidates if h}
    return origin_host in hosts


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
        if key:
            users.touch_ip(key, _client_ip(request))
        public = path in PUBLIC_PATHS or path in PUBLIC_STATIC or path.startswith("/static/fonts/")
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
    elif path.startswith("/static/"):
        # Mit Versionskennung (?v=…) darf ewig gecacht werden – die Adresse ändert sich bei jedem Update.
        # Ohne Kennung: immer kurz beim Server nachfragen (ETag), damit nie alte Dateien hängen bleiben.
        response.headers["Cache-Control"] = ("public, max-age=31536000, immutable" if request.query_params.get("v")
                                             else "no-cache")
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
    """Sichtbar: eigene Downloads, mit mir geteilte – oder alles mit „view_all“."""
    if user.has("view_all"):
        return lambda item: True
    name = user.username.lower()
    return lambda item: (item.owner or "").lower() == name or name in item.shared_with


def _owned(user: User):
    """Verändern/Löschen darf nur der Besitzer (oder wer alle Downloads verwalten darf)."""
    if user.has("view_all"):
        return lambda item: True
    name = user.username.lower()
    return lambda item: (item.owner or "").lower() == name


def _item_for(user: User, item_id: str) -> Item:
    item = manager.get(item_id)
    if not item or not _visible(user)(item):
        raise HTTPException(404, "Nicht gefunden")
    return item


def _owned_item(user: User, item_id: str) -> Item:
    item = _item_for(user, item_id)
    if not _owned(user)(item):
        raise HTTPException(403, "Das ist ein geteilter Download – ändern kann ihn nur, wer ihn geteilt hat")
    return item


def _is_https(request: Request) -> bool:
    """Verschlüsselte Verbindung? (direkt, über vertrauten Proxy oder laut Browser-Origin)"""
    if request.url.scheme == "https":
        return True
    origin = request.headers.get("origin") or request.headers.get("referer") or ""
    return origin.startswith("https://")


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
    return {**user.public(), "effective": user.effective_permissions(), "usage": usage,
            "quota": quota.info(user, usage.get("bytes_now", 0)), "spotify": spotify_account.linked(user.username)}


def _audit(request: Request | None, cat: str, action: str, detail: str | None = None,
           target: str | None = None, user: str | None = None) -> None:
    if user is None and request is not None:
        u = getattr(request.state, "user", None)
        user = u.username if u else None
    audit.record(cat, action, user=user, ip=_client_ip(request) if request is not None else None,
                 detail=detail, target=target)


_fail_alerted: dict[str, float] = {}


def _alert_failed_logins(username: str, ip: str) -> None:
    """Ab 5 Fehlversuchen pro Stunde bei einem echten Konto: Admins benachrichtigen (höchstens stündlich)."""
    user = users.get(username)
    if not user:
        return
    n = audit.recent_failures(user.username)
    key = user.username.lower()
    if n >= 5 and time.time() - _fail_alerted.get(key, 0) > 3600:
        _fail_alerted[key] = time.time()
        notify.send_admins(users, "⚠ Verdächtige Anmeldeversuche",
                           f"{n} Fehlversuche für „{user.username}“ in der letzten Stunde (zuletzt von {ip}).",
                           kind="security", link="#audit")


def _quota_full(owner: str) -> str | None:
    user = users.get(owner)
    lim = quota.limit_bytes(user) if user else None
    if lim is None:
        return None
    used = manager.usage().get(owner.lower(), _EMPTY_USAGE).get("bytes_now", 0)
    if used >= lim:
        return (f"Dein Speicher-Kontingent ({_fmt_gb(lim)}) ist voll. Lösche alte Downloads oder fordere "
                f"im Profilmenü mehr Speicher an.")
    return None


def _fmt_gb(b: int | float) -> str:
    if b < quota.GB:
        return f"{b / 1024 ** 2:.0f} MB"
    return f"{b / quota.GB:.1f}".rstrip("0").rstrip(".").replace(".", ",") + " GB"


manager.quota_check = _quota_full


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
        audit.record("login_failed", "Falsches Passwort", ip=ip, target=username,
                     detail=None if users.get(username) else "Konto existiert nicht")
        _alert_failed_logins(username, ip)
        await asyncio.sleep(random.uniform(0.4, 0.9))
        raise HTTPException(401, "Benutzername oder Passwort falsch")
    if user.twofa:
        # Passwort stimmt – jetzt der zweite Faktor
        ticket = tickets.create(user.username, remember, ip)
        return {"twofa": True, "ticket": ticket,
                "methods": {"totp": bool(user.totp_secret), "passkey": bool(user.passkeys),
                            "recovery": bool(user.recovery_codes)}}
    limiter.succeeded(ip, username)
    return _login_response(request, user, remember)


def _login_response(request: Request, user: User, remember: bool) -> JSONResponse:
    ip = _client_ip(request)
    token, ttl = users.create_session(user, remember, ip, request.headers.get("user-agent", ""))
    log.info("Anmeldung: %s von %s", user.username, ip)
    agent = auth.describe_agent(request.headers.get("user-agent", ""))
    audit.record("login", "Angemeldet", user=user.username, ip=ip,
                 detail=f"{agent['browser']} auf {agent['system']}" + (" · angemeldet bleiben" if remember else ""))
    response = JSONResponse({"ok": True, "user": _me(user)})
    _set_session_cookie(request, response, token, ttl if remember else None)
    return response


async def _second_factor_failed(request: Request, ticket_id: str, username: str, msg: str):
    t = tickets.get(ticket_id)
    if t:
        t.attempts += 1
    limiter.failed(_client_ip(request), username)
    log.warning("Falscher zweiter Faktor für „%s“ von %s", username, _client_ip(request))
    audit.record("login_failed", "Falscher zweiter Faktor", ip=_client_ip(request), target=username)
    _alert_failed_logins(username, _client_ip(request))
    await asyncio.sleep(random.uniform(0.4, 0.9))
    raise HTTPException(401, msg)


def _ticket_user(request: Request, ticket_id: str):
    t = tickets.get(ticket_id)
    user = users.get(t.username) if t else None
    if not t or not user or user.disabled:
        # 410 = „abgelaufen“: die Seite bietet dann „Zurück zur Anmeldung“ an
        raise HTTPException(410, "Die Anmeldung ist abgelaufen (nach 5 Minuten oder 5 Fehlversuchen). "
                                 "Bitte noch einmal mit Passwort anmelden.")
    wait = limiter.retry_after(t.ip, user.username)
    if wait:
        raise HTTPException(429, f"Zu viele Fehlversuche. Bitte in {max(1, round(wait / 60))} Minuten erneut versuchen.")
    return t, user


@api.post("/auth/login/2fa")
async def auth_login_code(request: Request):
    """Zweiter Schritt mit Code aus der Authenticator-App oder Wiederherstellungscode."""
    data = await _json(request)
    ticket_id = str(data.get("ticket", ""))
    t, user = _ticket_user(request, ticket_id)
    code = str(data.get("code", "")).strip()[:32]
    ok = False
    with users.lock:
        if user.totp_secret:
            step = auth.totp_match(user.totp_secret, code, user.totp_last_step)
            if step:
                user.totp_last_step = step
                ok = True
        if not ok and auth.use_recovery_code(user, code):
            ok = True
            log.warning("%s hat einen Wiederherstellungscode benutzt (%d übrig)", user.username, len(user.recovery_codes))
            audit.record("security", "Wiederherstellungscode benutzt", user=user.username, ip=_client_ip(request),
                         detail=f"{len(user.recovery_codes)} übrig")
        if ok:
            users.save()
    if not ok:
        await _second_factor_failed(request, ticket_id, user.username, "Code ist falsch oder abgelaufen")
    tickets.consume(ticket_id)
    limiter.succeeded(_client_ip(request), user.username)
    return _login_response(request, user, t.remember)


def _rp(request: Request) -> tuple[str, str]:
    """Relying-Party-ID und Origin für Passkeys (überschreibbar per Umgebungsvariable)."""
    # Adresse aus Sicht des Browsers (Origin-Header) – funktioniert auch hinter Reverse-Proxys
    browser_origin = request.headers.get("origin") or f"{request.url.scheme}://{request.url.netloc}"
    rp_id = os.environ.get("WEBAUTHN_RP_ID") or (urlparse(browser_origin).hostname or "localhost")
    origin = os.environ.get("WEBAUTHN_ORIGIN") or browser_origin
    return rp_id, origin


@api.post("/auth/login/passkey/options")
async def passkey_login_options(request: Request):
    data = await _json(request)
    t, user = _ticket_user(request, str(data.get("ticket", "")))
    if not user.passkeys:
        raise HTTPException(400, "Für dieses Konto ist kein Passkey eingerichtet")
    rp_id, _ = _rp(request)
    opts = webauthn.generate_authentication_options(
        rp_id=rp_id,
        allow_credentials=[PublicKeyCredentialDescriptor(id=base64url_to_bytes(pk["id"]),
                                                         transports=[AuthenticatorTransport(x) for x in pk.get("transports", [])
                                                                     if x in AuthenticatorTransport._value2member_map_])
                           for pk in user.passkeys],
        user_verification=UserVerificationRequirement.PREFERRED)
    t.challenge = opts.challenge
    return Response(webauthn.options_to_json(opts), media_type="application/json")


@api.post("/auth/login/passkey")
async def passkey_login(request: Request):
    data = await _json(request)
    ticket_id = str(data.get("ticket", ""))
    t, user = _ticket_user(request, ticket_id)
    cred = data.get("credential") or {}
    pk = next((p for p in user.passkeys if p["id"] == cred.get("id")), None)
    if not pk or not t.challenge:
        await _second_factor_failed(request, ticket_id, user.username, "Dieser Passkey gehört nicht zu diesem Konto")
    rp_id, origin = _rp(request)
    try:
        result = webauthn.verify_authentication_response(
            credential=cred, expected_challenge=t.challenge, expected_rp_id=rp_id, expected_origin=origin,
            credential_public_key=base64url_to_bytes(pk["public_key"]),
            credential_current_sign_count=pk.get("sign_count", 0))
    except Exception as e:  # noqa: BLE001
        log.info("Passkey-Prüfung fehlgeschlagen: %s", e)
        await _second_factor_failed(request, ticket_id, user.username, "Passkey konnte nicht bestätigt werden")
    with users.lock:
        pk["sign_count"] = result.new_sign_count
        pk["last_used"] = time.time()
        users.save()
    tickets.consume(ticket_id)
    limiter.succeeded(_client_ip(request), user.username)
    return _login_response(request, user, t.remember)


# -------------------------------------------------- 2fa verwalten
_pending_totp: dict[str, tuple[str, float]] = {}
_pending_passkey: dict[str, tuple[bytes, float]] = {}


async def _confirm_password(user: User, password: str) -> None:
    async with _hash_slots:
        ok = await asyncio.to_thread(users.authenticate, user.username, password or "")
    if not ok:
        await asyncio.sleep(random.uniform(0.4, 0.9))
        raise HTTPException(400, "Das Passwort ist falsch")


def _twofa_status(user: User) -> dict[str, Any]:
    return {"totp": bool(user.totp_secret), "recovery_left": len(user.recovery_codes),
            "passkeys": [{"id": p["id"], "name": p.get("name") or "Passkey", "created": p.get("created"),
                          "last_used": p.get("last_used")} for p in user.passkeys]}


def _ensure_recovery(user: User) -> list[str] | None:
    if user.recovery_codes:
        return None
    plain, hashed = auth.new_recovery_codes()
    user.recovery_codes = hashed
    return plain


# ---------------------------------------------------- angemeldete geräte
def _session_rows(username: str, current_key: str | None = None) -> list[dict[str, Any]]:
    rows = []
    for key, sess in users.user_sessions(username):
        rows.append({"id": auth.session_public_id(key), "current": key == current_key,
                     "created": sess.created, "last_seen": sess.last_seen or sess.created, "expires": sess.expires,
                     "ip": sess.last_ip or sess.ip, "first_ip": sess.ip, **auth.describe_agent(sess.user_agent)})
    return rows


def _key_for_public_id(username: str, public_id: str) -> str | None:
    return next((k for k, _ in users.user_sessions(username) if auth.session_public_id(k) == public_id), None)


@api.get("/auth/sessions")
async def my_sessions(request: Request):
    user = _user(request)
    return {"sessions": _session_rows(user.username, request.state.session_key)}


@api.post("/auth/sessions/revoke")
async def revoke_my_session(request: Request):
    user = _user(request)
    data = await _json(request)
    if data.get("others"):
        users.revoke_user_sessions(user.username, except_key=request.state.session_key)
        log.info("%s hat alle anderen Geräte abgemeldet", user.username)
        _audit(request, "security", "Alle anderen Geräte abgemeldet")
    else:
        key = _key_for_public_id(user.username, str(data.get("id", "")))
        if not key:
            raise HTTPException(404, "Sitzung nicht gefunden")
        users.revoke(key)
        log.info("%s hat ein Gerät abgemeldet", user.username)
        _audit(request, "security", "Ein Gerät abgemeldet")
    return {"sessions": _session_rows(user.username, request.state.session_key)}


@api.get("/users/{username}/sessions")
async def user_sessions_admin(username: str, request: Request):
    _need(request, "admin")
    if not users.get(username):
        raise HTTPException(404, "Benutzer nicht gefunden")
    return {"sessions": _session_rows(username, request.state.session_key)}


@api.post("/users/{username}/logout")
async def logout_user_admin(username: str, request: Request):
    admin = _need(request, "admin")
    if not users.get(username):
        raise HTTPException(404, "Benutzer nicht gefunden")
    users.revoke_user_sessions(username, except_key=request.state.session_key)
    log.warning("%s hat „%s“ auf allen Geräten abgemeldet", admin.username, username)
    _audit(request, "admin", "Benutzer überall abgemeldet", target=username)
    return {"ok": True}


@api.get("/auth/2fa")
async def twofa_status(request: Request):
    return _twofa_status(_user(request))


@api.post("/auth/2fa/totp/setup")
async def totp_setup(request: Request):
    user = _user(request)
    secret = auth.new_totp_secret()
    _pending_totp[user.username.lower()] = (secret, time.time() + 600)
    uri = auth.totp_uri(secret, user.username)
    qr = segno.make(uri, error="m").svg_data_uri(scale=6, dark="#0b0b0c", light="#f3f0e7", border=2)
    return {"secret": " ".join(secret[i:i + 4] for i in range(0, len(secret), 4)), "uri": uri, "qr": qr}


@api.post("/auth/2fa/totp/enable")
async def totp_enable(request: Request):
    user = _user(request)
    data = await _json(request)
    pending = _pending_totp.get(user.username.lower())
    if not pending or pending[1] < time.time():
        raise HTTPException(400, "Einrichtung abgelaufen – bitte neu starten")
    step = auth.totp_match(pending[0], str(data.get("code", "")))
    if not step:
        raise HTTPException(400, "Der Code stimmt nicht. Uhrzeit am Handy prüfen und den aktuellen Code eingeben.")
    with users.lock:
        user.totp_secret, user.totp_last_step = pending[0], step
        codes = _ensure_recovery(user)
        users.save()
    _pending_totp.pop(user.username.lower(), None)
    log.info("%s hat die Authenticator-App aktiviert", user.username)
    _audit(request, "security", "Authenticator-App aktiviert")
    return {**_twofa_status(user), "recovery_codes": codes}


@api.post("/auth/2fa/totp/disable")
async def totp_disable(request: Request):
    user = _user(request)
    data = await _json(request)
    await _confirm_password(user, str(data.get("password", "")))
    with users.lock:
        user.totp_secret, user.totp_last_step = None, 0
        if not user.passkeys:
            user.recovery_codes = []
        users.save()
    log.info("%s hat die Authenticator-App deaktiviert", user.username)
    _audit(request, "security", "Authenticator-App deaktiviert")
    return _twofa_status(user)


@api.post("/auth/2fa/recovery")
async def recovery_regenerate(request: Request):
    user = _user(request)
    data = await _json(request)
    await _confirm_password(user, str(data.get("password", "")))
    if not user.twofa:
        raise HTTPException(400, "Zwei-Faktor-Login ist nicht aktiv")
    with users.lock:
        plain, hashed = auth.new_recovery_codes()
        user.recovery_codes = hashed
        users.save()
    return {**_twofa_status(user), "recovery_codes": plain}


@api.post("/auth/passkey/register/options")
async def passkey_register_options(request: Request):
    user = _user(request)
    rp_id, _ = _rp(request)
    opts = webauthn.generate_registration_options(
        rp_id=rp_id, rp_name="ScobeTube", user_name=user.username, user_display_name=user.username,
        user_id=hashlib.sha256(("scobetube:" + user.username.lower()).encode()).digest(),
        exclude_credentials=[PublicKeyCredentialDescriptor(id=base64url_to_bytes(p["id"])) for p in user.passkeys],
        authenticator_selection=AuthenticatorSelectionCriteria(resident_key=ResidentKeyRequirement.PREFERRED,
                                                               user_verification=UserVerificationRequirement.PREFERRED))
    _pending_passkey[user.username.lower()] = (opts.challenge, time.time() + 300)
    return Response(webauthn.options_to_json(opts), media_type="application/json")


@api.post("/auth/passkey/register")
async def passkey_register(request: Request):
    user = _user(request)
    data = await _json(request)
    pending = _pending_passkey.pop(user.username.lower(), None)
    if not pending or pending[1] < time.time():
        raise HTTPException(400, "Einrichtung abgelaufen – bitte noch einmal versuchen")
    rp_id, origin = _rp(request)
    cred = data.get("credential") or {}
    try:
        v = webauthn.verify_registration_response(credential=cred, expected_challenge=pending[0],
                                                  expected_rp_id=rp_id, expected_origin=origin)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Passkey konnte nicht gespeichert werden: {e}") from e
    name = str(data.get("name") or "").strip()[:60] or "Passkey"
    transports = (cred.get("response") or {}).get("transports") or []
    with users.lock:
        if len(user.passkeys) >= 10:
            raise HTTPException(400, "Maximal 10 Passkeys pro Konto")
        user.passkeys.append({"id": bytes_to_base64url(v.credential_id),
                              "public_key": bytes_to_base64url(v.credential_public_key),
                              "sign_count": v.sign_count, "transports": [str(x) for x in transports][:5],
                              "name": name, "created": time.time(), "last_used": None})
        codes = _ensure_recovery(user)
        users.save()
    log.info("%s hat einen Passkey hinzugefügt (%s)", user.username, name)
    _audit(request, "security", "Passkey hinzugefügt", detail=name)
    return {**_twofa_status(user), "recovery_codes": codes}


@api.post("/auth/passkey/delete")
async def passkey_delete(request: Request):
    user = _user(request)
    data = await _json(request)
    await _confirm_password(user, str(data.get("password", "")))
    with users.lock:
        before = len(user.passkeys)
        user.passkeys = [p for p in user.passkeys if p["id"] != data.get("id")]
        if len(user.passkeys) == before:
            raise HTTPException(404, "Passkey nicht gefunden")
        if not user.twofa:
            user.recovery_codes = []
        users.save()
    return _twofa_status(user)


@api.post("/users/{username}/security")
async def admin_user_security(username: str, request: Request):
    """Notfall-Werkzeuge: App-2FA entfernen, einzelnen Passkey löschen, Wiederherstellungscodes löschen."""
    admin = _need(request, "admin")
    user = users.get(username)
    if not user:
        raise HTTPException(404, "Benutzer nicht gefunden")
    data = await _json(request)
    action = data.get("action")
    with users.lock:
        if action == "totp":
            user.totp_secret, user.totp_last_step = None, 0
            what = "Authenticator-App"
        elif action == "passkey":
            before = len(user.passkeys)
            user.passkeys = [p for p in user.passkeys if p["id"] != data.get("id")]
            if len(user.passkeys) == before:
                raise HTTPException(404, "Passkey nicht gefunden")
            what = "einen Passkey"
        elif action == "passkeys":
            user.passkeys = []
            what = "alle Passkeys"
        elif action == "recovery":
            user.recovery_codes = []
            what = "die Wiederherstellungscodes"
        else:
            raise HTTPException(400, "Unbekannte Aktion")
        if not user.twofa:
            user.recovery_codes = []
        if user.username.lower() != admin.username.lower():
            users.revoke_user_sessions(user.username, save=False)   # Sicherheits-Eingriff → überall abmelden
        users.save()
    log.warning("%s hat bei „%s“ %s entfernt", admin.username, user.username, what)
    _audit(request, "admin", "Notfall-Werkzeug benutzt", target=user.username, detail=f"{what} entfernt")
    return {**user.public(), "passkey_list": [{"id": p["id"], "name": p.get("name") or "Passkey",
                                               "created": p.get("created"), "last_used": p.get("last_used")}
                                              for p in user.passkeys]}


@api.post("/users/{username}/reset-2fa")
async def reset_user_2fa(username: str, request: Request):
    admin = _need(request, "admin")
    user = users.get(username)
    if not user:
        raise HTTPException(404, "Benutzer nicht gefunden")
    with users.lock:
        user.totp_secret, user.totp_last_step, user.recovery_codes, user.passkeys = None, 0, [], []
        users.revoke_user_sessions(user.username, save=False)
        users.save()
    log.warning("%s hat den Zwei-Faktor-Login von „%s“ zurückgesetzt", admin.username, user.username)
    _audit(request, "admin", "Zwei-Faktor-Login zurückgesetzt", target=user.username)
    return user.public()


@api.post("/auth/logout")
async def auth_logout(request: Request):
    if request.state.session_key:
        users.revoke(request.state.session_key)
        _audit(request, "login", "Abgemeldet")
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
    _audit(request, "security", "Passwort geändert")
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
    rows = [{**u.public(), "usage": usage.get(u.username.lower(), _EMPTY_USAGE),
             "passkey_list": [{"id": p["id"], "name": p.get("name") or "Passkey", "created": p.get("created"),
                               "last_used": p.get("last_used")} for p in u.passkeys]}
            for u in users.list()]
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
    _audit(request, "admin", "Benutzer angelegt", target=user.username, detail=", ".join(user.permissions) or "keine Rechte")
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
    changes = []
    if "quota_gb" in data:
        q = data["quota_gb"]
        try:
            q = None if q in (None, "") else max(0.0, min(100_000.0, float(q)))
        except (TypeError, ValueError):
            raise HTTPException(400, "Ungültiges Kontingent") from None
        user.quota_gb = q
        users.save()
        changes.append("Kontingent: " + ("Standard" if q is None else "unbegrenzt" if q == 0 else f"{q:g} GB"))
    if "permissions" in data:
        changes.append("Rechte: " + (", ".join(user.permissions) or "keine"))
    if "disabled" in data:
        changes.append("gesperrt" if data.get("disabled") else "entsperrt")
    if data.get("password"):
        changes.append("Passwort neu gesetzt")
    log.info("%s hat Benutzer „%s“ geändert", admin.username, user.username)
    _audit(request, "admin", "Benutzer geändert", target=user.username, detail="; ".join(changes))
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
    _audit(request, "admin", "Benutzer gelöscht", target=username)
    history.forget_user(username)
    notify.clear(username)
    spotify_account.unlink(username)
    return {"ok": True}


# ---------------------------------------------------- benachrichtigungen
notify.listeners.append(lambda user, msg: manager.emit("notify", {"user": user, "msg": msg}))


@api.get("/notifications")
async def notifications(request: Request, after: int = 0):
    return notify.list_for(_user(request).username, after)


@api.post("/notifications/read")
async def notifications_read(request: Request):
    data = await _json(request)
    notify.mark_read(_user(request).username, data.get("upto"))
    return {"ok": True}


# ---------------------------------------------------- verlauf
@api.get("/history")
async def history_list(request: Request, q: str = "", kind: str = "", offset: int = 0):
    user = _user(request)
    return history.list_for(user.username, q[:100], kind, max(0, offset))


@api.delete("/history/{entry_id}")
async def history_delete(entry_id: str, request: Request):
    if not history.delete(_user(request).username, entry_id):
        raise HTTPException(404, "Eintrag nicht gefunden")
    return {"ok": True}


@api.post("/history/clear")
async def history_clear(request: Request):
    n = history.clear(_user(request).username)
    _audit(request, "file", "Verlauf gelöscht", detail=f"{n} Einträge")
    return {"removed": n}


@api.post("/history/settings")
async def history_settings(request: Request):
    data = await _json(request)
    history.set_enabled(_user(request).username, bool(data.get("enabled", True)))
    return {"enabled": bool(data.get("enabled", True))}


@api.post("/history/{entry_id}/again")
async def history_again(entry_id: str, request: Request):
    user = _need(request, "download")
    e = history.get(user.username, entry_id)
    if not e:
        raise HTTPException(404, "Eintrag nicht gefunden")
    full = _quota_full(user.username)
    if full:
        raise HTTPException(507, full)
    try:
        options = Options.parse({"kind": e["kind"], "format": e["format"], "quality": e.get("quality") or "best"})
    except ValueError:
        options = Options.parse({"kind": e["kind"]})
    created = manager.add([e["url"]], options, owner=user.username)
    _audit(request, "download", "Erneut geladen (Verlauf)", detail=e.get("title"))
    return {"added": [i.id for i in created]}


# ---------------------------------------------------- speicher-kontingent
@api.get("/quota")
async def quota_me(request: Request):
    user = _user(request)
    used = manager.usage().get(user.username.lower(), _EMPTY_USAGE).get("bytes_now", 0)
    return quota.info(user, used)


@api.post("/quota/request")
async def quota_request(request: Request):
    user = _user(request)
    if user.is_admin:
        raise HTTPException(400, "Admins haben unbegrenzten Speicher")
    data = await _json(request)
    try:
        r = quota.request(user.username, float(data.get("gb") or 0), str(data.get("reason") or ""))
    except (TypeError, ValueError) as e:
        raise HTTPException(400, str(e) if isinstance(e, ValueError) and str(e) else "Ungültige Angabe") from e
    used = manager.usage().get(user.username.lower(), _EMPTY_USAGE).get("bytes_now", 0)
    lim = quota.limit_bytes(user)
    notify.send_admins(users, "💾 Speicher-Anfrage",
                       f"{user.username} möchte {r['gb']:g} GB (belegt: {_fmt_gb(used)} von "
                       f"{_fmt_gb(lim) if lim else 'unbegrenzt'})" + (f" – „{r['reason']}“" if r["reason"] else ""),
                       kind="quota", link="#quota")
    _audit(request, "quota", "Mehr Speicher angefragt", detail=f"{r['gb']:g} GB" + (f" – {r['reason']}" if r["reason"] else ""))
    return r


@api.post("/quota/request/cancel")
async def quota_request_cancel(request: Request):
    user = _user(request)
    if not quota.cancel(user.username):
        raise HTTPException(404, "Keine offene Anfrage")
    return {"ok": True}


@api.get("/quota/requests")
async def quota_requests(request: Request):
    _need(request, "admin")
    usage = manager.usage()
    rows = []
    for r in quota.list_requests():
        u = users.get(r["user"])
        rows.append({**r, "used": usage.get(r["user"].lower(), _EMPTY_USAGE).get("bytes_now", 0),
                     "limit": quota.limit_bytes(u) if u else None, "exists": bool(u)})
    return {"requests": rows, "default_gb": quota.DEFAULT_GB}


@api.post("/quota/requests/{req_id}")
async def quota_decide(req_id: str, request: Request):
    admin = _need(request, "admin")
    data = await _json(request)
    approve = bool(data.get("approve"))
    gb = data.get("gb")
    try:
        gb = float(gb) if gb not in (None, "") else None
        r = quota.decide(req_id, admin.username, approve, gb)
    except KeyError:
        raise HTTPException(404, "Anfrage nicht gefunden") from None
    except (TypeError, ValueError) as e:
        raise HTTPException(400, str(e) or "Ungültige Angabe") from e
    user = users.get(r["user"])
    if approve and user:
        user.quota_gb = r["granted_gb"]
        users.save()
    if user:
        notify.send(user.username, "💾 Mehr Speicher genehmigt" if approve else "💾 Speicher-Anfrage abgelehnt",
                    f"Dein Kontingent beträgt jetzt {r['granted_gb']:g} GB." if approve
                    else f"{admin.username} hat deine Anfrage über {r['gb']:g} GB abgelehnt.", kind="quota")
    _audit(request, "quota", "Speicher-Anfrage " + ("genehmigt" if approve else "abgelehnt"), target=r["user"],
           detail=f"{r['granted_gb'] or r['gb']:g} GB")
    return r


# ---------------------------------------------------- aktivitätsprotokoll
@api.get("/audit")
async def audit_list(request: Request, user: str = "", cat: str = "", q: str = "", before: str = ""):
    _need(request, "admin")
    data = await asyncio.to_thread(audit.query, user=user[:64], category=cat if cat in audit.CATEGORIES else "",
                                   q=q[:100], before=before[:40], limit=100)
    return {**data, "categories": audit.CATEGORIES, "choices": audit.RETENTION_CHOICES}


@api.post("/audit/settings")
async def audit_settings(request: Request):
    _need(request, "admin")
    data = await _json(request)
    try:
        days = audit.set_retention(int(data.get("days", 30)))
    except (TypeError, ValueError) as e:
        raise HTTPException(400, "Ungültige Aufbewahrungsdauer") from e
    _audit(request, "admin", "Protokoll-Aufbewahrung geändert", detail=f"{days} Tage")
    return {"days": days}


@api.post("/audit/clear")
async def audit_clear(request: Request):
    _need(request, "admin")
    await asyncio.to_thread(audit.clear)
    _audit(request, "admin", "Aktivitätsprotokoll geleert")
    return {"ok": True}


# ---------------------------------------------------- song erkennen
@api.post("/recognize")
async def recognize_song(request: Request):
    _need(request, "download")
    form = await request.form()
    upload = form.get("file")
    if upload is None or not hasattr(upload, "read"):
        raise HTTPException(400, "Keine Aufnahme erhalten")
    raw = await upload.read(recognize.MAX_UPLOAD + 1)
    try:
        res = await asyncio.wait_for(asyncio.to_thread(recognize.recognize, raw), timeout=90)
    except PermissionError as e:
        raise HTTPException(403, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except (RuntimeError, asyncio.TimeoutError) as e:
        raise HTTPException(502, str(e) or "Zeitüberschreitung bei der Erkennung") from e
    if res.get("cover"):
        res["cover"] = imgproxy.wrap(res["cover"])
    _audit(request, "download", "Song erkannt" if res.get("found") else "Song nicht erkannt",
           detail=f"{res.get('artist')} – {res.get('title')}" if res.get("found") else None)
    return res


@api.get("/recognize/settings")
async def recognize_settings_get(request: Request):
    _need(request, "admin")
    return recognize.public()


@api.put("/recognize/settings")
async def recognize_settings_put(request: Request):
    _need(request, "admin")
    data = await _json(request)
    res = recognize.update(data.get("enabled"), data.get("token"), bool(data.get("clear_token")))
    _audit(request, "admin", "Song-Erkennung eingestellt", detail="an" if res["enabled"] else "aus")
    return res


# ---------------------------------------------------- spotify-konto
def _spotify_redirect(request: Request) -> str:
    scheme = "https" if _is_https(request) else "http"
    host = (request.headers.get("host") or "localhost").split(",")[0].strip()
    return f"{scheme}://{host}{config.URL_PREFIX}/api/spotify-account/callback"


@api.get("/spotify-account")
async def spotify_status(request: Request):
    user = _user(request)
    return {"configured": spotify_account.configured(), "linked": spotify_account.linked(user.username),
            "redirect_uri": _spotify_redirect(request) if user.is_admin else None,
            "client_id": spotify_account.app_settings()["client_id"] if user.is_admin else None}


@api.put("/spotify-account/app")
async def spotify_app(request: Request):
    _need(request, "admin")
    data = await _json(request)
    try:
        spotify_account.set_client_id(str(data.get("client_id") or ""))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    _audit(request, "admin", "Spotify-App eingerichtet" if data.get("client_id") else "Spotify-App entfernt")
    return {"configured": spotify_account.configured()}


@api.post("/spotify-account/connect")
async def spotify_connect(request: Request):
    user = _user(request)
    try:
        return {"url": spotify_account.start(user.username, _spotify_redirect(request))}
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e


def _bounce(params: dict[str, str]) -> HTMLResponse:
    """Rücksprung von Spotify: Das Sitzungs-Cookie ist SameSite=Strict und fehlt bei einer Weiterleitung
    von fremder Seite. Eine kleine eigene Seite, die selbst weiterleitet, ist „same-site“ → Cookie wieder da."""
    target = html.escape("../../?" + urlencode(params), quote=True)
    return HTMLResponse(f'<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url={target}">'
                        f'<meta name="referrer" content="no-referrer"><title>ScobeTube</title>'
                        f'<p style="font-family:sans-serif">Weiter zu <a href="{target}">ScobeTube</a> …</p>',
                        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


@api.get("/spotify-account/callback")
async def spotify_callback(request: Request, state: str = "", code: str = "", error: str = ""):
    # Kein Sitzungs-Cookie hier (SameSite=Strict) – ausgewiesen wird über den einmaligen „state“
    if error or not code:
        spotify_account.drop(state)
        return _bounce({"spotify": "denied" if error == "access_denied" else "error"})
    try:
        username, info_ = await asyncio.to_thread(spotify_account.finish, state, code)
    except Exception as e:  # noqa: BLE001
        log.warning("Spotify-Verbindung fehlgeschlagen: %s", e)
        return _bounce({"spotify": "error", "msg": str(e)[:200]})
    _audit(request, "security", "Spotify verbunden", detail=info_.get("name"), user=username)
    return _bounce({"spotify": "connected"})


@api.post("/spotify-account/disconnect")
async def spotify_disconnect(request: Request):
    user = _user(request)
    if spotify_account.unlink(user.username):
        _audit(request, "security", "Spotify getrennt")
    return {"ok": True}


@api.get("/spotify-account/overview")
async def spotify_overview(request: Request, range: str = "short_term", fresh: bool = False):  # noqa: A002
    user = _user(request)
    try:
        return await asyncio.to_thread(spotify_account.overview, user.username, range, fresh)
    except spotify_account.NotLinked:
        raise HTTPException(409, "Nicht mit Spotify verbunden") from None
    except RuntimeError as e:
        raise HTTPException(502, str(e)) from e


# ------------------------------------------------------------------ api
@api.get("/info")
async def info(request: Request):
    _user(request)
    return {
        "version": config.APP_VERSION,
        "ytdlp": yt_dlp.version.__version__,
        "ytdlp_channel": healer.channel,
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
    full = _quota_full(user.username)
    if full:
        raise HTTPException(507, full)
    created = manager.add(urls, options, owner=user.username)
    _audit(request, "download", "Download gestartet", detail=f"{options.kind}/{options.format} · " + " ".join(urls[:3])
           + (f" (+{len(urls) - 3})" if len(urls) > 3 else ""))
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
    _owned_item(_need(request, "download"), item_id)
    if not manager.cancel(item_id):
        raise HTTPException(409, "Download ist nicht aktiv")
    return {"ok": True}


# ---------------------------------------------------- mediathek
def _to_library(item: Item, force: bool = False) -> bool:
    """Übernimmt einen Download in die Mediathek (falls eingestellt). Läuft im Thread."""
    if not (library.wanted(item) or (force and item.library)):
        return False
    try:
        item.library = library.export(item, manager.file_path(item))
        manager._update(item)
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("Mediathek-Export von %s fehlgeschlagen: %s", item.id, e)
        return False


def _on_done(item: Item) -> None:
    try:
        history.add(item)
    except Exception as e:  # noqa: BLE001
        log.warning("Verlauf: %s", e)
    _to_library(item)


manager.on_done = _on_done


@api.get("/library")
async def library_get(request: Request):
    _need(request, "admin")
    data = await asyncio.to_thread(library.public)
    data["count"] = sum(1 for i in manager.items.values() if i.library)
    return data


@api.put("/library")
async def library_put(request: Request):
    _need(request, "admin")
    try:
        data = await asyncio.to_thread(library.update, await _json(request))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    data["count"] = sum(1 for i in manager.items.values() if i.library)
    return data


@api.post("/library/test")
async def library_test(request: Request):
    _need(request, "admin")
    try:
        return {"message": await asyncio.to_thread(library.test)}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Verbindung fehlgeschlagen: {e}") from e


@api.post("/library/scan")
async def library_scan(request: Request):
    _need(request, "admin")
    try:
        return {"message": await asyncio.to_thread(library.rescan)}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Scan fehlgeschlagen: {e}") from e


@api.post("/library/export")
async def library_export_all(request: Request):
    _need(request, "admin")
    if not library.settings()["enabled"]:
        raise HTTPException(409, "Die Mediathek ist ausgeschaltet")
    ok, err = await asyncio.to_thread(library.dir_status)
    if not ok:
        raise HTTPException(409, err)
    todo = [i for i in list(manager.items.values()) if library.wanted(i)]
    done = 0
    for item in todo:
        if await asyncio.to_thread(_to_library, item):
            done += 1
    return {"exported": done, "total": len(todo)}


@api.post("/items/{item_id}/keep")
async def keep(item_id: str, request: Request):
    _owned_item(_need(request, "keep"), item_id)
    data = await _json(request)
    item = manager.set_keep(item_id, bool(data.get("keep")))
    if item and item.keep:
        await asyncio.to_thread(_to_library, item)
    return item.public() if item else {}


@api.post("/items/{item_id}/retry")
async def retry(item_id: str, request: Request):
    _owned_item(_need(request, "download"), item_id)
    if not manager.retry(item_id):
        raise HTTPException(409, "Download läuft noch")
    return {"ok": True}


@api.delete("/items/{item_id}")
async def delete(item_id: str, request: Request, delete_file: bool = False):
    user = _user(request)
    item = _item_for(user, item_id)
    if not _owned(user)(item):
        # Empfänger eines geteilten Downloads: nur aus der eigenen Liste ausblenden
        manager.set_shared(item_id, [n for n in item.shared_with if n != user.username.lower()])
        return {"ok": True, "unshared": True}
    _need(request, "delete")
    manager.remove(item_id, delete_file)
    _audit(request, "file", "Download entfernt" + (" (mit Datei)" if delete_file else ""), detail=item.title)
    return {"ok": True}


@api.post("/items/{item_id}/share")
async def share(item_id: str, request: Request):
    user = _need(request, "share")
    item = _owned_item(user, item_id)
    if not _is_https(request):
        raise HTTPException(403, "Teilen ist nur über eine verschlüsselte HTTPS-Verbindung erlaubt")
    if item.status != "done":
        raise HTTPException(409, "Nur fertige Downloads können geteilt werden")
    data = await _json(request)
    owner = (item.owner or "").lower()
    before_shared = set(item.shared_with)
    names = []
    for raw in data.get("users") or []:
        u = users.get(str(raw))
        if not u or u.disabled:
            raise HTTPException(400, f"Benutzer „{raw}“ gibt es nicht")
        if u.username.lower() != owner:
            names.append(u.username.lower())
    item = manager.set_shared(item_id, names)
    log.info("%s teilt „%s“ mit: %s", user.username, item.title, ", ".join(names) or "niemandem")
    _audit(request, "file", "Download geteilt", detail=f"{item.title} → {', '.join(names) or 'niemand'}")
    for n in names:
        if n not in before_shared:
            notify.send(n, "📥 Neuer geteilter Download", f"{user.username} hat „{item.title}“ mit dir geteilt.", kind="share")
    return item.public()


@api.get("/share-targets")
async def share_targets(request: Request):
    """Benutzernamen, mit denen man teilen kann (nur aktive Konten, ohne sich selbst)."""
    user = _need(request, "share")
    me = user.username.lower()
    return {"users": [u.username for u in users.list() if not u.disabled and u.username.lower() != me]}


@api.post("/clear")
async def clear(request: Request):
    user = _need(request, "delete")
    data = await _json(request)
    n = manager.clear(str(data.get("which", "done")), bool(data.get("delete_files")), _owned(user))
    if n:
        _audit(request, "file", "Liste aufgeräumt", detail=f"{n} Einträge" + (" mit Dateien" if data.get("delete_files") else ""))
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
    item = _owned_item(_need(request, "download"), item_id)
    if item.status != "done":
        raise HTTPException(409, "Der Download ist noch nicht fertig")
    path = manager.file_path(item)
    if not path or not path.is_file():
        raise HTTPException(404, "Datei nicht gefunden")
    if item.options.kind != "audio" or not tags.supported(path):
        raise HTTPException(400, "Tags lassen sich nur bei Audiodateien (MP3, M4A, FLAC, Opus, WAV) bearbeiten")
    return item, path


@api.get("/items/{item_id}/lyrics")
async def get_lyrics(item_id: str, request: Request, refresh: bool = False):
    user = _user(request)
    item = _item_for(user, item_id)
    path = manager.file_path(item)
    try:
        res = await asyncio.to_thread(lyrics.get, item, path, refresh)
    except Exception as e:  # noqa: BLE001
        log.info("Lyrics-Abfrage fehlgeschlagen: %s", e)
        raise HTTPException(502, "Songtext-Dienst (lrclib.net) gerade nicht erreichbar") from e
    res["can_embed"] = bool(item.options.kind == "audio" and path and path.is_file() and tags.supported(path)
                            and _owned(user)(item) and user.has("download"))
    res.pop("at", None)
    return res


@api.post("/items/{item_id}/lyrics/embed")
async def embed_lyrics(item_id: str, request: Request):
    item, path = _editable_audio(request, item_id)
    res = await asyncio.to_thread(lyrics.get, item, path)
    text = res.get("synced") or res.get("plain")
    if not text:
        raise HTTPException(404, "Für diesen Song wurde kein Songtext gefunden")
    try:
        await asyncio.to_thread(lyrics.embed, path, text)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Songtext konnte nicht gespeichert werden: {e}") from e
    item.filesize = path.stat().st_size
    manager._update(item)
    if item.library:
        await asyncio.to_thread(_to_library, item, True)
    return {"ok": True, "synced": bool(res.get("synced"))}


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
    if item.spotify is not None:   # eigene Angaben gehen vor (Songtext-Suche, Mediathek)
        item.spotify = {**item.spotify, **({"title": title} if title else {}),
                        **({"artists": [artist]} if artist else {}), **({"album": album} if album else {})}
    item.filesize = path.stat().st_size
    manager._update(item)
    if item.library:
        await asyncio.to_thread(_to_library, item, True)
    return item.public()


@api.get("/img")
async def proxied_image(request: Request, u: str, s: str):
    _user(request)
    if not imgproxy.valid(u, s):
        raise HTTPException(403, "Ungültige Bildadresse")
    try:
        data, ctype = await asyncio.wait_for(asyncio.to_thread(imgproxy.fetch, u), timeout=20)
    except (ValueError, asyncio.TimeoutError, OSError) as e:
        raise HTTPException(404, f"Bild nicht verfügbar: {e}") from None
    return Response(data, media_type=ctype, headers={"Cache-Control": "private, max-age=86400"})


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
                me = user.username.lower()
                if event == "notify":
                    if data.get("user") == me:
                        yield _sse("notify", data["msg"])
                    continue
                if event == "revoked":  # Freigabe entzogen → nur bei diesem Benutzer entfernen
                    if data.get("user") == me and not user.has("view_all"):
                        yield _sse("removed", {"id": data["id"]})
                    continue
                if user.has("view_all") or (data.get("owner") or "").lower() == me or me in (data.get("shared_with") or []):
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
    _audit(request, "admin", "Cookies hochgeladen")
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
    _audit(request, "admin", "Speicher geleert", detail=f"{count} Dateien")
    return {"files": count, "freed": freed}


_updating = False


@api.post("/update-ytdlp")
async def update_ytdlp(request: Request):
    global _updating
    _need(request, "settings")
    if _updating or healer.busy:
        raise HTTPException(409, "Update läuft bereits")
    if manager.active_count():
        raise HTTPException(409, "Bitte warten, bis laufende Downloads fertig sind")
    _updating = True
    try:
        try:
            res = await asyncio.to_thread(healer.update, None, "manuell")
        except RuntimeError as e:
            raise HTTPException(500, str(e)) from e
        if res["changed"]:
            asyncio.get_running_loop().call_later(1.0, _restart)
            return {"updated": True, "version": res["version"], "restarting": True}
        return {"updated": False, "version": res["version"]}
    finally:
        _updating = False


@api.get("/healer")
async def healer_status(request: Request):
    _need(request, "settings")
    return healer.status()


@api.post("/healer/channel")
async def healer_channel(request: Request):
    user = _need(request, "settings")
    data = await _json(request)
    if manager.active_count():
        raise HTTPException(409, "Bitte warten, bis laufende Downloads fertig sind")
    try:
        res = await asyncio.to_thread(healer.set_channel, str(data.get("channel")))
    except (ValueError, RuntimeError) as e:
        raise HTTPException(400, str(e)) from e
    log.info("%s hat den yt-dlp-Kanal auf %s gestellt", user.username, healer.channel)
    if res["changed"]:
        asyncio.get_running_loop().call_later(1.0, _restart)
    return {**healer.status(), "restarting": res["changed"], "version": res["version"]}


@api.post("/healer/dismiss")
async def healer_dismiss(request: Request):
    _need(request, "settings")
    data = await _json(request)
    healer.dismiss(str(data.get("id") or ""))
    return healer.status()


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
        "id": "./", "name": "ScobeTube", "short_name": "ScobeTube",
        "description": "Private Video- und Musik-Downloads",
        "start_url": "./", "scope": "./", "display": "standalone", "lang": "de",
        "background_color": "#0b0b0c", "theme_color": "#0b0b0c",
        "icons": [
            {"src": "static/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "static/icon-512.png", "sizes": "512x512", "type": "image/png"},
            {"src": "static/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
            {"src": "static/icon.svg", "sizes": "any", "type": "image/svg+xml"},
        ],
        # Erscheint im Android-„Teilen“-Menü, sobald die App installiert ist (nur über HTTPS möglich)
        "share_target": {"action": "share", "method": "GET",
                         "params": {"title": "title", "text": "text", "url": "url"}},
    }, media_type="application/manifest+json")


# ------------------------------------------------------------ Android-App
@app.get("/api/app/version")
async def app_version():
    """Öffentlich: die App fragt hier vor dem Login nach Updates."""
    return appdist.info()


@app.get("/app/download")
async def app_download():
    path = appdist.apk_path()
    info = appdist.info()
    if not path or not info["available"]:
        raise HTTPException(404, "Es wurde noch keine App-Version bereitgestellt")
    name = f"ScobeTube-{info['version_name']}.apk"
    return FileResponse(path, media_type="application/vnd.android.package-archive",
                        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}",
                                 "Cache-Control": "no-cache"})


@app.post("/api/app/upload")
async def app_upload(request: Request):
    admin = _need(request, "admin")
    form = await request.form()
    upload = form.get("apk")
    if upload is None or not hasattr(upload, "read"):
        raise HTTPException(400, "Bitte eine APK-Datei auswählen")
    data = await upload.read(appdist.MAX_APK + 1)
    try:
        res = await asyncio.to_thread(appdist.store, data, str(form.get("notes") or ""), f"Upload von {admin.username}")
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Die APK konnte nicht gelesen werden: {e}") from e
    return res


@app.post("/api/app/pull")
async def app_pull(request: Request):
    _need(request, "admin")
    try:
        res = await asyncio.wait_for(asyncio.to_thread(appdist.pull_github), timeout=300)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"GitHub nicht erreichbar oder Fehler: {e}") from e
    return {**res, "info": appdist.info()}


@app.get("/sw.js")
async def service_worker():
    return FileResponse(STATIC_DIR / "sw.js", media_type="text/javascript",
                        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": (config.URL_PREFIX or "") + "/"})


@app.get("/share")
async def share_in(url: str = "", text: str = "", title: str = ""):
    """Ziel des „Teilen“-Menüs (Android-App) bzw. iPhone-Kurzbefehls.

    Startet nichts selbst: öffnet ScobeTube mit dem Link, gestartet wird erst per Tippen
    (Schutz gegen untergeschobene Downloads). Anmeldung ist wie überall Pflicht."""
    found = _extract_urls(" ".join([url, text]))
    params = {"share": "1"}
    if found:
        params["url"] = found[0]
    if title:
        params["title"] = title[:200]
    return RedirectResponse("./?" + urlencode(params), status_code=303)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


_ASSET_RE = re.compile(r'(static/[\w./-]+\.(?:js|css))"')
_page_cache: dict[str, tuple[float, str]] = {}


def _asset_version(rel: str) -> str:
    try:
        return hashlib.sha256((STATIC_DIR.parent / rel).read_bytes()).hexdigest()[:10]
    except OSError:
        return config.APP_VERSION


def _page(name: str) -> Response:
    """HTML-Seite mit ?v=<Inhalts-Hash> an jeder JS/CSS-Datei – nach Updates lädt jeder Browser
    automatisch die neuen Dateien (auch hinter Cloudflare & Co.)."""
    path = STATIC_DIR / name
    newest = max([path.stat().st_mtime] + [p.stat().st_mtime for p in STATIC_DIR.rglob("*") if p.suffix in (".js", ".css")])
    cached = _page_cache.get(name)
    if not cached or cached[0] != newest:
        html_text = _ASSET_RE.sub(lambda m: f'{m.group(1)}?v={_asset_version(m.group(1))}"', path.read_text("utf-8"))
        _page_cache[name] = cached = (newest, html_text)
    return Response(cached[1], media_type="text/html; charset=utf-8", headers={"Cache-Control": "no-store"})


@app.get("/rechtliches")
async def legal_page():
    return _page("legal.html")


@app.get("/api/legal")
async def legal_info(request: Request):
    user = request.state.user
    data = legal.get()
    can_edit = bool(user and user.is_admin)
    if not can_edit:  # Standardtexte und Bearbeiter nur für Admins
        for sec in data["sections"]:
            sec.pop("default_text", None)
            sec.pop("default_title", None)
        data.pop("updated_by", None)
    return {**data, "retention_hours": config.RETENTION_HOURS, "can_edit": can_edit}


@app.put("/api/legal")
async def legal_update(request: Request):
    admin = _need(request, "admin")
    data = await _json(request)
    try:
        legal.save(data.get("sections") or {}, data.get("operator_name"), data.get("operator_contact"), admin.username)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    log.info("%s hat die Rechtstexte geändert", admin.username)
    _audit(request, "admin", "Rechtstexte geändert")
    return await legal_info(request)


@app.post("/api/legal/reset")
async def legal_reset(request: Request):
    admin = _need(request, "admin")
    legal.reset()
    log.info("%s hat die Rechtstexte auf den Standard zurückgesetzt", admin.username)
    return await legal_info(request)


@app.get("/robots.txt")
async def robots():
    return Response("User-agent: *\nDisallow: /\n", media_type="text/plain")


@app.get("/login")
async def login_page(request: Request):
    if request.state.user:
        return RedirectResponse("./", status_code=303)
    return _page("login.html")


@app.get("/")
async def index():
    return _page("index.html")


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
