# ScobeTube

Selbst gehosteter Video- und Musik-Downloader mit moderner Weboberfläche – Nachfolger für MeTube.
Basiert auf [yt-dlp](https://github.com/yt-dlp/yt-dlp) und unterstützt damit YouTube, Playlists und über 1.000 weitere Seiten.

## Funktionen

- **Video:** MP4, MKV, WEBM – Qualität von 360p bis 4K
- **Audio:** MP3, M4A, OPUS, FLAC, WAV – inklusive Cover und Metadaten (Titel, Interpret, Kapitel)
- **Playlists und Kanäle:** Jedes Video landet einzeln in der Warteschlange, gespeichert im Unterordner der Playlist
- **Live-Fortschritt** mit Geschwindigkeit und Restzeit; parallele Downloads einstellbar
- **Mehrere Links auf einmal** (einer pro Zeile) oder per **Drag & Drop**
- **Warteschlange bleibt erhalten**, auch nach einem Neustart
- **yt-dlp aktualisiert sich selbst** beim Containerstart. Zusätzlich gibt es einen Update-Knopf in der Oberfläche, falls YouTube mal wieder etwas ändert.
- **Cookie-Upload** für „Sign in to confirm you're not a bot“ und altersbeschränkte Videos
- **Lesezeichen-Buttons** („Bookmarklets“): ein Klick auf einer Videoseite, und der Download startet
- Optionaler **Passwortschutz**, Untertitel einbetten, läuft als PWA auf dem Handy

## Schnellstart (Docker Compose)

```bash
git clone https://github.com/Scobecraft/ScobeTube.git
cd ScobeTube
docker compose up -d --build
```

Danach im Browser öffnen: `http://<server-ip>:8081`

Die Downloads landen in `./downloads`. Warteschlange, Cookies und Cache liegen in `./data`.

Fertiges Image (wird von GitHub Actions gebaut, sobald Packages für das Repo aktiviert sind):

```yaml
services:
  scobetube:
    image: ghcr.io/scobecraft/scobetube:latest
    restart: unless-stopped
    ports: ["8081:8081"]
    volumes:
      - /pfad/zu/downloads:/downloads
      - ./data:/data
    environment:
      - PUID=1000
      - PGID=1000
```

## Konfiguration (Umgebungsvariablen)

| Variable | Standard | Beschreibung |
|---|---|---|
| `PUID` / `PGID` | `1000` | Benutzer und Gruppe, denen die heruntergeladenen Dateien gehören |
| `UMASK` | `022` | Dateirechte für neue Dateien |
| `PORT` | `8081` | Port im Container |
| `MAX_CONCURRENT_DOWNLOADS` | `3` | Wie viele Downloads gleichzeitig laufen |
| `OUTPUT_TEMPLATE` | `%(title)s.%(ext)s` | Dateiname, [yt-dlp-Syntax](https://github.com/yt-dlp/yt-dlp#output-template), z. B. `%(uploader)s/%(title)s.%(ext)s` |
| `PLAYLIST_SUBFOLDER` | `true` | Playlists in einen eigenen Unterordner speichern |
| `PLAYLIST_LIMIT` | `0` | Maximale Anzahl Videos pro Playlist (`0` = alle) |
| `WINDOWS_FILENAMES` | `true` | Dateinamen Windows-/SMB-kompatibel machen |
| `AUTH_USER` / `AUTH_PASSWORD` | – | Wenn gesetzt, fragt die Oberfläche nach Benutzer und Passwort |
| `YTDLP_AUTO_UPDATE` | `true` | yt-dlp bei jedem Containerstart aktualisieren |
| `YTDLP_CHANNEL` | `stable` | `nightly`, wenn du die allerneuesten Fixes brauchst |
| `YTDL_OPTIONS` | `{}` | Zusätzliche yt-dlp-Optionen als JSON, z. B. `{"ratelimit": 5000000}` |
| `URL_PREFIX` | – | Für Reverse-Proxy unter einem Unterpfad, z. B. `/scobetube` |
| `LOG_LEVEL` | `INFO` | Wie ausführlich geloggt wird |

## Tipps

**„Sign in to confirm you're not a bot“:** YouTube blockt manche Server-IPs. So bekommst du es wieder zum Laufen:
1. Im Browser bei YouTube anmelden (am besten mit einem Zweitkonto).
2. Mit einer Erweiterung wie „Get cookies.txt LOCALLY“ die Datei `cookies.txt` exportieren.
3. In ScobeTube unter ⚙ **Einstellungen → Cookies** hochladen.

**Downloads gehen plötzlich nicht mehr:** In den Einstellungen auf **yt-dlp aktualisieren** klicken oder den Container neu starten. Hilft das nicht, `YTDLP_CHANNEL=nightly` setzen.

**iOS-Kurzbefehl / Automatisierungen:** `GET /api/add?url=<link>&kind=audio&format=mp3` startet direkt einen Download.

## Reverse Proxy

ScobeTube nutzt Server-Sent Events für die Live-Updates. Bei nginx sollte für `/api/events` das Buffering aus sein. ScobeTube setzt dafür schon `X-Accel-Buffering: no`, eine Extra-Konfiguration ist normalerweise nicht nötig.

## Entwicklung

```bash
pip install -r requirements.txt
DOWNLOAD_DIR=./downloads STATE_DIR=./data python -m app
```

Benötigt `ffmpeg` und für YouTube [`deno`](https://deno.com) im `PATH`.
