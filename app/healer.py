"""Selbstheilung: yt-dlp aktuell halten und bei gehäuften Fehlern automatisch reparieren.

- Prüft einmal täglich auf eine neue yt-dlp-Version und startet bei Leerlauf neu.
- Häufen sich Fehler, die typisch für eine Änderung bei YouTube & Co. sind, wird sofort
  aktualisiert; hilft das nicht, wird auf die Nightly-Version gewechselt.
- Fehlgeschlagene Downloads werden nach der Reparatur automatisch neu versucht.
- Admins bekommen eine Meldung in der Oberfläche.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from collections import deque
from typing import Any, Callable

import yt_dlp

from . import config

log = logging.getLogger("scobetube.healer")

CHECK_EVERY = 24 * 3600          # tägliche Update-Prüfung
FAIL_WINDOW = 30 * 60            # Fehler in den letzten 30 Minuten …
FAIL_THRESHOLD = 3               # … ab so vielen verschiedenen Downloads → reparieren
HEAL_COOLDOWN = 2 * 3600         # höchstens alle 2 Stunden automatisch eingreifen

# Fehler, die auf eine Änderung der Plattform hindeuten (→ yt-dlp-Update hilft meistens)
BREAKAGE = re.compile(
    r"unable to extract|failed to extract|signature (extraction|function)|\bnsig\b|n challenge|"
    r"player response|unable to download (video data|webpage)|requested format is not available|"
    r"http error 403|po token|unsupported url.*youtube|precondition check failed|"
    r"no video formats found|unable to decode|jsinterp|please report this issue", re.I)
# Fehler, bei denen ein Update nichts bringt
NOT_BREAKAGE = re.compile(
    r"not a bot|sign in to confirm|video unavailable|private video|copyright|been removed|"
    r"confirm your age|age[- ]restricted|\binappropriate\b|members-only|premiere|not available in your country|"
    r"geo[- ]?restrict|live event|kein passender", re.I)


class Healer:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.fails: deque[tuple[float, str]] = deque(maxlen=50)
        self.busy = False
        self.restart: Callable[[], None] | None = None
        self.active_count: Callable[[], int] = lambda: 0
        self.state: dict[str, Any] = {}

    # ------------------------------------------------------------ zustand
    @property
    def path(self):
        return config.STATE_DIR / "healer.json"

    def load(self) -> None:
        try:
            self.state = json.loads(self.path.read_text("utf-8"))
        except (OSError, ValueError):
            self.state = {}
        self.state.setdefault("notices", [])
        self.state.setdefault("history", [])
        self.state.setdefault("retry_ids", [])

    def save(self) -> None:
        with self.lock:
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.state, ensure_ascii=False, indent=1), "utf-8")
            os.replace(tmp, self.path)

    @property
    def channel(self) -> str:
        return self.state.get("channel") or config.YTDLP_CHANNEL

    @property
    def auto(self) -> bool:
        return os.environ.get("YTDLP_SELF_HEAL", "true").lower() not in ("0", "false", "no", "aus")

    def notice(self, level: str, text: str) -> None:
        self.state["notices"].append({"id": uuid.uuid4().hex[:10], "time": time.time(), "level": level, "text": text})
        self.state["notices"] = self.state["notices"][-20:]
        self._history(text)
        self.save()

    def _history(self, text: str) -> None:
        self.state["history"].append({"time": time.time(), "text": text, "version": yt_dlp.version.__version__})
        self.state["history"] = self.state["history"][-30:]

    def dismiss(self, notice_id: str | None) -> None:
        self.state["notices"] = [n for n in self.state["notices"] if notice_id and n["id"] != notice_id]
        self.save()

    def status(self) -> dict[str, Any]:
        return {
            "version": yt_dlp.version.__version__, "channel": self.channel, "auto": self.auto,
            "last_check": self.state.get("last_check"), "last_heal": self.state.get("last_heal"),
            "history": list(reversed(self.state["history"]))[:10], "notices": self.state["notices"],
            "busy": self.busy,
        }

    # ------------------------------------------------------------ pip
    def _pip_install(self, channel: str, exact: str | None = None) -> tuple[bool, str]:
        cmd = [sys.executable, "-m", "pip", "install", "-U", "--no-cache-dir", "--disable-pip-version-check"]
        if exact:
            cmd += ["--force-reinstall", f"yt-dlp[default]=={exact}"]
        else:
            if channel == "nightly":
                cmd.append("--pre")
            cmd.append("yt-dlp[default]")
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        return proc.returncode == 0, (proc.stderr or proc.stdout)[-500:]

    @staticmethod
    def installed_version() -> str:
        out = subprocess.run([sys.executable, "-c", "import yt_dlp.version as v;print(v.__version__)"],
                             capture_output=True, text=True, timeout=60)
        return out.stdout.strip()

    @staticmethod
    def latest_stable() -> str | None:
        try:
            req = urllib.request.Request("https://pypi.org/pypi/yt-dlp/json", headers={"User-Agent": "ScobeTube"})
            with urllib.request.urlopen(req, timeout=20) as r:  # noqa: S310
                return json.loads(r.read())["info"]["version"]
        except Exception:  # noqa: BLE001
            return None

    def update(self, channel: str | None = None, reason: str = "manuell") -> dict[str, Any]:
        """Installiert die neueste Version des Kanals. Gibt {changed, version} zurück."""
        channel = channel or self.channel
        before = yt_dlp.version.__version__
        if channel == "stable" and ".dev" in before:
            # Rückweg von Nightly: gezielt die aktuelle Stable-Version installieren
            ok, err = self._pip_install("stable", exact=self.latest_stable())
        else:
            ok, err = self._pip_install(channel)
        if not ok:
            raise RuntimeError("Update fehlgeschlagen: " + err)
        self.state["last_check"] = time.time()
        after = self.installed_version() or before
        changed = after != before
        if changed:
            self._history(f"yt-dlp {before} → {after} ({reason})")
        self.save()
        return {"changed": changed, "version": after, "before": before}

    def set_channel(self, channel: str) -> dict[str, Any]:
        if channel not in ("stable", "nightly"):
            raise ValueError("Unbekannter Kanal")
        self.state["channel"] = channel
        self.save()
        return self.update(channel, reason=f"Kanal auf {channel} gestellt")

    # ------------------------------------------------------- fehler-erkennung
    def report_failure(self, item_id: str, message: str, url: str) -> None:
        if not self.auto or NOT_BREAKAGE.search(message) or not BREAKAGE.search(message):
            return
        now = time.time()
        self.fails.append((now, item_id))
        recent = {i for t, i in self.fails if t > now - FAIL_WINDOW}
        if len(recent) >= FAIL_THRESHOLD and not self.busy and now - self.state.get("last_heal", 0) > HEAL_COOLDOWN:
            log.warning("Mehrere Downloads in Folge fehlgeschlagen – starte Selbstheilung")
            threading.Thread(target=self._heal, args=(sorted(recent),), daemon=True).start()

    def _heal(self, failed_ids: list[str]) -> None:
        self.busy = True
        try:
            self.state["last_heal"] = time.time()
            res = self.update(reason="Selbstheilung nach gehäuften Fehlern")
            if not res["changed"] and self.channel == "stable":
                # Stable hat noch keinen Fix → auf Nightly ausweichen
                self.state["channel"] = "nightly"
                res = self.update("nightly", reason="Selbstheilung: Wechsel auf Nightly")
                if res["changed"]:
                    self.notice("warn", f"Downloads sind wiederholt fehlgeschlagen. ScobeTube hat automatisch auf die "
                                        f"Nightly-Version von yt-dlp gewechselt ({res['version']}) und versucht die "
                                        f"fehlgeschlagenen Downloads erneut.")
            elif res["changed"]:
                self.notice("info", f"Downloads sind wiederholt fehlgeschlagen. yt-dlp wurde automatisch auf "
                                    f"{res['version']} aktualisiert, die fehlgeschlagenen Downloads werden neu versucht.")
            if not res["changed"]:
                self.notice("error", "Downloads schlagen wiederholt fehl, und es gibt noch keine neuere yt-dlp-Version. "
                                     "Meist erscheint ein Fix innerhalb weniger Stunden – ScobeTube prüft weiter. "
                                     "Bei YouTube helfen manchmal auch Cookies (Einstellungen → Cookies).")
                return
            self.state["retry_ids"] = list(dict.fromkeys(self.state["retry_ids"] + failed_ids))[-200:]
            self.save()
            self._restart_when_idle()
        except Exception as e:  # noqa: BLE001
            log.error("Selbstheilung fehlgeschlagen: %s", e)
            self.notice("error", f"Automatische Reparatur fehlgeschlagen: {e}")
        finally:
            self.busy = False

    def _restart_when_idle(self) -> None:
        for _ in range(12 * 24):  # bis zu 24 Stunden auf Leerlauf warten
            if self.active_count() == 0:
                if self.restart:
                    self.restart()
                return
            time.sleep(300)

    def take_retry_ids(self) -> list[str]:
        ids = self.state.get("retry_ids") or []
        if ids:
            self.state["retry_ids"] = []
            self.save()
        return ids

    # ------------------------------------------------------------ täglich
    async def run(self) -> None:
        await asyncio.sleep(120)  # nach dem Start erst einmal Ruhe
        while True:
            try:
                due = time.time() - self.state.get("last_check", 0) > CHECK_EVERY
                if due and self.auto and not self.busy and \
                        os.environ.get("YTDLP_AUTO_UPDATE", "true").lower() != "false":
                    res = await asyncio.to_thread(self.update, None, "tägliche Prüfung")
                    if res["changed"]:
                        log.info("Neue yt-dlp-Version %s – Neustart sobald keine Downloads laufen", res["version"])
                        await asyncio.to_thread(self._restart_when_idle)
            except Exception as e:  # noqa: BLE001
                log.warning("Tägliche yt-dlp-Prüfung fehlgeschlagen: %s", e)
                self.state["last_check"] = time.time()  # nicht im Minutentakt erneut versuchen
                self.save()
            await asyncio.sleep(1800)


healer = Healer()
