# EDDASH â€” Emergency Department Live Dashboard

Fullscreen waiting-room display plus an admin panel for an emergency department,
built with **Node.js + TypeScript**, **Express**, **PostgreSQL** and **EJS**.

The display shows the current estimated waiting time, arrivals since midnight,
ward admission wait, triage zone counts, a QR information card and a live clock.
It polls the API every few seconds and reconnects automatically.

```
Browser (TV / kiosk / tablet)
        â”‚  GET /                 server-rendered dashboard
        â”‚  GET /api/dashboard    live metrics (polled)
        â–¼
Node.js + Express â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ PostgreSQL
  â”œâ”€â”€ /admin  (login, CRUD)         â”œâ”€â”€ patients
  â”œâ”€â”€ /api    (dashboard, QR, health)â”œâ”€â”€ ward_admissions
  â”œâ”€â”€ /api/integration (PMS push)   â”œâ”€â”€ zones, settings, users, session
  â””â”€â”€ /       (live display)        â””â”€â”€ api_keys
```

## Features

- Live dashboard matching the hospital display layout, built to fit 16:9 screens.
- Auto-refresh (configurable 5â€“300 s), hospital-time clock, last-updated time and an
  offline/reconnecting indicator.
- QR code generated server-side from a configurable URL.
- Admin panel: patients, ward admissions, triage zones, display settings, admin users
  and system health.
- Integration API for any patient management system, with per-system API keys and
  single or batch upserts.
- Optional pull mode: poll a PMS REST API on a schedule, with field/status/zone
  mapping for systems that cannot push.
- Two roles: `admin` (full access) and `viewer` (read-only).
- Security: bcrypt password hashing, PostgreSQL-backed sessions, CSRF tokens,
  login rate limiting, Helmet CSP, parameterised SQL and HTTP-only cookies.
- Docker + Docker Compose with PostgreSQL, automatic schema migration on boot,
  health checks and persistent volumes.
- Demo seed data (1 day of realistic queue data) for development.

## Requirements

| Tool       | Version                       |
| ---------- | ----------------------------- |
| Node.js    | 20+ (tested on 24)            |
| PostgreSQL | 14+ (tested on 16)            |
| Docker     | 24+ and Compose v2 (for prod) |

## Local development

### 1. Create the database

```bash
sudo -u postgres psql -c "CREATE ROLE eddash LOGIN PASSWORD 'eddash';"
sudo -u postgres createdb -O eddash eddash
```

On Windows, run the same commands with
`"C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres` instead of `sudo -u postgres psql`.

### 2. Configure and run

```bash
cp .env.example .env
npm install
npm run db:migrate
npm run db:seed          # optional demo patients
npm run dev
```

| URL                            | Purpose                 |
| ------------------------------ | ----------------------- |
| http://localhost:3000          | Live display            |
| http://localhost:3000/admin    | Admin panel             |
| http://localhost:3000/api/dashboard | Live metrics JSON  |
| http://localhost:3000/api/health    | Health check       |
| http://localhost:3000/admin/api-keys | Integration API keys |
| http://localhost:3000/admin/integration | Pull from PMS API |

The first admin account is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD` when the
`users` table is empty. With the example values that is **admin / admin123** â€” change it
immediately in **Admin â†’ Users â†’ Change my password**.

`SEED_DEMO=true` also seeds demo patients automatically on boot when the `patients`
table is empty. Run `npm run db:seed:force` to reset demo patients and wards.

### Scripts

| Script              | Description                                            |
| ------------------- | ------------------------------------------------------ |
| `npm run dev`       | Watch mode with `tsx`                                  |
| `npm run build`     | Compile TypeScript to `dist/`                          |
| `npm start`         | Run the compiled server (`dist/src/server.js`)         |
| `npm run typecheck` | Type-check without emitting files                      |
| `npm run db:migrate`| Apply `db/schema.sql` (idempotent)                     |
| `npm run db:seed`   | Insert demo patients/wards when empty                 |
| `npm run db:seed:force` | Reset and regenerate demo patients/wards          |
| `npm run db:reset`  | Delete all patients and ward admissions                |

The server expects to be started from the project root (it reads `db/schema.sql`,
`src/views` and `public` relative to the working directory).

## How the metrics are calculated

All logic lives in `src/services/summary.ts`:

| Display metric | Rule |
| -------------- | ---- |
| Current estimated waiting time | Average minutes since `arrived_at` for patients with status `waiting`, plus `waiting_buffer_minutes`. When nobody is waiting, `waiting_fallback_minutes` is shown. |
| Total since 00:00 | Patients with `arrived_at` after local midnight in the configured timezone. |
| Waiting for ward | Average minutes since `requested_at` for `ward_admissions` with status `waiting`, plus the number of such patients. |
| Zone counts | Patients in `waiting`, `in_treatment` or `waiting_ward`, grouped by active zone. |
| Last updated | Server generation time, rendered in the hospital timezone. |

Patient statuses: `waiting` â†’ `in_treatment` â†’ `waiting_ward` â†’ `discharged`
(or `cancelled`). The admin panel sets `called_at` / `discharged_at` timestamps
automatically when a status changes and cancels pending ward requests when a patient
is discharged or cancelled.

## Integration API

Any patient management system (PMS) can feed the dashboard over HTTP. Go to
**Admin â†’ API keys**, create a key for that system and copy it immediately â€” only a
hash and the first characters are stored, so the full key is shown once.

Send the key in either header:

```http
X-API-Key: edd_...
Authorization: Bearer edd_...
```

Records are matched by `external_id`, so retries and repeated syncs update the same row
instead of creating duplicates.

| Method | Endpoint | Purpose |
| ------ | -------- | ------- |
| `GET` | `/api/integration/ping` | Verify the key. |
| `POST` | `/api/integration/patients` | Create or update one patient. |
| `POST` | `/api/integration/wards` | Create or update one ward admission. |
| `POST` | `/api/integration/sync` | Batch upsert `patients` and `wards` in one transaction. |
| `GET` | `/api/dashboard` | Public live metrics (same JSON used by the display). |

Responses use `201` for a new record and `200` for an update. Validation errors return
`400`, a missing/invalid key returns `401`, and every response is JSON:

```json
{ "ok": true, "created": true, "patient": { "id": "132", "external_id": "PMS-1001", "...": "..." } }
{ "ok": false, "error": "Unknown or inactive zone \"purple\"." }
```

### Patient fields

`external_id` is required. On update, omitted fields keep their current value.

| Field | Type | Notes |
| ----- | ---- | ----- |
| `external_id` | string | PMS identifier, max 120 characters. |
| `medical_no` | string | Max 60 characters. |
| `name` | string | Max 120 characters. |
| `zone_code` | string | Required on create. Must be an active zone, e.g. `green`, `yellow`, `red`. |
| `status` | string | `waiting`, `in_treatment`, `waiting_ward`, `discharged` or `cancelled`. Defaults to `waiting`. |
| `arrived_at` | timestamp | Defaults to now on create. Drives the waiting time. |
| `triaged_at` | timestamp | Optional. |
| `called_at` | timestamp | Set automatically when the status advances if omitted. |
| `discharged_at` | timestamp | Set automatically when status becomes `discharged` if omitted. |
| `notes` | string | Max 500 characters. |

```bash
curl -X POST http://localhost:3000/api/integration/patients \
  -H "Content-Type: application/json" \
  -H "X-API-Key: edd_xxx" \
  -d '{
    "external_id": "PMS-1001",
    "medical_no": "A123456",
    "name": "Ahmad bin Ali",
    "zone_code": "green",
    "status": "waiting",
    "arrived_at": "2026-10-21T22:10:00+08:00"
  }'
```

### Ward fields

`external_id` is the admission identifier in your PMS and is required. Use
`patient_external_id` to link the admission to a patient already synced through the
patient endpoint.

| Field | Type | Notes |
| ----- | ---- | ----- |
| `external_id` | string | Ward admission identifier, max 120 characters. |
| `patient_external_id` | string | External ID of an existing patient. |
| `patient_name` | string | Used when no patient is linked. |
| `ward` | string | Ward name, max 80 characters. |
| `status` | string | `waiting`, `admitted` or `cancelled`. Defaults to `waiting`. |
| `requested_at` | timestamp | Defaults to now. Drives the ward wait time. |
| `admitted_at` | timestamp | Set automatically when status becomes `admitted` if omitted. |

A `waiting` ward admission moves a `waiting` / `in_treatment` patient to
`waiting_ward`. Discharging or cancelling the patient cancels any pending ward request.

### Batch sync

Send up to 1000 records per request. The batch is applied in one transaction: if any
record is invalid, nothing is written.

```bash
curl -X POST http://localhost:3000/api/integration/sync \
  -H "Content-Type: application/json" \
  -H "X-API-Key: edd_xxx" \
  -d '{
    "patients": [
      { "external_id": "PMS-1001", "name": "Ahmad bin Ali", "zone_code": "green", "status": "waiting", "arrived_at": "2026-10-21T22:10:00+08:00" },
      { "external_id": "PMS-1002", "name": "Siti binti Omar", "zone_code": "yellow", "status": "in_treatment", "arrived_at": "2026-10-21T22:15:00+08:00" }
    ],
    "wards": [
      { "external_id": "WARD-9001", "patient_external_id": "PMS-1001", "ward": "Wad 1", "status": "waiting", "requested_at": "2026-10-21T22:20:00+08:00" }
    ]
  }'
```

```json
{ "ok": true, "patients": { "created": 2, "updated": 0 }, "wards": { "created": 1, "updated": 0 } }
```

Timestamps should be ISO 8601. Values with an explicit offset (`+08:00`, `Z`) are used
as-is; values without one (`2026-10-21T22:10:00`) are interpreted in the hospital
timezone configured in **Admin â†’ Display settings**.

Revoke a key in **Admin â†’ API keys** as soon as a PMS stops using it or if it leaks.
Revocation takes effect immediately.

## Pulling data from a PMS API

If your patient management system cannot push, EDDASH can poll it instead. Open
**Admin â†’ PMS integration**, enter the PMS base URL and endpoint paths, then enable
scheduled pull. Use one direction only (push *or* pull) for the same records.

| Setting | Meaning |
| ------- | ------- |
| Base URL | e.g. `https://pms.hospital.local/api`. `http://` and `https://` only. |
| Patients path | Defaults to `/patients`. |
| Wards path | Defaults to `/wards`. Leave blank to skip ward admissions. |
| Sync interval | 10â€“3600 seconds; default 30. |
| API key | Sent as `Authorization: Bearer <key>`. `PMS_API_KEY` in the environment overrides it. |
| Extra headers | Optional JSON object; use `{{apiKey}}` as a placeholder. |

The scheduler runs in the Node process, updates the dashboard immediately and records
the last attempt/result on the page. **Sync now** runs outside the schedule using the
saved settings. Each pull is applied in one transaction: if a record is invalid,
nothing from that pull is written.

The patients endpoint can return an array, or an object containing a `patients`,
`data`, `items` or `results` array (including nested `data.patients`). The wards
endpoint accepts `wards`, `admissions` or the same generic keys.

```json
[
  {
    "external_id": "PMS-1001",
    "medical_no": "A123456",
    "name": "Ahmad bin Ali",
    "zone_code": "green",
    "status": "waiting",
    "arrived_at": "2026-10-21T22:10:00+08:00"
  }
]
```

If your PMS uses different field names, supply a **patient field map** and/or **ward
field map** in the admin page. Paths support nested fields and array indexes:

```json
{
  "external_id": "patientId",
  "name": "fullName",
  "medical_no": "mrn",
  "zone_code": "triageLevel",
  "status": "queueStatus",
  "arrived_at": "registrationTime"
}
```

```json
{
  "external_id": "admissionId",
  "patient_external_id": "patientId",
  "ward": "wardName",
  "status": "status",
  "requested_at": "requestedTime"
}
```

Use the **status map** and **zone map** to translate local values:

```json
{ "AWAITING": "waiting", "IN_TREATMENT": "in_treatment", "DISCHARGED": "discharged" }
```

```json
{ "1": "red", "2": "yellow", "3": "green" }
```

Mapped values are matched case-insensitively. The `external_id` field is mandatory,
the zone must be active, and ward records that reference `patient_external_id` require
that patient to be present in the same or an earlier pull. Timestamps may be ISO 8601
or epoch milliseconds; epoch seconds are detected automatically. Timestamps without
an offset use the hospital timezone from **Admin â†’ Display settings**.

## Wiring your live database

The dashboard currently reads from its own PostgreSQL tables. There are two clean ways
to connect your existing hospital/queue system without rewriting the UI:

### Option A â€” mirror into the dashboard tables (recommended)

Keep the display isolated from the production system. A small worker (cron, systemd
timer or a separate Node process) reads your source database and upserts into
`patients` / `ward_admissions` using `external_id`, then marks discharged rows.

```sql
INSERT INTO patients (external_id, medical_no, name, zone_code, status, arrived_at)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (external_id) WHERE external_id IS NOT NULL
DO UPDATE SET
  medical_no = EXCLUDED.medical_no,
  name       = EXCLUDED.name,
  zone_code  = EXCLUDED.zone_code,
  status     = EXCLUDED.status,
  arrived_at = EXCLUDED.arrived_at,
  updated_at = now();
```

Map your triage levels to the existing zone codes (`green`, `yellow`, `red`, or add
your own in **Admin â†’ Zones**). Recommended sync frequency: 10â€“30 seconds.

### Option B â€” query your source tables directly

Use a **read-only** database role and change the SQL in
`src/services/summary.ts` to your existing tables or SQL views. Keep the
`getDashboardData()` return shape unchanged â€” the dashboard and admin keep working:

```json
{
  "meta": { "timezone": "Asia/Kuala_Lumpur", "refreshSeconds": 10, "generatedAt": "..." },
  "waitingTimeMinutes": 65,
  "waitingPatients": 68,
  "totalSinceMidnight": 131,
  "wardWaitingMinutes": 142,
  "wardWaitingPatients": 6,
  "zones": [
    { "code": "green", "name": "Zon Hijau", "name_en": "Green Zone", "color": "#5FE3B0", "count": 61 },
    { "code": "yellow", "name": "Zon Kuning", "name_en": "Yellow Zone", "color": "#FDE68A", "count": 30 },
    { "code": "red", "name": "Zon Merah", "name_en": "Red Zone", "color": "#FCA5A5", "count": 8 }
  ]
}
```

For either option, write at least a name or medical number, and always set `zone_code`
and `arrived_at` â€” they drive the headline numbers.

## Admin panel

| Page            | What you can do |
| --------------- | --------------- |
| Overview        | Live snapshot, recent arrivals, queue totals, DB latency. |
| Patients        | Search/filter, add, edit, quick status change, delete. |
| Ward admissions | Request a ward bed, admit/cancel/delete, see waiting minutes. |
| PMS integration | Configure scheduled pull from a PMS API, field/status/zone maps, manual sync. |
| Zones           | Rename zones, set English name/colour/order, activate, add or delete. |
| Display settings| Hospital name/subtitle/logo, footer text, QR link/caption, timezone, refresh interval, waiting buffers. |
| Users           | Create admin/viewer accounts, reset passwords, change your own password. |
| API keys        | Create/revoke integration keys and view endpoint examples. |
| Health          | DB status/version/latency, record counts, uptime, memory. |

Viewers can open every page but all write actions require the `admin` role.

## Deploy on Ubuntu with Docker

### 1. Install Docker

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"   # log out and back in
```

If `docker compose` is unavailable, install the official Compose plugin from Docker's
documentation.

### 2. Configure

```bash
sudo mkdir -p /opt/eddash && sudo chown "$USER" /opt/eddash
git clone <your-repo-url> /opt/eddash
cd /opt/eddash
cp .env.docker.example .env
nano .env
```

Set at minimum:

- `POSTGRES_PASSWORD` â€” strong database password.
- `SESSION_SECRET` â€” `openssl rand -hex 32`.
- `ADMIN_PASSWORD` â€” strong first admin password.
- `TRUST_PROXY=true` if you terminate TLS with nginx.
- `SEED_DEMO=false` for production.
- `PMS_API_KEY` â€” optional outbound key if you pull data from a PMS API.

### 3. Start

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f app
```

The app applies the schema automatically on every start. Open
`http://SERVER_IP:3000` for the display and `/admin` to sign in.

### 4. Reverse proxy + HTTPS (recommended)

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/eddash
sudo ln -s /etc/nginx/sites-available/eddash /etc/nginx/sites-enabled/eddash
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d dash.example.com
```

Edit the `server_name` first. Set `TRUST_PROXY=true` in `.env`, then
`docker compose up -d` so secure session cookies are enabled behind TLS.

Open only ports 22/80/443 in the firewall. Do not publish PostgreSQL.

### 5. Updating

```bash
cd /opt/eddash
git pull
docker compose up -d --build
docker image prune -f
```

Schema changes are applied on boot; existing patient/settings data is kept.

## Backup and restore

```bash
# backup
docker compose exec -T db pg_dump -U eddash eddash | gzip > "backup-$(date +%F).sql.gz"

# restore (stop the app first to avoid writes)
docker compose stop app
gunzip -c backup-2026-10-21.sql.gz | docker compose exec -T db psql -U eddash -d eddash
docker compose start app
```

Schedule the backup with cron and copy the archives off the host.

## Security checklist

- Change the seeded admin password and never keep `admin123` in production.
- Use a random `SESSION_SECRET`; rotating it signs everyone out.
- Keep `SEED_DEMO=false` for real deployments.
- Keep PostgreSQL on the private Docker network (no published port).
- Serve over HTTPS and set `TRUST_PROXY=true`.
- Create a separate `viewer` account for staff who only need to look at data.
- Give each PMS its own integration key and revoke keys that are no longer used.
- Prefer `PMS_API_KEY` in the environment over storing the outbound key in the database.
- Use HTTPS for the PMS base URL where possible; the pull worker can reach internal hosts.
- Back up the database and test restores.

## Project structure

```
db/
  schema.sql               tables, indexes, default zones/settings (idempotent)
  migrate.ts               apply schema
  seed.ts                  demo data
  reset.ts                 clear patients/wards
src/
  app.ts                   Express app, security middleware, sessions
  server.ts                bootstrap + graceful shutdown
  bootstrap.ts             migrate, first admin, optional demo seed
  config.ts                environment configuration
  db.ts                    pg pool + health
  seed.ts                  demo data generator
  middleware/auth.ts       sessions, roles, CSRF, flash
  middleware/apiKey.ts     X-API-Key authentication for integrations
  routes/                  dashboard, api, integration, auth, admin
  services/summary.ts      all live metric queries
  services/settings.ts     display settings
  services/patients.ts     patient upserts + status timestamps
  services/wards.ts        ward admission upserts
  services/pms.ts          scheduled pull from a PMS API
  services/apiKeys.ts      key generation + hashing
  utils/                   datetime (timezone), errors and helpers
  views/                   EJS dashboard + admin pages
public/
  css/, js/, img/          styles, polling scripts, logo
deploy/nginx.conf.example  reverse proxy sample
Dockerfile, docker-compose.yml, .env.example, .env.docker.example
```

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `ECONNREFUSED` / `password authentication failed` | Check `DATABASE_URL` (local) or `POSTGRES_*` (Docker) and that the DB container is healthy: `docker compose ps`. |
| `ENOENT ... db/schema.sql` or views not found | Start from the project root (`npm start` / `npm run dev`), not from `src/`. |
| Login succeeds but immediately redirects to login | Behind HTTPS without `TRUST_PROXY=true`, or the session cookie is blocked by the browser. Enable the proxy setting and rebuild. |
| Dashboard time or "since 00:00" is off | Set the IANA timezone in **Admin â†’ Display settings**; check the container's `TZ`. |
| QR code does not change | The browser caches `/api/qr` for 60 s; wait a minute or hard-refresh. |
| Integration API returns `401` | Check the `X-API-Key` value and that the key was not revoked in **Admin â†’ API keys**. |
| Integration batch returns `400` and writes nothing | One record is invalid; the transaction is rolled back. Check `zone_code`, `status`, timestamps and that the patient exists before a ward record. |
| PMS pull shows `fetch failed` / `HTTP 401` | Check the base URL is reachable from the server, the paths are correct and the API key is valid. Use **Sync now** to see the error immediately. |
| PMS pull does nothing | Enable scheduled pull, save the base URL and paths, and check **Last attempt** on the PMS integration page. |
| Need a clean demo | `npm run db:seed:force`. |

