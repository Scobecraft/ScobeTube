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
- **SoundCloud-Modus:** Tracks, Sets und ganze Profile; Suche direkt in ScobeTube; Ton im Originalformat ohne Qualitätsverlust
- **Suche:** Statt eines Links einfach einen Suchbegriff eingeben (YouTube oder SoundCloud)
- **Login mit Benutzerkonten und Rechten:** Der Admin legt Konten an und vergibt Rechte einzeln
- Untertitel einbetten, läuft als PWA auf dem Handy

## Schnellstart (Docker Compose)

```bash
git clone https://github.com/Scobecraft/ScobeTube.git
cd ScobeTube
docker compose up -d --build
```

Danach im Browser öffnen: `http://<server-ip>:8081`

Beim ersten Aufruf erscheint **„Admin einrichten“**. Dort legst du dein Administrator-Konto an.
Mach das direkt nach dem Start, denn bis dahin könnte jeder im Netzwerk das Konto anlegen.

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
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | – | Optional: legt beim allerersten Start automatisch den Admin an (statt über die Einrichtungsseite) |
| `TRUSTED_PROXIES` | `127.0.0.1` | IPs von Reverse-Proxys, deren `X-Forwarded-*`-Header vertraut wird |
| `COOKIE_SECURE` | `auto` | Login-Cookie nur über HTTPS senden (`auto` erkennt HTTPS selbst) |
| `YTDLP_AUTO_UPDATE` | `true` | yt-dlp bei jedem Containerstart aktualisieren |
| `YTDLP_CHANNEL` | `stable` | `nightly`, wenn du die allerneuesten Fixes brauchst |
| `YTDL_OPTIONS` | `{}` | Zusätzliche yt-dlp-Optionen als JSON, z. B. `{"ratelimit": 5000000}` |
| `URL_PREFIX` | – | Für Reverse-Proxy unter einem Unterpfad, z. B. `/scobetube` |
| `LOG_LEVEL` | `INFO` | Wie ausführlich geloggt wird |

## Benutzer & Rechte

Als Admin öffnest du oben rechts dein Profil und gehst auf **Benutzer & Rechte**. Dort legst du Konten an, vergibst Rechte, setzt Passwörter zurück, sperrst oder löschst Konten.

| Recht | Bedeutung |
|---|---|
| Downloads starten | Links und Suche benutzen, eigene Downloads abbrechen und wiederholen |
| Fertige Dateien herunterladen | Fertige Dateien über den Browser aufs eigene Gerät laden |
| Eigene Einträge & Dateien löschen | Eigene Downloads aus der Liste und von der Platte entfernen |
| Downloads aller Benutzer sehen & verwalten | Sonst sieht jeder nur seine eigenen Downloads |
| Speicher leeren | Der Knopf „Alle Downloads löschen“ |
| Einstellungen | yt-dlp-Update, Cookies |
| Administrator | Alle Rechte und die Benutzerverwaltung |

**Sicherheit**
- Passwörter werden nur als scrypt-Hash gespeichert, niemals im Klartext.
- Nach 5 Fehlversuchen wird die Anmeldung 15 Minuten gesperrt (pro IP und Konto), nach 20 Fehlversuchen die ganze IP.
- Sitzungen liegen nur auf dem Server. Das Cookie ist `HttpOnly` und `SameSite=Strict`, und auf dem Server wird nur ein Hash des Tokens gespeichert.
- Schutz vor CSRF und Clickjacking, dazu eine strikte Content-Security-Policy.
- Wer ein Passwort ändert, beendet damit alle anderen Sitzungen dieses Kontos. Gesperrte Konten werden sofort abgemeldet.
- **Für den Zugriff aus dem Internet** solltest du HTTPS über einen Reverse-Proxy nutzen (z. B. Nginx Proxy Manager, Caddy oder Traefik). Ohne HTTPS geht das Passwort unverschlüsselt durchs Netz.

**Passwort vergessen?** Auf dem Server die Datei `data/users.json` löschen und den Container neu starten. Danach erscheint wieder die Einrichtungsseite. Alle Konten sind dann weg, die Downloads bleiben.

## Tipps

**„Sign in to confirm you're not a bot“:** YouTube blockt manche Server-IPs. So bekommst du es wieder zum Laufen:
1. Im Browser bei YouTube anmelden (am besten mit einem Zweitkonto).
2. Mit einer Erweiterung wie „Get cookies.txt LOCALLY“ die Datei `cookies.txt` exportieren.
3. In ScobeTube unter ⚙ **Einstellungen → Cookies** hochladen.

**Downloads gehen plötzlich nicht mehr:** In den Einstellungen auf **yt-dlp aktualisieren** klicken oder den Container neu starten. Hilft das nicht, `YTDLP_CHANNEL=nightly` setzen.

**Lesezeichen / iOS-Kurzbefehl:** `http://<server>:8081/?url=<link>&kind=audio` öffnet ScobeTube mit dem Link im Eingabefeld. Gestartet wird der Download per Klick, das schützt vor fremden Seiten, die heimlich Downloads auslösen wollen.

## Reverse Proxy

ScobeTube nutzt Server-Sent Events für die Live-Updates. Bei nginx sollte für `/api/events` das Buffering aus sein. ScobeTube setzt dafür schon `X-Accel-Buffering: no`, eine Extra-Konfiguration ist normalerweise nicht nötig.

## Entwicklung

```bash
pip install -r requirements.txt
DOWNLOAD_DIR=./downloads STATE_DIR=./data python -m app
```

Benötigt `ffmpeg` und für YouTube [`deno`](https://deno.com) im `PATH`.
