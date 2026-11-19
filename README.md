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
- **Spotify:** Songs, Alben, Playlists und Künstler (Top-Songs). Spotify-Audio ist DRM-geschützt und wird nicht von Spotify geladen. ScobeTube liest nur Titel, Interpret, Album und Cover, sucht denselben Song auf YouTube Music (Abgleich über Länge und Titel) und schreibt die Spotify-Infos samt Cover in die Datei. Wie bei spotDL kann der Abgleich in seltenen Fällen eine andere Version erwischen. Über den ↗-Knopf lässt sich das prüfen.
- **Tidal:** Songs, Alben und Playlists (bis 50 Songs). Wie bei Spotify werden nur die öffentlichen Angaben (Titel, Interpreten, Album, Cover, Länge) von Tidal gelesen. Der Song selbst kommt von YouTube Music.
- **🥔 Potato-Modus:** Für schwache PCs schaltet er alle Animationen und Effekte ab (Schalter im Profilmenü und auf der Anmeldeseite, gespeichert pro Gerät). Ruckelt die Seite, wird er automatisch vorgeschlagen.
- **Fortschritt im Browser-Tab:** Prozentanzeige im Titel und ein Tab-Icon, das sich beim Download füllt
- **Uptime des Containers** in der Fußzeile, läuft live mit
- **Selbstheilung:** yt-dlp wird täglich aktualisiert. Schlagen mehrere Downloads wegen einer Änderung bei YouTube & Co. fehl, aktualisiert ScobeTube sich selbst, weicht notfalls auf die Nightly-Version aus, versucht die Downloads erneut und meldet das dem Admin
- **Teilen vom Handy** (über HTTPS): ScobeTube als App installieren und Links aus YouTube, Spotify & Co. über „Teilen“ schicken. Auf dem iPhone geht das per Kurzbefehl, gestartet wird mit einem Tipp auf „Video“ oder „Audio“.
- **Mit Benutzern teilen** (über HTTPS, nur an Konten): Fertige Downloads gezielt für andere Benutzer freigeben. Es gibt keine öffentlichen Links, und Empfänger können nur ansehen und herunterladen.
- **Auto-Löschung:** Heruntergeladene Dateien werden nach 10 Stunden automatisch gelöscht (einstellbar). An jedem Download steht, wie lange er noch bleibt.
- **Statistik pro Benutzer:** Downloads und Datenmenge insgesamt sowie der aktuell belegte Speicher, für Admins von allen Benutzern
- **Live-Systemmonitor:** CPU, RAM und Speicher mit Verlauf der letzten 3 Minuten, dazu Load und der RAM-Verbrauch von ScobeTube (sichtbar für Admins und Benutzer mit dem Recht „Einstellungen“)
- **Player:** Fertige Downloads direkt im Browser abspielen. Audio läuft mit drehender Platte und Live-Visualizer, Video im Player mit Vollbild. Vor/Zurück springt durch die Liste, dazu 🔀 Zufallswiedergabe und 🔁 Wiederholen (alle / ein Song). Steuerbar auch über Sperrbildschirm, Kopfhörer- und Medientasten (Media Session). Tasten: Leertaste = Play/Pause, ←/→ = 10 s spulen, N = nächster, S = Shuffle, R = Wiederholen, L = Songtext.
- **🎤 Synchronisierte Songtexte:** Im Player läuft der Text zeilengenau mit (bei vielen Songs sogar Wort für Wort im Karaoke-Stil); ein Klick auf eine Zeile springt an diese Stelle. Quelle ist die freie Datenbank [LRCLIB](https://lrclib.net). Auf Wunsch wird der Text (im LRC-Format, also mit Zeitmarken) in die Audiodatei geschrieben, entweder per Knopf im Player oder automatisch mit dem Haken „Songtext einbetten“ beim Download. Navidrome, Jellyfin, Plexamp, Poweramp & Co. zeigen ihn dann ebenfalls synchron an.
- **Zuschneiden:** Nur einen Teil laden (z. B. 1:20–2:45). Audio wird exakt geschnitten, Video auf etwa eine Sekunde genau.
- **ZIP-Download:** Über „Auswählen“ mehrere fertige Downloads markieren und als eine ZIP-Datei laden
- **Tags bearbeiten (Audio):** Titel, Interpret, Album und Cover nachträglich ändern, auf Wunsch wird die Datei passend umbenannt (MP3, M4A, FLAC, Opus, WAV)
- **SponsorBlock** (optional): Werbung, Eigenwerbung, Intros, Outros und „Abonnieren“-Erinnerungen aus YouTube-Videos herausschneiden
- **Kapitel aufteilen** (optional): Mixe, Alben oder Hörbücher anhand ihrer Kapitel in einzelne Dateien zerlegen, mit Titel und Tracknummer
- **📌 Behalten:** Einzelne Downloads von der Auto-Löschung ausnehmen (eigenes Recht „Downloads dauerhaft behalten“)
- **Zwei-Faktor-Login:** Authenticator-App (TOTP) und/oder Passkeys (Google-Passwortmanager, Android, iPhone, Windows Hello, Sicherheitsschlüssel) sowie Wiederherstellungscodes
- **Datenschutzfreundlich:** Schriften lokal, Vorschaubilder über den Server. Der Browser kontaktiert keine fremden Server, es gibt kein Tracking und nur ein technisch notwendiges Cookie.
- **Rechtliches:** Seite mit Hinweis auf private Nutzung, Nutzungsbedingungen und Datenschutzhinweisen (`/rechtliches`); die Instanz ist für Suchmaschinen gesperrt. Als Admin bearbeitest du alle Texte, den Hinweis auf der Anmeldeseite und die Betreiberangaben direkt auf der Seite (✎ Bearbeiten, mit Live-Vorschau).
- **📚 Mediathek für Navidrome, Jellyfin & Plex:** Behaltene (📌) oder alle Audio-Downloads landen geordnet als `Interpret/Album/Titel` im Ordner `/library`. Die Auto-Löschung fasst sie dort nicht an. Danach stößt ScobeTube automatisch den Scan im Medienserver an. Einstellbar als Admin unter Einstellungen → Mediathek (mit „Verbindung testen“ und „Jetzt alle übernehmen“). Tipp: Den gleichen Host-Ordner (`./library`) im Medienserver-Container als Musik-Ordner einhängen.
- **Angemeldete Geräte:** Unter „Sicherheit & Geräte“ siehst du, wo du angemeldet bist (Browser, System, IP, zuletzt aktiv) und kannst einzelne oder alle anderen Geräte abmelden. Admins sehen die Geräte jedes Benutzers und können ihn überall abmelden.
- **Notfall-Werkzeuge für Admins:** Passwort neu setzen (auch als Zufallspasswort), Authenticator-App entfernen, einzelne oder alle Passkeys löschen, Wiederherstellungscodes löschen oder den Zwei-Faktor-Login komplett zurücksetzen. Der Benutzer wird dabei überall abgemeldet.
- Ein paar versteckte Easter Eggs 🥚
- **↗-Knopf** bei jedem Download, der die Originalseite öffnet (YouTube-Video, SoundCloud-Track, Spotify-Song …)
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
| `RETENTION_HOURS` | `10` | Dateien nach so vielen Stunden automatisch löschen (`0` = nie) |
| `LIBRARY_DIR` | `/library` | Ordner der Mediathek (für Navidrome, Jellyfin, Plex) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | – | Optional: legt beim allerersten Start automatisch den Admin an (statt über die Einrichtungsseite) |
| `OPERATOR_NAME` / `OPERATOR_CONTACT` | – | Optional: Betreiber und Kontakt auf der Seite „Rechtliches“ |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` | automatisch | Nur nötig, wenn Passkeys hinter einem Proxy die Domain falsch erkennen (z. B. `tube.example.de` / `https://tube.example.de`) |
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
| Einstellungen | yt-dlp-Update, Cookies, Systemmonitor (CPU, RAM, Speicher) |
| Administrator | Alle Rechte und die Benutzerverwaltung |

**Sicherheit**
- Passwörter werden nur als scrypt-Hash gespeichert, niemals im Klartext.
- Nach 5 Fehlversuchen wird die Anmeldung 15 Minuten gesperrt (pro IP und Konto), nach 20 Fehlversuchen die ganze IP.
- Sitzungen liegen nur auf dem Server. Das Cookie ist `HttpOnly` und `SameSite=Strict`, und auf dem Server wird nur ein Hash des Tokens gespeichert.
- Schutz vor CSRF und Clickjacking, dazu eine strikte Content-Security-Policy.
- Wer ein Passwort ändert, beendet damit alle anderen Sitzungen dieses Kontos. Gesperrte Konten werden sofort abgemeldet.
- **Für den Zugriff aus dem Internet** solltest du HTTPS über einen Reverse-Proxy nutzen (z. B. Nginx Proxy Manager, Caddy oder Traefik). Ohne HTTPS geht das Passwort unverschlüsselt durchs Netz.

**Zwei-Faktor-Login:** Jeder Benutzer kann ihn oben rechts im Profil unter „Zwei-Faktor-Login“ einschalten, mit einer Authenticator-App und/oder einem Passkey. Dabei werden einmalig 8 Wiederherstellungscodes angezeigt, die man sicher aufbewahren sollte. Verliert jemand sein Handy, kann der Admin den Zwei-Faktor-Login des Kontos unter „Benutzer & Rechte“ zurücksetzen.

> **Passkeys brauchen HTTPS.** Browser erlauben Passkeys nur auf `https://…` (oder `localhost`). Über `http://192.168.x.x` geht nur die Authenticator-App. HTTPS bekommst du am einfachsten mit einem Reverse-Proxy wie Nginx Proxy Manager, Caddy oder Traefik und einer eigenen (Sub-)Domain. Danach unbedingt `TRUSTED_PROXIES` auf die IP des Proxys setzen.

**Passwort vergessen?** Auf dem Server die Datei `data/users.json` löschen und den Container neu starten. Danach erscheint wieder die Einrichtungsseite. Alle Konten sind dann weg, die Downloads bleiben.

## Tipps

**„Sign in to confirm you're not a bot“:** YouTube blockt manche Server-IPs. So bekommst du es wieder zum Laufen:
1. Im Browser bei YouTube anmelden (am besten mit einem Zweitkonto).
2. Mit einer Erweiterung wie „Get cookies.txt LOCALLY“ die Datei `cookies.txt` exportieren.
3. In ScobeTube unter ⚙ **Einstellungen → Cookies** hochladen.

**Downloads gehen plötzlich nicht mehr:** In den Einstellungen auf **yt-dlp aktualisieren** klicken oder den Container neu starten. Hilft das nicht, `YTDLP_CHANNEL=nightly` setzen.

**Lesezeichen / iOS-Kurzbefehl:** `http://<server>:8081/?url=<link>&kind=audio` öffnet ScobeTube mit dem Link im Eingabefeld. Gestartet wird der Download per Klick, das schützt vor fremden Seiten, die heimlich Downloads auslösen wollen.

## Android-App

Im Ordner `android/` liegt eine native Android-App (Kotlin, ab Android 8):

- Intro-Animation, Neo-Brutalismus-Design wie die Webseite, Pull-to-Refresh
- Erscheint im **Teilen-Menü** von YouTube, Spotify, SoundCloud & Co. („In ScobeTube laden“)
- Downloads landen in `Downloads/ScobeTube`, Datei-Uploads (Cookies, Cover) funktionieren
- **Updates:** Bei jedem Start fragt die App den Server nach einer neueren Version. Gibt es eine, ploppt ein animiertes Update-Fenster auf. Ein Tipp lädt sie herunter, prüft sie (Prüfsumme, Paketname, Versionsnummer) und installiert sie.

Die Webseite bietet immer die aktuelle APK an: über Banner (Android), Profilmenü, Fußzeile und Anmeldeseite (`/app/download`).

### Neue App-Version veröffentlichen

**Weg 1 – automatisch über GitHub (empfohlen)**
1. Einmalig zwei Secrets im GitHub-Repo anlegen (Settings → Secrets and variables → Actions): `ANDROID_KEYSTORE_BASE64` und `ANDROID_KEYSTORE_PASSWORD` (Signierschlüssel der App).
2. Optional `android/release-notes.md` anpassen. Der Text erscheint im Update-Fenster der App.
3. Tag pushen: `git tag app-v1.1.0 && git push origin app-v1.1.0`, oder auf GitHub unter *Actions → Android-App bauen → Run workflow* eine Version eintragen.
4. GitHub baut die APK und veröffentlicht sie als Release. Der ScobeTube-Server holt sie sich automatisch (spätestens nach 6 Stunden, sofort über *Einstellungen → Android-App → Von GitHub holen*).

**Weg 2 – Upload:** Als Admin unter *Einstellungen → Android-App* eine APK hochladen. Sie wird geprüft (richtige App, neuere Version) und sofort verteilt.

| Variable | Standard | Beschreibung |
|---|---|---|
| `APP_RELEASE_REPO` | `Scobecraft/ScobeTube` | GitHub-Repo, dessen Releases (`app-v…` mit `.apk`) automatisch geholt werden. Leer = aus |

> Der Signierschlüssel muss für alle Versionen gleich bleiben, sonst lehnt Android das Update ab. Bewahre ihn sicher auf.

## Cloudflare Tunnel

ScobeTube funktioniert gut hinter einem Cloudflare Tunnel und bekommt damit HTTPS. Das ist die Voraussetzung für Passkeys, die Handy-App und das Teilen.

1. In der `docker-compose.yml` `TRUSTED_PROXIES=*` setzen, damit die echte Besucher-IP (für den Schutz gegen Passwort-Raten) und HTTPS erkannt werden.
2. Port 8081 **nicht** im Router freigeben. Der Zugang aus dem Internet läuft nur über den Tunnel.
3. Optional als zusätzliche Schutzschicht: Cloudflare Access (Zero Trust) vor die Domain schalten.

Hinweis: Cloudflares Bedingungen sehen das kostenlose Angebot nicht für das Ausliefern großer Mengen Videodaten vor. Für den privaten Gebrauch ist das in der Regel kein Problem, große Dateien lädt man im Heimnetz aber schneller direkt.

## Reverse Proxy

ScobeTube nutzt Server-Sent Events für die Live-Updates. Bei nginx sollte für `/api/events` das Buffering aus sein. ScobeTube setzt dafür schon `X-Accel-Buffering: no`, eine Extra-Konfiguration ist normalerweise nicht nötig.

## Entwicklung

```bash
pip install -r requirements.txt
DOWNLOAD_DIR=./downloads STATE_DIR=./data python -m app
```

Benötigt `ffmpeg` und für YouTube [`deno`](https://deno.com) im `PATH`.
