"""Benutzer, Rechte, Passwörter und Sitzungen."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Any

from . import config

log = logging.getLogger("scobetube.auth")

# Reihenfolge = Anzeige-Reihenfolge in der Oberfläche
PERMISSIONS: dict[str, str] = {
    "download": "Downloads starten",
    "files": "Fertige Dateien herunterladen",
    "delete": "Eigene Einträge & Dateien löschen",
    "view_all": "Downloads aller Benutzer sehen & verwalten",
    "storage": "Speicher leeren (alle Downloads löschen)",
    "settings": "Einstellungen (yt-dlp-Update, Cookies, Systemmonitor)",
    "admin": "Administrator (alle Rechte + Benutzerverwaltung)",
}
DEFAULT_PERMISSIONS = ["download", "files", "delete"]

USERNAME_RE = re.compile(r"^[A-Za-z0-9._-]{3,32}$")
MIN_PASSWORD = 8
MAX_PASSWORD = 256

SESSION_SHORT = 12 * 3600          # ohne „Angemeldet bleiben“
SESSION_LONG = 30 * 24 * 3600      # mit „Angemeldet bleiben“
COOKIE_NAME = "scobetube_session"

# scrypt-Parameter (≈ 64 MB RAM, ~100 ms pro Hash)
_SCRYPT_N, _SCRYPT_R, _SCRYPT_P = 2 ** 16, 8, 1
_SCRYPT_MAXMEM = 128 * 1024 * 1024


# ------------------------------------------------------------- passwörter
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P,
                        maxmem=_SCRYPT_MAXMEM, dklen=32)
    b64 = lambda b: base64.b64encode(b).decode()  # noqa: E731
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${b64(salt)}${b64(dk)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, dk = stored.split("$")
        if algo != "scrypt":
            return False
        expected = base64.b64decode(dk)
        got = hashlib.scrypt(password.encode("utf-8"), salt=base64.b64decode(salt), n=int(n), r=int(r),
                             p=int(p), maxmem=_SCRYPT_MAXMEM, dklen=len(expected))
        return hmac.compare_digest(got, expected)
    except (ValueError, TypeError):
        return False


# Für unbekannte Benutzer trotzdem einen Hash prüfen (gleiche Antwortzeit)
_DUMMY_HASH = hash_password(secrets.token_urlsafe(16))


def validate_password(pw: str) -> None:
    if not isinstance(pw, str) or len(pw) < MIN_PASSWORD:
        raise ValueError(f"Das Passwort muss mindestens {MIN_PASSWORD} Zeichen haben")
    if len(pw) > MAX_PASSWORD:
        raise ValueError("Das Passwort ist zu lang")


def validate_username(name: str) -> None:
    if not isinstance(name, str) or not USERNAME_RE.match(name):
        raise ValueError("Benutzername: 3–32 Zeichen, nur Buchstaben, Zahlen, Punkt, Minus und Unterstrich")


def clean_permissions(perms: Any) -> list[str]:
    if not isinstance(perms, list):
        raise ValueError("Ungültige Rechte")
    return [p for p in PERMISSIONS if p in perms]


# ------------------------------------------------------------- datenmodell
@dataclass
class User:
    username: str
    password_hash: str
    permissions: list[str] = field(default_factory=lambda: list(DEFAULT_PERMISSIONS))
    disabled: bool = False
    created: float = field(default_factory=time.time)
    last_login: float | None = None

    def has(self, perm: str) -> bool:
        if self.disabled:
            return False
        return "admin" in self.permissions or perm in self.permissions

    @property
    def is_admin(self) -> bool:
        return not self.disabled and "admin" in self.permissions

    def effective_permissions(self) -> list[str]:
        return list(PERMISSIONS) if self.is_admin else list(self.permissions)

    def public(self) -> dict[str, Any]:
        return {"username": self.username, "permissions": self.permissions, "disabled": self.disabled,
                "created": self.created, "last_login": self.last_login, "admin": self.is_admin}


@dataclass
class Session:
    username: str
    expires: float
    created: float = field(default_factory=time.time)
    ip: str = ""
    user_agent: str = ""


def _token_hash(token: str) -> str:
    # Nur der Hash wird gespeichert – ein geleakter Status verrät keine gültigen Sitzungen
    return hashlib.sha256(token.encode()).hexdigest()


class UserStore:
    def __init__(self) -> None:
        self.path = config.STATE_DIR / "users.json"
        self.lock = threading.RLock()
        self.users: dict[str, User] = {}        # key: username.lower()
        self.sessions: dict[str, Session] = {}  # key: sha256(token)

    # ------------------------------------------------------------ speichern
    def load(self) -> None:
        with self.lock:
            if self.path.exists():
                data = json.loads(self.path.read_text("utf-8"))
                self.users = {u["username"].lower(): User(**u) for u in data.get("users", [])}
                self.sessions = {k: Session(**v) for k, v in data.get("sessions", {}).items()}
            self._purge_expired()
            if not self.users:
                self._bootstrap_from_env()

    def save(self) -> None:
        with self.lock:
            data = {"users": [asdict(u) for u in self.users.values()],
                    "sessions": {k: asdict(v) for k, v in self.sessions.items()}}
            tmp = self.path.with_suffix(".tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            os.replace(tmp, self.path)

    def _bootstrap_from_env(self) -> None:
        name = os.environ.get("ADMIN_USERNAME", "").strip()
        pw = os.environ.get("ADMIN_PASSWORD", "")
        if not name or not pw:
            log.warning("Noch kein Benutzer vorhanden – bitte im Browser das Admin-Konto einrichten.")
            return
        try:
            self.create(name, pw, ["admin"])
            log.info("Admin-Konto „%s“ aus Umgebungsvariablen angelegt.", name)
        except ValueError as e:
            log.error("ADMIN_USERNAME/ADMIN_PASSWORD ungültig: %s", e)

    # ------------------------------------------------------------- benutzer
    @property
    def needs_setup(self) -> bool:
        return not self.users

    def get(self, username: str) -> User | None:
        return self.users.get((username or "").lower())

    def list(self) -> list[User]:
        return sorted(self.users.values(), key=lambda u: u.created)

    def create(self, username: str, password: str, permissions: list[str]) -> User:
        validate_username(username)
        validate_password(password)
        perms = clean_permissions(permissions)
        with self.lock:
            if username.lower() in self.users:
                raise ValueError("Diesen Benutzernamen gibt es schon")
            user = User(username=username, password_hash=hash_password(password), permissions=perms)
            self.users[username.lower()] = user
            self.save()
            return user

    def _admins_after(self, username: str, *, perms: list[str] | None = None, disabled: bool | None = None,
                      deleted: bool = False) -> int:
        n = 0
        for u in self.users.values():
            if u.username.lower() == username.lower():
                if deleted:
                    continue
                p = perms if perms is not None else u.permissions
                d = disabled if disabled is not None else u.disabled
                if "admin" in p and not d:
                    n += 1
            elif u.is_admin:
                n += 1
        return n

    def update(self, username: str, *, permissions: list[str] | None = None, disabled: bool | None = None,
               password: str | None = None) -> User:
        with self.lock:
            user = self.get(username)
            if not user:
                raise KeyError(username)
            perms = clean_permissions(permissions) if permissions is not None else None
            if self._admins_after(username, perms=perms, disabled=disabled) == 0:
                raise ValueError("Es muss mindestens ein aktiver Administrator übrig bleiben")
            if perms is not None:
                user.permissions = perms
            if disabled is not None:
                user.disabled = bool(disabled)
                if user.disabled:
                    self.revoke_user_sessions(username, save=False)
            if password is not None:
                validate_password(password)
                user.password_hash = hash_password(password)
                self.revoke_user_sessions(username, save=False)
            self.save()
            return user

    def delete(self, username: str) -> None:
        with self.lock:
            if not self.get(username):
                raise KeyError(username)
            if self._admins_after(username, deleted=True) == 0:
                raise ValueError("Der letzte Administrator kann nicht gelöscht werden")
            self.users.pop(username.lower(), None)
            self.revoke_user_sessions(username, save=False)
            self.save()

    def authenticate(self, username: str, password: str) -> User | None:
        user = self.get(username)
        if not user:
            verify_password(password, _DUMMY_HASH)
            return None
        if not verify_password(password, user.password_hash) or user.disabled:
            return None
        return user

    # ------------------------------------------------------------- sitzungen
    def create_session(self, user: User, remember: bool, ip: str, user_agent: str) -> tuple[str, int]:
        token = secrets.token_urlsafe(32)
        ttl = SESSION_LONG if remember else SESSION_SHORT
        with self.lock:
            self._purge_expired()
            self.sessions[_token_hash(token)] = Session(user.username, time.time() + ttl, ip=ip,
                                                        user_agent=user_agent[:200])
            user.last_login = time.time()
            self.save()
        return token, ttl

    def session_user(self, token: str | None) -> tuple[User | None, str | None]:
        if not token or len(token) > 100:
            return None, None
        key = _token_hash(token)
        s = self.sessions.get(key)
        if not s or s.expires < time.time():
            return None, None
        user = self.get(s.username)
        if not user or user.disabled:
            return None, None
        return user, key

    def revoke(self, key: str) -> None:
        with self.lock:
            if self.sessions.pop(key, None):
                self.save()

    def revoke_user_sessions(self, username: str, *, except_key: str | None = None, save: bool = True) -> None:
        with self.lock:
            for k in [k for k, s in self.sessions.items()
                      if s.username.lower() == username.lower() and k != except_key]:
                del self.sessions[k]
            if save:
                self.save()

    def _purge_expired(self) -> None:
        now = time.time()
        for k in [k for k, s in self.sessions.items() if s.expires < now]:
            del self.sessions[k]


# ----------------------------------------------------- schutz vor raten
class LoginLimiter:
    """Bremst Passwort-Raten: pro IP+Benutzer und pro IP."""

    PER_ACCOUNT = 5     # Fehlversuche je IP+Benutzer
    PER_IP = 20         # Fehlversuche je IP (alle Benutzer)
    WINDOW = 15 * 60
    LOCK = 15 * 60

    def __init__(self) -> None:
        self.fails: dict[str, list[float]] = {}
        self.locked: dict[str, float] = {}
        self.lock = threading.Lock()

    def _keys(self, ip: str, username: str) -> list[tuple[str, int]]:
        return [(f"a:{ip}:{username.lower()}", self.PER_ACCOUNT), (f"i:{ip}", self.PER_IP)]

    def retry_after(self, ip: str, username: str) -> int:
        now = time.time()
        with self.lock:
            wait = 0
            for k, _ in self._keys(ip, username):
                until = self.locked.get(k, 0)
                if until > now:
                    wait = max(wait, int(until - now) + 1)
            return wait

    def failed(self, ip: str, username: str) -> None:
        now = time.time()
        with self.lock:
            for k, limit in self._keys(ip, username):
                lst = [t for t in self.fails.get(k, []) if t > now - self.WINDOW]
                lst.append(now)
                self.fails[k] = lst
                if len(lst) >= limit:
                    self.locked[k] = now + self.LOCK
                    self.fails[k] = []
            if len(self.fails) > 10000:  # Speicher begrenzen
                self.fails.clear()

    def succeeded(self, ip: str, username: str) -> None:
        with self.lock:
            self.fails.pop(f"a:{ip}:{username.lower()}", None)


users = UserStore()
limiter = LoginLimiter()
