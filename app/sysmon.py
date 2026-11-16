"""Live-Systemwerte (CPU, RAM, Festplatte) aus /proc – ohne Zusatzpakete."""
from __future__ import annotations

import asyncio
import os
import shutil
import time
from collections import deque
from pathlib import Path
from typing import Any

from . import config

INTERVAL = 2.0
HISTORY = 90  # 3 Minuten bei 2 s


def _cpu_times() -> tuple[int, int] | None:
    try:
        parts = Path("/proc/stat").read_text().splitlines()[0].split()[1:]
        vals = [int(v) for v in parts]
    except (OSError, ValueError, IndexError):
        return None
    idle = vals[3] + (vals[4] if len(vals) > 4 else 0)  # idle + iowait
    return sum(vals[:8]), idle


def _meminfo() -> dict[str, int]:
    out: dict[str, int] = {}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            k, _, v = line.partition(":")
            out[k] = int(v.split()[0]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    return out


def _app_rss() -> int | None:
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    return None


class SysMon:
    def __init__(self) -> None:
        self.history: deque[dict[str, float]] = deque(maxlen=HISTORY)
        self.latest: dict[str, Any] = {}
        self._prev = _cpu_times()

    def sample(self) -> dict[str, Any]:
        cpu = None
        cur = _cpu_times()
        if cur and self._prev:
            dt, di = cur[0] - self._prev[0], cur[1] - self._prev[1]
            if dt > 0:
                cpu = round(max(0.0, min(100.0, (1 - di / dt) * 100)), 1)
        self._prev = cur

        mem = _meminfo()
        total = mem.get("MemTotal", 0)
        avail = mem.get("MemAvailable", mem.get("MemFree", 0))
        used = max(0, total - avail)
        swap_total = mem.get("SwapTotal", 0)
        swap_used = max(0, swap_total - mem.get("SwapFree", 0))
        try:
            disk = shutil.disk_usage(config.DOWNLOAD_DIR)
            disk_total, disk_used = disk.total, disk.total - disk.free
        except OSError:
            disk_total = disk_used = 0
        try:
            load = os.getloadavg()
        except OSError:
            load = None

        now = time.time()
        self.latest = {
            "time": now,
            "cpu": cpu,
            "cores": os.cpu_count(),
            "load": [round(x, 2) for x in load] if load else None,
            "mem_total": total, "mem_used": used,
            "mem": round(used / total * 100, 1) if total else None,
            "swap_total": swap_total, "swap_used": swap_used,
            "disk_total": disk_total, "disk_used": disk_used,
            "disk": round(disk_used / disk_total * 100, 1) if disk_total else None,
            "app_rss": _app_rss(),
        }
        self.history.append({"t": now, "cpu": cpu or 0, "mem": self.latest["mem"] or 0})
        return self.latest

    def snapshot(self) -> dict[str, Any]:
        if not self.latest:
            self.sample()
        return {**self.latest, "history": list(self.history), "interval": INTERVAL}

    async def run(self) -> None:
        while True:
            try:
                await asyncio.to_thread(self.sample)
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(INTERVAL)


sysmon = SysMon()
