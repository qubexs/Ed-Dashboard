# EDDASH — Emergency Department Live Dashboard

A waiting-room display for an emergency department, plus a management API that feeds
it. Three separate servers, one database, one API key model.

```
   PMS :5000                     API :4000                    DASHBOARD :3000
 ┌─────────────────┐          ┌──────────────────┐         ┌──────────────────┐
 │ patient system  │  pull    │ management API   │  HTTP   │ read-only screen │
 │ or simulator    │ ───────► │ admin + keys     │ ──────► │ no database      │
 │ pms.* schema    │ /api/*   │ auth + settings  │         │ kiosk browser    │
 └─────────────────┘          └──────────────────┘         └──────────────────┘
                                     │
                              PostgreSQL  (public tables + pms schema)
```

| Server | Default port | What it is | Database |
| ------ | ------------ | ---------- | -------- |
| **PMS** | 5000 | Stand-in patient management system: register arrivals, triage, request ward beds. Exposes the feed the API pulls. | `pms.*` schema |
| **API** | 4000 | The complete backend: admin panel, authentication, API keys, settings, **read API (`/api/v1`)**, **write API (`/api/integration`)**, pull scheduler. | `public` tables |
| **Dashboard** | 3000 | The screen on the wall. Renders from the API and proxies metrics/QR to the browser. | none |

Contents: [Install](#1-install) · [Run](#2-run) · [Configuration](#3-configuration) ·
[API reference](#4-api-reference) · [Deploy](#5-deploy) · [Operations](#6-operations) ·
[Troubleshooting](#7-troubleshooting) · [Project structure](#8-project-structure)

---

## 1. Install

### Requirements

| Tool | Version | Notes |
| ---- | ------- | ----- |
| Node.js | 20+ (tested on 24) | `node -v` |
| npm | 10+ | ships with Node |
| PostgreSQL | 14+ (tested on 16) | local install or managed |
| nginx | any recent | only for deployment behind a hostname |

### Step 1 — Get the code

```bash
git clone <your-repo-url> eddash
cd eddash
```

### Step 2 — Create the database

```bash
sudo -u postgres psql -c "CREATE ROLE eddash LOGIN PASSWORD 'eddash';"
sudo -u postgres createdb -O eddash eddash
```

Windows (run in an elevated prompt):

```powershell
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -c "CREATE ROLE eddash LOGIN PASSWORD 'eddash';"
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -c "CREATE DATABASE eddash OWNER eddash;"
```

### Step 3 — Configure

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

```ini
DATABASE_URL=postgres://eddash:eddash@127.0.0.1:5432/eddash
SESSION_SECRET=<output of: openssl rand -hex 32>
ADMIN_PASSWORD=<a strong password>
```

The defaults for ports and the API↔PMS token are fine for a first run. Full reference:
[Configuration](#3-configuration).

### Step 4 — Install dependencies and create the schemas

```bash
npm ci
npm run db:migrate     # dashboard tables, settings, zones, admin user
npm run pms:migrate    # pms schema for the simulator
npm run pms:connect    # point the API pull worker at the local PMS
```

### Step 5 — (Optional) demo data

```bash
npm run pms:seed       # 40 demo patients in the PMS
npm run pms:seed -- --force   # reset and regenerate
```

Leave `SEED_DEMO=false` when the PMS feeds the API — otherwise you get a second set of
fake patients that the PMS never updates. Set `SEED_DEMO=true` only if you want the
display populated without a PMS.

### Checklist

| Check | Expected |
| ----- | -------- |
| `npm run typecheck` | no output, exit 0 |
| `http://localhost:5000` | PMS console with a patient table |
| `http://localhost:4000/api/health` | `{"status":"ok", ...}` |
| `http://localhost:4000/admin` | login form |
| `http://localhost:3000` | the display, with numbers |

---

## 2. Run

### All three servers (development, watch mode)

```bash
npm run dev:all
```

Each line of output is prefixed `[pms]`, `[api]` or `[dashboard]`. `Ctrl+C` stops all
three.

### One at a time

```bash
npm run dev:pms     # port 5000
npm run dev:api     # port 4000
npm run dev:dash    # port 3000
```

### Production build

```bash
npm run build
npm run start:pms   # node dist/src/servers/pms.js
npm run start:api   # node dist/src/servers/api.js
npm run start:dash  # node dist/src/servers/dashboard.js
```

### Legacy single process

`npm run dev` / `npm start` still run everything (display + admin + API) in one process
on port 3000. Useful for a quick look; it also uses port 3000, so do not run it next to
`dev:all`. The Docker image uses this mode.

### First sign-in

Open `http://localhost:4000/admin` and use `ADMIN_USERNAME` / `ADMIN_PASSWORD`
(default `admin` / `admin123`). **Change the password immediately** in
**Users → Change my password**.

### Ports

| Port | Server | Paths |
| ---- | ------ | ----- |
| 3000 | Dashboard | `/` display, `/api/dashboard` metrics proxy, `/api/qr` QR proxy, `/health` |
| 4000 | API | `/admin` panel, `/api/v1/*` read API, `/api/integration/*` write API, `/api/dashboard`, `/api/health` |
| 5000 | PMS | `/` console, `/api/patients`, `/api/wards`, `/api/health` |

---

## 3. Configuration

One `.env` file is read by all three servers; each uses the keys it needs.

### Server layout

| Variable | Default | Used by | Meaning |
| -------- | ------- | ------- | ------- |
| `PORT` | `3000` | dashboard, legacy | Dashboard port |
| `API_PORT` | `4000` | API | Management API port |
| `PMS_PORT` | `5000` | PMS | Simulator port |
| `API_BASE_URL` | `http://127.0.0.1:4000` | dashboard | Where the display reads metrics |
| `DASHBOARD_BASE_URL` | `http://127.0.0.1:3000` | API | Public display URL used in admin links |
| `API_TIMEOUT_MS` | `4000` | dashboard | Timeout for upstream API calls |
| `PMS_BASE_URL` | `http://127.0.0.1:5000/api` | tooling | PMS base URL written by `pms:connect` |
| `PMS_SEED_DEMO` | `true` | PMS | Seed 40 patients on first start |
| `PMS_SCHEMA` | `pms` | PMS | Postgres schema for PMS tables |

### Database and security

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `DATABASE_URL` | `postgres://eddash:eddash@localhost:5432/eddash` | Connection string |
| `DATABASE_SSL` | `false` | `true` for managed Postgres with TLS |
| `SESSION_SECRET` | dev value | Signs admin session cookies. **Required** in production |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / `admin123` | First admin, created when `users` is empty |
| `SEED_DEMO` | `false` | Seed dashboard tables on boot |
| `TRUST_PROXY` | `false` | `true` behind nginx/TLS so cookies are `secure` |
| `TZ` | `Asia/Kuala_Lumpur` | Container system timezone |

### API ↔ PMS authentication

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `PMS_SERVER_TOKEN` | `pms-local-token` | Bearer token the PMS requires on `/api/*`. Empty disables auth |
| `PMS_API_KEY` | empty | Outbound key the API sends when pulling. Overrides the value stored in settings |

Both values must match. Change them together for production.

### Pull settings (stored in the database)

`npm run pms:connect` writes these to the `settings` table; you can also edit them in
**Admin → PMS integration**:

| Setting | Default after `pms:connect` |
| ------- | --------------------------- |
| `pms_enabled` | `true` |
| `pms_base_url` | value of `PMS_BASE_URL` |
| `pms_patients_path` / `pms_wards_path` | `/patients` / `/wards` |
| `pms_interval_seconds` | `15` |

---

## 4. API reference

Two styles, same API key model.

### Keys

Create keys in **Admin → API keys**. The full key is shown **once** — copy it then.
Revoke a key to cut off a system immediately.

Send the key either way:

```http
X-API-Key: edd_xxxxxxxxxxxxxxxx
Authorization: Bearer edd_xxxxxxxxxxxxxxxx
```

Keys are stored as hashes; `last_used_at` is updated on every call.

### Read API (API provider) — `/api/v1`, key required

| Method | Endpoint | Purpose |
| ------ | -------- | ------- |
| `GET` | `/api/v1/ping` | Verify the key; returns the key name and server time |
| `GET` | `/api/v1/patients` | List patients. Filters: `status`, `zone`, `limit` (max 500), `offset` |
| `GET` | `/api/v1/patients/:id` | One patient by numeric id **or** `external_id` |
| `GET` | `/api/v1/wards` | List ward admissions. Filter: `status`, `limit`, `offset` |
| `GET` | `/api/v1/zones` | Zones with live counts |
| `GET` | `/api/v1/dashboard` | The display metrics (waiting time, totals, zone counts) |
| `GET` | `/api/v1/stats` | Queue totals (active, waiting, discharged, …) |
| `GET` | `/api/v1/settings` | Public display settings (no secrets) |
| `GET` | `/api/v1/health` | Database health |

```bash
curl -H "X-API-Key: edd_xxx" "http://localhost:4000/api/v1/patients?status=waiting&limit=5"
```

```json
{
  "ok": true,
  "total": 19,
  "count": 5,
  "limit": 5,
  "offset": 0,
  "patients": [
    {
      "id": "38",
      "external_id": "PMS-00041",
      "medical_no": "Z999999",
      "name": "Pipeline Test",
      "zone_code": "red",
      "status": "waiting",
      "arrived_at": "2026-10-30T13:15:03.348Z",
      "triaged_at": null,
      "called_at": null,
      "discharged_at": null,
      "notes": null,
      "waiting_minutes": 71
    }
  ]
}
```

### Write API (push from any PMS) — `/api/integration`, key required

| Method | Endpoint | Purpose |
| ------ | -------- | ------- |
| `GET` | `/api/integration/ping` | Verify the key |
| `POST` | `/api/integration/patients` | Create or update one patient |
| `POST` | `/api/integration/wards` | Create or update one ward admission |
| `POST` | `/api/integration/sync` | Batch upsert `patients` + `wards` in one transaction |

Records are matched by `external_id`, so retries are safe. `201` means created, `200`
means updated.

```bash
curl -X POST http://localhost:4000/api/integration/patients \
  -H "Content-Type: application/json" \
  -H "X-API-Key: edd_xxx" \
  -d '{ "external_id": "PMS-1001", "medical_no": "A123456", "name": "Ahmad bin Ali",
        "zone_code": "green", "status": "waiting",
        "arrived_at": "2026-10-30T22:10:00+08:00" }'
```

```bash
curl -X POST http://localhost:4000/api/integration/sync \
  -H "Content-Type: application/json" \
  -H "X-API-Key: edd_xxx" \
  -d '{ "patients": [ ... ], "wards": [ ... ] }'
```

**Patient fields** — `external_id` required; on update, omitted fields keep their value.

| Field | Type | Notes |
| ----- | ---- | ----- |
| `external_id` | string | PMS identifier, max 120 chars |
| `medical_no` | string | Max 60 |
| `name` | string | Max 120 |
| `zone_code` | string | Required on create; must be an active zone (`green`, `yellow`, `red`) |
| `status` | string | `waiting`, `in_treatment`, `waiting_ward`, `discharged`, `cancelled` |
| `arrived_at` | timestamp | Defaults to now; drives the waiting time |
| `triaged_at`, `called_at`, `discharged_at` | timestamp | Set automatically as status advances if omitted |
| `notes` | string | Max 500 |

**Ward fields** — `external_id` required.

| Field | Type | Notes |
| ----- | ---- | ----- |
| `external_id` | string | Admission identifier, max 120 |
| `patient_external_id` | string | Must already exist |
| `patient_name` | string | Used when no patient is linked |
| `ward` | string | Max 80 |
| `status` | string | `waiting`, `admitted`, `cancelled` |
| `requested_at` | timestamp | Defaults to now; drives the ward wait |
| `admitted_at` | timestamp | Set automatically when admitted |

Timestamps may be ISO 8601 (with or without offset) or epoch seconds/milliseconds.
Values without an offset use the hospital timezone from **Display settings**.

### Public endpoints (no key)

| Method | Endpoint | Purpose |
| ------ | -------- | ------- |
| `GET` | `/api/dashboard` | Metrics, used by the display server and its browser |
| `GET` | `/api/display-config` | Public display settings |
| `GET` | `/api/qr` | QR image (PNG) |
| `GET` | `/api/health` | Database health |

### Errors

Every response is JSON. `400` validation, `401` missing/invalid key, `404` not found,
`503` upstream unavailable.

```json
{ "ok": false, "error": "status must be one of: waiting, in_treatment, waiting_ward, discharged, cancelled." }
```

### Pulling instead of pushing

If the source system cannot push, the API polls it. Configure it in
**Admin → PMS integration** or run `npm run pms:connect`, then enable scheduled pull.
The scheduler runs inside the API process, applies each pull in one transaction and
records the last attempt and result on that page.

Field, status and zone maps are supported for systems whose names differ:

```json
{ "external_id": "patientId", "name": "fullName", "zone_code": "triageLevel",
  "status": "queueStatus", "arrived_at": "registrationTime" }
```

```json
{ "AWAITING": "waiting", "IN_TREATMENT": "in_treatment", "DISCHARGED": "discharged" }
```

### The PMS simulator

`/api/patients` and `/api/wards` on port 5000 return the same shape the pull worker
expects, protected by `PMS_SERVER_TOKEN`. The console at `http://localhost:5000` lets
you register patients, call them in, request beds, admit, discharge, simulate arrivals
and reset demo data.

---

## 5. Deploy

Tested layout: one Ubuntu host, PostgreSQL local, three Node processes under systemd,
nginx in front for TLS.

### Step 1 — Packages

```bash
sudo apt update
sudo apt install -y postgresql nodejs npm nginx
node -v    # 20 or newer
```

### Step 2 — Database

```bash
sudo -u postgres psql -c "CREATE ROLE eddash LOGIN PASSWORD 'CHANGE_ME';"
sudo -u postgres createdb -O eddash eddash
```

Do not publish PostgreSQL to the internet.

### Step 3 — Code and configuration

```bash
sudo mkdir -p /opt/eddash && sudo chown "$USER" /opt/eddash
git clone <your-repo-url> /opt/eddash
cd /opt/eddash
cp .env.example .env
nano .env
```

Production values:

```ini
NODE_ENV=production
DATABASE_URL=postgres://eddash:CHANGE_ME@127.0.0.1:5432/eddash
SESSION_SECRET=<openssl rand -hex 32>
ADMIN_PASSWORD=<strong password>
SEED_DEMO=false
TRUST_PROXY=true
PORT=3000
API_PORT=4000
PMS_PORT=5000
API_BASE_URL=http://127.0.0.1:4000
DASHBOARD_BASE_URL=https://dash.example.com
PMS_SERVER_TOKEN=<openssl rand -hex 24>
PMS_API_KEY=<same value>
```

`NODE_ENV=production` requires `SESSION_SECRET` and `ADMIN_PASSWORD`, and enables
secure cookies when `TRUST_PROXY=true`.

### Step 4 — Install, build, migrate

```bash
npm ci
npm run build
npm run db:migrate
npm run pms:migrate
npm run pms:connect
```

### Step 5 — systemd units

`/etc/systemd/system/eddash-pms.service`

```ini
[Unit]
Description=EDDASH PMS simulator
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=eddash
WorkingDirectory=/opt/eddash
EnvironmentFile=/opt/eddash/.env
ExecStart=/usr/bin/node dist/src/servers/pms.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/eddash-api.service`

```ini
[Unit]
Description=EDDASH management API
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=eddash
WorkingDirectory=/opt/eddash
EnvironmentFile=/opt/eddash/.env
ExecStart=/usr/bin/node dist/src/servers/api.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/eddash-dashboard.service`

```ini
[Unit]
Description=EDDASH display
After=network-online.target eddash-api.service
Wants=network-online.target

[Service]
Type=simple
User=eddash
WorkingDirectory=/opt/eddash
EnvironmentFile=/opt/eddash/.env
ExecStart=/usr/bin/node dist/src/servers/dashboard.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now eddash-pms eddash-api eddash-dashboard
systemctl status eddash-api --no-pager
```

Add your first integration key: open `http://SERVER_IP:4000/admin`, sign in, go to
**API keys**, create one, and copy it.

### Step 6 — nginx and TLS

```bash
sudo cp deploy/nginx.split.conf.example /etc/nginx/sites-available/eddash
sudo nano /etc/nginx/sites-available/eddash      # set server_name
sudo ln -s /etc/nginx/sites-available/eddash /etc/nginx/sites-enabled/eddash
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d dash.example.com
```

The sample routes `/` to the display (`:3000`) and `/admin`, `/api/` to the API
(`:4000`), so one hostname serves everything. The PMS stays internal.

Set `TRUST_PROXY=true` and `DASHBOARD_BASE_URL=https://dash.example.com`, then:

```bash
sudo systemctl restart eddash-api eddash-dashboard
```

### Step 7 — Firewall

```bash
sudo ufw allow 22,80,443/tcp
sudo ufw enable
```

Open only 22/80/443. Ports 3000, 4000 and 5000 are reachable from the host and the
reverse proxy, not from the network.

### Docker (single process)

`docker compose up -d --build` runs the legacy all-in-one app with PostgreSQL, using
`.env.docker.example`. It is fine for a demo; the three-server layout above is the
supported deployment.

### Backups

Both schemas live in the same database, so one dump covers everything:

```bash
pg_dump -U eddash eddash | gzip > "eddash-$(date +%F).sql.gz"
```

Restore while the services are stopped:

```bash
sudo systemctl stop eddash-dashboard eddash-api eddash-pms
gunzip -c eddash-2026-10-30.sql.gz | psql -U eddash -d eddash
sudo systemctl start eddash-pms eddash-api eddash-dashboard
```

Schedule it with cron and copy archives off the host.

### Updating

```bash
cd /opt/eddash
git pull
npm ci
npm run build
npm run db:migrate && npm run pms:migrate
sudo systemctl restart eddash-pms eddash-api eddash-dashboard
```

Schema changes are applied on boot as well; existing patient and settings data is kept.

---

## 6. Operations

### Health

| Check | Command |
| ----- | ------- |
| API and database | `curl http://localhost:4000/api/health` |
| Display → API link | `curl http://localhost:3000/health` |
| PMS and database | `curl http://localhost:5000/api/health` |
| Queue totals | `curl -H "X-API-Key: edd_xxx" http://localhost:4000/api/v1/stats` |

### Logs

```bash
journalctl -u eddash-api -f
journalctl -u eddash-dashboard -f
journalctl -u eddash-pms -f
```

The API logs each pull: `[pms] sync ok: patients 2+/37~, wards 0+/6~ (34 ms)`.

### What to watch

| Signal | Where |
| ------ | ----- |
| Pull failing | Admin → PMS integration → Last attempt / status |
| Screens not updating | `GET /health` on the display; check `API_BASE_URL` |
| API key misuse | Admin → API keys → Last used |
| Slow queries | Admin → Health (DB latency, row counts) |

### How the numbers are calculated

| Display metric | Rule |
| -------------- | ---- |
| Current estimated waiting time | Average minutes since `arrived_at` for `waiting` patients, plus `waiting_buffer_minutes`. Falls back to `waiting_fallback_minutes` when nobody waits |
| Total since 00:00 | Patients arriving after local midnight in the configured timezone |
| Waiting for ward | Average minutes since `requested_at` for `waiting` ward admissions, plus how many |
| Zone counts | `waiting` + `in_treatment` + `waiting_ward` per active zone |

Patient flow: `waiting → in_treatment → waiting_ward → discharged` (or `cancelled`).
Discharging or cancelling a patient cancels pending ward requests.

### Security checklist

- Change the seeded admin password; never keep `admin123`.
- Use a random `SESSION_SECRET`; rotating it signs everyone out.
- Keep `SEED_DEMO=false` when the PMS feeds the API.
- Give each connected system its own key and revoke unused keys.
- Keep PostgreSQL private; do not publish 5432.
- Serve over HTTPS and set `TRUST_PROXY=true`.
- Use separate `admin` and `viewer` accounts for staff who only need to look.
- Rotate `PMS_SERVER_TOKEN` and `PMS_API_KEY` together.

---

## 7. Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `EADDRINUSE` on 3000 | Legacy `npm run dev` is already running. Stop it or change `PORT` |
| Admin login loops back to the form | `TRUST_PROXY` must be `true` behind TLS, and `SESSION_SECRET` must stay constant across restarts |
| `401` on `/api/v1/*` | Check the key: sent as `X-API-Key` or `Authorization: Bearer`, not revoked |
| Display shows "Reconnecting" | API is down or `API_BASE_URL` is wrong: `curl http://localhost:4000/api/health` |
| Display shows zeros | The pull is disabled or has never run: `npm run pms:connect`, then check Admin → PMS integration |
| Pull fails with `HTTP 401` | `PMS_API_KEY` and `PMS_SERVER_TOKEN` differ |
| Pull fails with `fetch failed` | `pms_base_url` unreachable from the API host |
| Batch push returns `400` and writes nothing | One record is invalid; the whole transaction rolled back. Check `zone_code`, `status`, timestamps, and that the patient exists before a ward record |
| Times are off by hours | Set the IANA timezone in **Display settings**; check `TZ` in `.env` |
| `ENOENT db/schema.sql` | Start from the project root (WorkingDirectory in systemd) |
| `password authentication failed` | Wrong `DATABASE_URL` credentials, or `pg_hba.conf` requires a password |

---

## 8. Project structure

```
db/
  schema.sql                 dashboard tables, zones, default settings
  pms-schema.sql             pms.* tables
  migrate.ts                 apply dashboard schema
  pms-migrate.ts             apply pms schema
  pms-seed.ts                seed pms demo patients
  pms-connect.ts             point the API pull worker at the local PMS
  seed.ts, reset.ts          dashboard demo data
scripts/
  dev-all.mjs                run pms + api + dashboard with prefixed logs
src/
  servers/
    pms.ts                   PMS entrypoint (5000)
    api.ts                   API entrypoint (4000)
    dashboard.ts             display entrypoint (3000)
  apps/
    base.ts                  shared Express setup (helmet, parsers, views, sessions)
    errors.ts                shared 404/error handlers
    pms.ts                   PMS console + feed
    api.ts                   admin, integration, read API, metrics
    dashboard.ts             display renderer + proxies
  pms/
    schema.ts                pms schema helper + migration
    store.ts                 pms queries and status transitions
  routes/
    provider.ts              /api/v1 read API (API key)
    integration.ts           /api/integration write API (API key)
    api.ts                   /api/dashboard, /api/display-config, /api/qr, /api/health
    auth.ts, admin.ts        admin panel
    dashboard.ts             legacy display route
  services/
    provider.ts              read queries for the API
    apiClient.ts             dashboard → API client
    pms.ts                   scheduled pull + field mapping
    patients.ts, wards.ts    upserts and status timestamps
    summary.ts, settings.ts  metrics and settings
    publicConfig.ts          public settings subset
    apiKeys.ts               key generation + hashing
  middleware/
    auth.ts                  sessions, roles, CSRF, flash
    apiKey.ts                X-API-Key / Bearer authentication
  views/
    dashboard.ejs            the screen
    dashboard-offline.ejs    reconnecting screen
    admin/                   admin panel pages
    pms/                     PMS console
public/
  css/, js/, img/            styles, polling script, logos
deploy/
  nginx.conf.example         legacy single-process proxy
  nginx.split.conf.example   three-server proxy
```
