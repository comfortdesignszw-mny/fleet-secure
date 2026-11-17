import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server/app';
import { LocalD1Adapter } from '../src/server/local-d1';
import { buildReportPdf } from '../src/server/pdf';
import { resetSeedCacheForTests } from '../src/server/seed';
import type { AppEnv } from '../src/server/types';
import type { ReportPreviewData, TripSummary } from '../src/shared/types';

function createTestEnv(): { db: LocalD1Adapter; env: AppEnv } {
  resetSeedCacheForTests();
  const schemaSql = fs.readFileSync(path.resolve(process.cwd(), 'schema.sql'), 'utf-8');
  const db = new LocalD1Adapter(':memory:', schemaSql);
  const env: AppEnv = {
    DB: db,
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    INITIAL_ADMIN_USERNAME: 'admin',
    INITIAL_ADMIN_PIN: '1234',
    INITIAL_ADMIN_NAME: 'Test Admin',
  };
  return { db, env };
}

async function loginAndChangePin(
  app: ReturnType<typeof createApp>,
  env: AppEnv,
  username: string,
  pin: string,
  newPin: string
): Promise<string> {
  const loginRes = await app.fetch(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, pin }),
    }),
    env
  );
  assert.equal(loginRes.status, 200);
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];

  await app.fetch(
    new Request('http://localhost/api/auth/change-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ currentPin: pin, newPin }),
    }),
    env
  );
  return cookie;
}

test('Reports API RBAC, all report types, CSV/PDF/JSON/MD exports, company header, and audit logging', async () => {
  const { db, env } = createTestEnv();
  const app = createApp();

  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '9999');

  // Update company details in Settings
  await app.fetch(
    new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        company_name: 'Zambezi Fleet Holdings',
        contact_numbers: '+263 242 555 888',
        company_address: '42 Samora Machel Ave, Harare',
      }),
    }),
    env
  );

  // Create Driver & Supervisor
  await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ username: 'drv_r', full_name: 'Yard Driver', role: 'DRIVER', pin: '1111' }),
    }),
    env
  );
  await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ username: 'sup_r', full_name: 'Loss Supervisor', role: 'SUPERVISOR', pin: '2222' }),
    }),
    env
  );
  const drvCookie = await loginAndChangePin(app, env, 'drv_r', '1111', '1166');
  const supCookie = await loginAndChangePin(app, env, 'sup_r', '2222', '2266');

  // Driver cannot preview or export reports
  const drvPreview = await app.fetch(
    new Request('http://localhost/api/reports/preview?type=all_trips', {
      headers: { Cookie: drvCookie },
    }),
    env
  );
  assert.equal(drvPreview.status, 403);

  const drvExport = await app.fetch(
    new Request('http://localhost/api/reports/export?type=all_trips&format=csv', {
      headers: { Cookie: drvCookie },
    }),
    env
  );
  assert.equal(drvExport.status, 403);

  // Seed vehicle, driver, one flagged Hire and one Errand
  const vRes = await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: supCookie },
      body: JSON.stringify({
        reg_number: 'AFX 9001',
        vehicle_type: 'Double Cab',
        make_model: 'Ford Ranger',
        condition: 'Good',
        last_known_mileage: 25000,
      }),
    }),
    env
  );
  const v = ((await vRes.json()) as { vehicle: { id: number } }).vehicle;

  const dRes = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: supCookie },
      body: JSON.stringify({
        full_name: 'Nyasha Dube',
        licence_number: 'ZW-8844',
        phone: '+263771884400',
        address: 'Bulawayo',
        licence_expiry: '2029-12-31',
      }),
    }),
    env
  );
  const d = ((await dRes.json()) as { driver: { id: number } }).driver;

  // Trip 1: Hire with mileage gap flag
  const hOutRes = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: drvCookie },
      body: JSON.stringify({
        trip_type: 'HIRE',
        vehicle_id: v.id,
        driver_id: d.id,
        client_name: 'Kwekwe Mines, Ltd',
        mileage_out: 25020,
        fuel_out: 'Full',
        opening_checklist_by: 'Yard Driver',
      }),
    }),
    env
  );
  const hTrip = ((await hOutRes.json()) as { trip: TripSummary }).trip;

  await app.fetch(
    new Request(`http://localhost/api/trips/${hTrip.id}/in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: drvCookie },
      body: JSON.stringify({
        mileage_in: 25180,
        fuel_in: '3/4',
        closing_checklist_by: 'Yard Driver',
      }),
    }),
    env
  );

  // Trip 2: Clean Errand
  await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: drvCookie },
      body: JSON.stringify({
        trip_type: 'ERRAND',
        vehicle_id: v.id,
        driver_id: d.id,
        destination: 'Airport',
        reason: 'Spare parts pickup',
        mileage_out: 25180,
        fuel_out: '3/4',
        opening_checklist_by: 'Yard Driver',
      }),
    }),
    env
  );

  // Check all 7 report types preview
  const types = [
    'all_trips',
    'hires',
    'errands',
    'vehicles',
    'drivers',
    'flagged_trips',
    'audit_log',
  ] as const;

  for (const t of types) {
    const res = await app.fetch(
      new Request(`http://localhost/api/reports/preview?type=${t}`, {
        headers: { Cookie: supCookie },
      }),
      env
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as ReportPreviewData;
    assert.equal(body.company.name, 'Zambezi Fleet Holdings');
    assert.ok(body.total_rows >= 1);
  }

  // Verify CSV export escapes commas properly
  const csvRes = await app.fetch(
    new Request('http://localhost/api/reports/export?type=hires&format=csv', {
      headers: { Cookie: supCookie },
    }),
    env
  );
  assert.equal(csvRes.status, 200);
  assert.ok((csvRes.headers.get('content-type') || '').includes('text/csv'));
  const csvBytes = new Uint8Array(await csvRes.arrayBuffer());
  assert.deepEqual(Array.from(csvBytes.slice(0, 3)), [0xef, 0xbb, 0xbf]);
  const csvText = new TextDecoder('utf-8').decode(csvBytes);
  assert.ok(csvText.includes('"Kwekwe Mines, Ltd"'));

  // Verify JSON export
  const jsonRes = await app.fetch(
    new Request('http://localhost/api/reports/export?type=flagged_trips&format=json', {
      headers: { Cookie: supCookie },
    }),
    env
  );
  assert.equal(jsonRes.status, 200);
  const jsonBody = (await jsonRes.json()) as ReportPreviewData;
  assert.equal(jsonBody.total_rows, 1);
  assert.equal(jsonBody.company.address, '42 Samora Machel Ave, Harare');

  // Verify Markdown export
  const mdRes = await app.fetch(
    new Request('http://localhost/api/reports/export?type=errands&format=md', {
      headers: { Cookie: supCookie },
    }),
    env
  );
  assert.equal(mdRes.status, 200);
  const mdText = await mdRes.text();
  assert.ok(mdText.includes('# Zambezi Fleet Holdings — Staff Errands Report'));
  assert.ok(mdText.includes('Airport (Spare parts pickup)'));

  // Verify PDF export header, trailer, and company details
  const pdfRes = await app.fetch(
    new Request('http://localhost/api/reports/export?type=all_trips&format=pdf', {
      headers: { Cookie: supCookie },
    }),
    env
  );
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
  const pdfBytes = new Uint8Array(await pdfRes.arrayBuffer());
  const pdfText = new TextDecoder('latin1').decode(pdfBytes);
  assert.ok(pdfText.startsWith('%PDF-1.4'));
  assert.ok(pdfText.includes('%%EOF'));
  assert.ok(pdfText.includes('Zambezi Fleet Holdings'));
  assert.ok(pdfText.includes('42 Samora Machel Ave, Harare'));

  // Date range outside trips returns 0 rows
  const emptyRangeRes = await app.fetch(
    new Request('http://localhost/api/reports/preview?type=all_trips&from=2020-01-01&to=2020-01-31', {
      headers: { Cookie: supCookie },
    }),
    env
  );
  const emptyRange = (await emptyRangeRes.json()) as ReportPreviewData;
  assert.equal(emptyRange.total_rows, 0);

  // Confirm REPORT_EXPORTED was recorded in audit_log
  const exportAudit = await db
    .prepare("SELECT COUNT(*) as cnt FROM audit_log WHERE action = 'REPORT_EXPORTED'")
    .first<{ cnt: number }>();
  assert.equal(exportAudit?.cnt, 4);
});

test('PDF generator handles multi-page tables cleanly', () => {
  const rows = Array.from({ length: 35 }, (_, idx) => ({
    col1: `VEH-${idx + 1}`,
    col2: `Driver ${idx + 1}`,
  }));
  const pdf = buildReportPdf({
    companyName: 'Test Fleet',
    companyContact: '+263 242 000 000',
    companyAddress: 'Harare',
    reportTitle: 'Multi-page Test',
    generatedAt: '2026-11-17 12:00:00',
    dateRangeLabel: 'All Dates',
    summaryItems: [{ label: 'Rows', value: '35' }],
    columns: [
      { key: 'col1', label: 'Vehicle', width: 50 },
      { key: 'col2', label: 'Driver', width: 50 },
    ],
    rows,
  });
  const text = new TextDecoder('latin1').decode(pdf);
  assert.ok(text.includes('Page 1 of 2'));
  assert.ok(text.includes('Page 2 of 2'));
});
