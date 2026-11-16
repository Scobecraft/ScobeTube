"""Bearbeitbare Rechtstexte (Markdown-Teilmenge, wird im Browser sicher dargestellt)."""
from __future__ import annotations

import json
import os
import threading
import time
from typing import Any

from . import config

MAX_LEN = 60_000

# Reihenfolge = Reihenfolge auf der Seite. "login" erscheint nur auf der Anmeldeseite.
DEFAULTS: dict[str, dict[str, str]] = {
    "privat": {
        "title": "🔒 Private Instanz",
        "text": """Diese ScobeTube-Installation ist ein **rein privates, nicht-kommerzielles Angebot** für einen kleinen, persönlich bekannten Personenkreis. Sie ist **kein öffentlicher Dienst**: Es gibt keine freie Registrierung, Konten werden ausschließlich vom Betreiber persönlich vergeben. Es werden keine Entgelte erhoben, keine Werbung gezeigt und keine Daten verkauft.

Wer ohne Einladung auf diese Seite gelangt ist, wird gebeten, sie wieder zu verlassen.""",
    },
    "nutzung": {
        "title": "📜 Nutzungsbedingungen",
        "text": """Mit der Anmeldung akzeptierst du die folgenden Regeln:

1. **Nur private Nutzung.** Heruntergeladene Dateien sind ausschließlich für den eigenen, privaten Gebrauch bestimmt, nicht für gewerbliche Zwecke.
2. **Nur, was du darfst.** Lade nur Inhalte herunter, zu denen du berechtigt bist, zum Beispiel eigene Werke, gemeinfreie Inhalte, Inhalte unter freien Lizenzen (z. B. Creative Commons), Inhalte mit Erlaubnis der Rechteinhaber oder Privatkopien im gesetzlich erlaubten Rahmen (§ 53 UrhG). Nicht erlaubt sind Kopien von offensichtlich rechtswidrig hergestellten oder rechtswidrig öffentlich zugänglich gemachten Vorlagen.
3. **Kein Umgehen von Kopierschutz.** Wirksame technische Schutzmaßnahmen dürfen nicht umgangen werden (§ 95a UrhG). Kopiergeschützte Musik, etwa von Spotify, wird von ScobeTube **nicht** entschlüsselt. Übernommen werden nur öffentlich sichtbare Angaben wie Titel, Interpret und Cover.
4. **Nicht weitergeben.** Dateien dürfen nicht veröffentlicht, hochgeladen, verkauft, öffentlich vorgeführt oder an Dritte weitergegeben werden.
5. **Regeln der Plattformen beachten.** Die Nutzungsbedingungen von YouTube, SoundCloud, Spotify und anderen Plattformen können das Herunterladen einschränken. Jede Person ist selbst dafür verantwortlich, diese einzuhalten.
6. **Eigene Verantwortung.** Jeder Download wird dem jeweiligen Konto zugeordnet. Für die heruntergeladenen Inhalte ist allein die Person verantwortlich, die sie heruntergeladen hat.
7. **Konto schützen.** Zugangsdaten dürfen nicht weitergegeben werden. Wir empfehlen den Zwei-Faktor-Login.
8. **Folgen bei Verstößen.** Bei Verstößen kann der Betreiber Konten jederzeit sperren oder löschen.
9. **Keine Gewähr.** Der Dienst wird freiwillig und ohne Garantie für Verfügbarkeit bereitgestellt. Dateien werden automatisch gelöscht, wichtige Dateien solltest du also selbst sichern.""",
    },
    "datenschutz": {
        "title": "🛡️ Datenschutz",
        "text": """### Verantwortlich
Verantwortlich für die Datenverarbeitung ist der Betreiber dieser Installation (siehe [Betreiber](#betreiber)).

### Welche Daten gespeichert werden
- **Konto:** Benutzername, Rechte, Zeitpunkt der Anmeldungen. Das Passwort wird nie im Klartext gespeichert, sondern nur als scrypt-Hash.
- **Sitzungen:** IP-Adresse und Browserkennung angemeldeter Geräte. Sie dienen der Sicherheit und dem Abmelden fremder Geräte.
- **Zwei-Faktor-Login (falls eingerichtet):** der Schlüssel der Authenticator-App, die öffentlichen Schlüssel deiner Passkeys (keine biometrischen Daten, Fingerabdruck und Gesicht verlassen nie dein Gerät) sowie gehashte Wiederherstellungscodes.
- **Downloads:** eingegebene Links, Titel, gewählte Optionen, Dateien und eine Statistik (Anzahl und Datenmenge).
- **Server-Protokoll:** technische Meldungen, darunter IP-Adresse und Benutzername bei fehlgeschlagenen Anmeldungen, um Angriffe zu erkennen.

### Zweck und Rechtsgrundlage
Die Verarbeitung dient allein der Bereitstellung des Dienstes für angemeldete Personen (Art. 6 Abs. 1 lit. b DSGVO) und seiner Sicherheit, etwa dem Schutz vor Passwort-Raten (Art. 6 Abs. 1 lit. f DSGVO). Rein persönliche oder familiäre Tätigkeiten fallen nach Art. 2 Abs. 2 lit. c DSGVO gegebenenfalls gar nicht unter die DSGVO. Die Angaben hier dienen trotzdem der Transparenz.

### Speicherdauer
- Heruntergeladene Dateien und ihre Einträge werden **{{loeschfrist}}** gelöscht, außer sie wurden ausdrücklich mit 📌 zum Behalten markiert.
- Sitzungen enden nach 12 Stunden, mit „Angemeldet bleiben“ nach 30 Tagen, oder beim Abmelden.
- Kontodaten bleiben gespeichert, bis das Konto gelöscht wird. Die Download-Statistik wird mit dem Konto gelöscht.

### Cookies und lokale Speicherung
Es wird nur ein **technisch notwendiges Sitzungs-Cookie** für die Anmeldung gesetzt (§ 25 Abs. 2 Nr. 2 TDDDG). Dafür ist keine Einwilligung und kein Cookie-Banner nötig. Bedienungs-Einstellungen wie das gewählte Format oder die Lautstärke speichert nur dein Browser lokal. Es gibt kein Tracking, keine Analyse-Werkzeuge und keine Werbung.

### Keine Einbindung fremder Server
Schriften, Skripte und Grafiken werden ausschließlich von diesem Server geladen. Auch Vorschaubilder holt der Server selbst und reicht sie weiter, damit dein Browser keine Verbindung zu YouTube, Spotify, Google oder anderen Anbietern aufbaut. Beim Herunterladen ruft der **Server** die jeweilige Plattform auf, dort ist dann nur die Adresse des Servers sichtbar, nicht deine. Ist „SponsorBlock“ aktiviert, fragt der Server die Video-ID bei sponsor.ajay.app ab. Daten werden nicht an Dritte weitergegeben oder verkauft.

### Deine Rechte
Du hast das Recht auf Auskunft, Berichtigung, Löschung und Einschränkung der Verarbeitung, auf Datenübertragbarkeit, auf Widerspruch und auf Beschwerde bei einer Datenschutz-Aufsichtsbehörde. Wende dich dafür an den Betreiber. Dein Konto samt Daten wird auf Wunsch vollständig gelöscht.""",
    },
    "betreiber": {
        "title": "👤 Betreiber",
        "text": """{{betreiber}}

Ein Impressum (§ 5 DDG) ist nur für geschäftsmäßige, in der Regel gegen Entgelt angebotene Dienste vorgeschrieben. Diese Installation ist ein rein privates Angebot ohne Gewinnabsicht.""",
    },
    "login": {
        "title": "Hinweis auf der Anmeldeseite",
        "text": """**🔒 Private Instanz**: nur für Personen, die vom Betreiber eingeladen wurden. Kein öffentliches oder kommerzielles Angebot. Mit der Anmeldung bestätigst du, nur Inhalte herunterzuladen, zu denen du berechtigt bist (z. B. eigene, freie oder als Privatkopie erlaubte Inhalte), sie nicht weiterzugeben und die [Nutzungsbedingungen](rechtliches#nutzung) sowie die [Datenschutzhinweise](rechtliches#datenschutz) zu akzeptieren. Es wird nur ein technisch notwendiges Cookie gesetzt.""",
    },
}


class LegalStore:
    def __init__(self) -> None:
        self.lock = threading.Lock()

    @property
    def path(self):
        return config.STATE_DIR / "legal.json"

    def _read(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text("utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def get(self) -> dict[str, Any]:
        data = self._read()
        custom = data.get("sections") or {}
        sections = []
        for key, d in DEFAULTS.items():
            c = custom.get(key) or {}
            sections.append({"key": key, "title": c.get("title") or d["title"], "text": c.get("text") or d["text"],
                             "custom": bool(c), "default_title": d["title"], "default_text": d["text"]})
        return {
            "sections": sections,
            "operator_name": data.get("operator_name", config.OPERATOR_NAME),
            "operator_contact": data.get("operator_contact", config.OPERATOR_CONTACT),
            "updated": data.get("updated"),
            "updated_by": data.get("updated_by"),
        }

    def save(self, sections: dict[str, Any], operator_name: str | None, operator_contact: str | None, by: str) -> None:
        clean: dict[str, dict[str, str]] = {}
        for key, val in (sections or {}).items():
            if key not in DEFAULTS or not isinstance(val, dict):
                continue
            title = str(val.get("title") or "").strip()[:120]
            text = str(val.get("text") or "").replace("\r\n", "\n").strip()
            if len(text) > MAX_LEN:
                raise ValueError(f"Der Text „{title or key}“ ist zu lang (max. {MAX_LEN} Zeichen)")
            # Unverändert gegenüber Standard → nicht speichern (Standard bleibt aktuell)
            if text == DEFAULTS[key]["text"] and (not title or title == DEFAULTS[key]["title"]):
                continue
            clean[key] = {"title": title, "text": text}
        with self.lock:
            data = self._read()
            data["sections"] = clean
            if operator_name is not None:
                data["operator_name"] = str(operator_name).strip()[:200]
            if operator_contact is not None:
                data["operator_contact"] = str(operator_contact).strip()[:200]
            data["updated"] = time.time()
            data["updated_by"] = by
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")
            os.replace(tmp, self.path)

    def reset(self) -> None:
        with self.lock:
            self.path.unlink(missing_ok=True)


legal = LegalStore()
