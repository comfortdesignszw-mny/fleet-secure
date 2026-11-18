# Fleet Secure

**Auditable Fleet & Yard Record Book** for car rental companies.  
Replaces paper vehicle record books with immutable OUT/IN trip logs, automatic mileage-gap and fuel-mismatch detection, a tamper-evident SHA-256 audit chain, offline submission queuing, and one-click CSV/PDF reports.

---

## Key Features

- **Immutable Trip Records:** Once an OUT or IN entry is saved, no one (not even Admin) can edit or delete it. Mistakes are fixed only by Supervisor/Admin **Correction Entries** that preserve the original record.
- **Tamper-Evident Audit Log:** Every login, directory update, trip entry, correction, setting change, and report export is chained with SHA-256 (`prev_hash` + `hash`). Supervisors can run **Verify Audit Trail** anytime.
- **Automatic Loss-Control Flags:**
  - `UNRECORDED_GAP`: Leaving odometer differs from last recorded odometer.
  - `FUEL_MISMATCH`: Distance-estimated fuel differs from gauge drop beyond configured % of tank size.
  - `OVERDUE`: Open client hire exceeds configured hours limit.
  - `OFFLINE_DELAY`: Offline entry synced more than 10 minutes after capture (`device_time` vs `received_at`).
  - `LICENCE_EXPIRING`: Driver licence expired or expiring within 30 days (Harare time).
- **Installable PWA & Offline Queue:** Works on Android phones and slow yard connections. Entries saved offline wait in **Waiting to send** and upload automatically when online.
- **Timezone:** Stored in UTC, grouped and displayed in `Africa/Harare` (CAT).

---

## Local Development (Quick Start)

1. **Install dependencies:**
   ```bash
   npm install
   ```
2. **Create `.env` from `.env.example` (optional for local dev):**
   ```bash
   cp .env.example .env
   ```
   Defaults if omitted: `username = admin`, `pin = 1234` (forced PIN change on first sign-in).
3. **Start the local server (Express + Vite + local SQLite matching D1):**
   ```bash
   npm run dev
   ```
   Open `http://localhost:3000`.
4. **(Optional) Seed 10 demo vehicles and 8 demo drivers:**
   ```bash
   npx tsx scripts/seed-demo.ts
   ```
5. **Run all automated tests:**
   ```bash
   npm test
   ```

---

## Step-by-Step Deployment to Cloudflare Workers + D1 (via GitHub)

### Step 1: Connect GitHub to Cloudflare Workers
1. Push this repository to GitHub.
2. In the **Cloudflare Dashboard**, go to **Workers & Pages -> Create -> Workers -> Connect to Git**.
3. Select your repository and configure:
   - **Build command:** `bun run build` (or `npm run build`)
   - **Deploy command:** `npx wrangler deploy`
4. `wrangler.toml` is already configured with `main = "src/index.ts"`, `[assets]` serving `dist/`, hourly cron triggers, and the `DB` D1 binding.

### Step 2: Configure D1 Database (Optional Manual Pinning)
With Wrangler v4, omitting `database_id` in `wrangler.toml` allows automatic D1 provisioning during `npx wrangler deploy`, and the Worker automatically bootstraps tables on first request.
If you prefer to create and pin your D1 database manually:
```bash
npx wrangler login
npx wrangler d1 create fleet-secure
npx wrangler d1 migrations apply fleet-secure --remote
```
Then uncomment `database_id = "..."` in `wrangler.toml` and paste your real UUID.

### Step 3: Set Production Secrets
In **Workers & Pages -> Settings -> Variables and Secrets** (or via `npx wrangler secret put`), add:
- `SESSION_SECRET`: A long random string (at least 32 characters).
- `INITIAL_ADMIN_PIN`: Your starting Admin PIN/password (you will be forced to change it on first login).
- `INITIAL_ADMIN_USERNAME` *(optional, defaults to `admin`)*.
- `RESEND_API_KEY` *(optional, for email alerts)* and `EMAIL_FROM` *(e.g. `alerts@yourdomain.com`)*.

Redeploy once after adding secrets so the Worker picks them up.

---

## Default Fuel & Overdue Rules (Configurable in Settings)
- **Economy** (Sedan, Hatchback, Mini SUV): `60 L` tank, `10 km/L`
- **Heavy** (Double Cab, SUV, Truck, Executive Sedan, Kombi, Quantum, Bus): `80 L` tank, `8 km/L`
- **Fuel Mismatch Threshold:** `25%` of tank size
- **Overdue Hire Limit:** `24 hours`
