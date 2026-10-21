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
  â””â”€â”€ /       (live display)        â”œâ”€â”€ zones, settings, users, session
```

## Features

- Live dashboard matching the hospital display layout, built to fit 16:9 screens.
- Auto-refresh (configurable 5â€“300 s), hospital-time clock, last-updated time and an
  offline/reconnecting indicator.
- QR code generated server-side from a configurable URL.
- Admin panel: patients, ward admissions, triage zones, display settings, admin users
  and system health.
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
| Zones           | Rename zones, set English name/colour/order, activate, add or delete. |
| Display settings| Hospital name/subtitle/logo, footer text, QR link/caption, timezone, refresh interval, waiting buffers. |
| Users           | Create admin/viewer accounts, reset passwords, change your own password. |
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
  routes/                  dashboard, api, auth, admin
  services/summary.ts      all live metric queries
  services/settings.ts     display settings
  utils/                   datetime (timezone) and helpers
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
| Need a clean demo | `npm run db:seed:force`. |

