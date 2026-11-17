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

## Step-by-Step Deployment to Cloudflare Pages + D1 (via GitHub)

### Step 1: Create the Cloudflare D1 Database
Install or run Wrangler and log in:
```bash
npx wrangler login
npx wrangler d1 create fleet-secure
```
Copy the `database_id` printed in the terminal output.

### Step 2: Update `wrangler.toml`
Open `wrangler.toml` and replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` with your real `database_id`:
```toml
[[d1_databases]]
binding = "DB"
database_name = "fleet-secure"
database_id = "YOUR-REAL-D1-DATABASE-ID"
migrations_dir = "migrations"
```

### Step 3: Run Database Migrations
Apply the initial tables to your remote D1 database:
```bash
npx wrangler d1 migrations apply fleet-secure --remote
```

### Step 4: Connect GitHub to Cloudflare Pages
1. Push this repository to GitHub.
2. In the **Cloudflare Dashboard**, go to **Workers & Pages -> Create -> Pages -> Connect to Git**.
3. Select your repository and configure the build:
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
4. Click **Save and Deploy**.

### Step 5: Bind D1 (`DB`) in Cloudflare Pages
1. In your Pages project, open **Settings -> Functions -> D1 database bindings**.
2. Add binding:
   - **Variable name:** `DB`
   - **D1 database:** `fleet-secure`
3. Save.

### Step 6: Set Production Secrets
In **Settings -> Environment variables** (Production), add **Encrypted / Secret** variables:
- `SESSION_SECRET`: A long random string (at least 32 characters).
- `INITIAL_ADMIN_PIN`: Your starting Admin PIN/password (you will be forced to change it on first login).
- `INITIAL_ADMIN_USERNAME` *(optional, defaults to `admin`)*.
- `RESEND_API_KEY` *(optional, for email alerts)* and `EMAIL_FROM` *(e.g. `alerts@yourdomain.com`)*.

Redeploy once after adding bindings and secrets so Pages Functions pick them up.

### Step 7: Optional Hourly Overdue-Hire Cron Worker
If you want overdue-hire alerts checked every hour even when nobody has the app open:
1. Put your real `database_id` into `wrangler.cron.toml`.
2. Deploy the lightweight cron worker:
   ```bash
   npx wrangler deploy -c wrangler.cron.toml
   ```

---

## Default Fuel & Overdue Rules (Configurable in Settings)
- **Economy** (Sedan, Hatchback, Mini SUV): `60 L` tank, `10 km/L`
- **Heavy** (Double Cab, SUV, Truck, Executive Sedan, Kombi, Quantum, Bus): `80 L` tank, `8 km/L`
- **Fuel Mismatch Threshold:** `25%` of tank size
- **Overdue Hire Limit:** `24 hours`
