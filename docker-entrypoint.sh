#!/bin/sh
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
umask "${UMASK:-022}"

LIBRARY_DIR="${LIBRARY_DIR:-/library}"
mkdir -p "$DOWNLOAD_DIR" "$STATE_DIR" "$LIBRARY_DIR" 2>/dev/null || mkdir -p "$DOWNLOAD_DIR" "$STATE_DIR"

# Als root gestartet: Rechte setzen und auf PUID/PGID wechseln
if [ "$(id -u)" = "0" ]; then
  # venv dem Benutzer überlassen, damit yt-dlp auch aus der Oberfläche aktualisiert werden kann
  if [ "$(stat -c %u /opt/venv)" != "$PUID" ]; then
    chown -R "$PUID:$PGID" /opt/venv
  fi
  chown "$PUID:$PGID" "$DOWNLOAD_DIR" "$LIBRARY_DIR" 2>/dev/null || true
  chown -R "$PUID:$PGID" "$STATE_DIR"
  RUN_AS="setpriv --reuid=$PUID --regid=$PGID --clear-groups"
else
  RUN_AS=""
fi

if [ "${YTDLP_AUTO_UPDATE:-true}" = "true" ]; then
  echo "[scobetube] Prüfe auf yt-dlp-Updates (${YTDLP_CHANNEL:-stable}) …"
  PRE=""
  [ "${YTDLP_CHANNEL:-stable}" = "nightly" ] && PRE="--pre"
  # Kanal, den die Selbstheilung oder ein Admin in der Oberfläche gewählt hat
  if grep -q '"channel": "nightly"' "$STATE_DIR/healer.json" 2>/dev/null; then PRE="--pre"; fi
  $RUN_AS pip install -q -U --no-cache-dir $PRE "yt-dlp[default]" \
    || echo "[scobetube] yt-dlp-Update fehlgeschlagen – nutze installierte Version"
fi

exec $RUN_AS "$@"
