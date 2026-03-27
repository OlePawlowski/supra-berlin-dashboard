# Gruppenanfragen Dashboard

Eigenständige Webapp für `Supra Berlin`, um Gruppenanfragen ab `9+ Personen` zentral zu verwalten.

## Enthaltene Funktionen

- Website-Formular als öffentlicher Eingang
- Admin-Login mit Passwort
- Dashboard mit Status, Filter und Suchfunktion
- Kalenderansicht pro Monat
- Detailansicht mit Nachrichtenverlauf
- Statuswechsel mit optionalen E-Mail-Vorlagen
- Interne Notizen pro Anfrage
- Optionale SMTP-Anbindung für echte ausgehende E-Mails
- Optionale IMAP-Synchronisierung für eingehende Kundenantworten
- Öffentliche Kalender-API für die Einbindung auf `supraberlin.de`

## Starten

```bash
cp .env.example .env
npm install
npm run dev
```

Danach ist die App unter [http://localhost:3030](http://localhost:3030) erreichbar.

- Startseite: `http://localhost:3030/`
- Dashboard: `http://localhost:3030/admin`

Standard-Login lokal:

- Passwort: `supra-admin`

Bitte in `.env` unbedingt ändern, bevor die App produktiv genutzt wird.

## E-Mail-Verhalten

Ohne SMTP-Zugang läuft die App trotzdem vollständig lokal:

- Anfragen werden gespeichert
- Antworten aus dem Dashboard werden im Verlauf abgelegt
- Ausgehende E-Mails landen als JSON-Dateien in `data/email-outbox`

Mit SMTP-Zugang werden Nachrichten real an den Gast versendet.

Mit IMAP-Zugang kann die App Antworten aus dem Postfach abholen und automatisch dem passenden Vorgang zuordnen. Die Zuordnung passiert über den Referenzcode im Betreff, z. B. `[SUPRA-REQ-0004]`.

Wenn die Website und das Dashboard auf unterschiedlichen Domains laufen, kann zusätzlich `PUBLIC_CORS_ORIGIN` gesetzt werden.

## Daten

Die App legt automatisch einen SQLite-Datenspeicher an:

- Datenbank: `data/supra-dashboard.db`
- Geloggte E-Mails: `data/email-outbox/`
- IMAP-Status: `data/imap-state.json`

## Morgen nur noch eintragen

Wenn Server und Domain bereits stehen, müsst ihr im Regelfall nur noch diese Werte in `.env` ergänzen:

1. `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
2. `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASS`
3. `ADMIN_PASSWORD` und `SESSION_SECRET` produktiv ändern

Optional:

- `PUBLIC_CORS_ORIGIN`, falls die Website nicht unter derselben Domain wie das Dashboard läuft
