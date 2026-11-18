import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server/app';
import { LocalD1Adapter } from '../src/server/local-d1';
import {
  checkAndNotifyOverdueHires,
  sendEmailNotification,
  sendWhatsApp,
} from '../src/server/notifications';
import { resetSeedCacheForTests } from '../src/server/seed';
import type { AppEnv } from '../src/server/types';
import type { NotificationRecipient, NotificationRecord, TripSummary } from '../src/shared/types';

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

test('Notifications inbox, RBAC, read states, overdue hire detection, and recipient management', async () => {
  const { db, env } = createTestEnv();
  const app = createApp();

  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '9999');

  // Create Driver and Supervisor users
  await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ username: 'drv_n', full_name: 'Yard Driver', role: 'DRIVER', pin: '1111' }),
    }),
    env
  );
  const supCreateRes = await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ username: 'sup_n', full_name: 'Loss Supervisor', role: 'SUPERVISOR', pin: '2222' }),
    }),
    env
  );
  const supUser = ((await supCreateRes.json()) as { user: { id: number } }).user;

  const drvCookie = await loginAndChangePin(app, env, 'drv_n', '1111', '1177');
  const supCookie = await loginAndChangePin(app, env, 'sup_n', '2222', '2277');

  // 1. Driver is forbidden from Notifications and Recipients
  const drvInbox = await app.fetch(
    new Request('http://localhost/api/notifications', { headers: { Cookie: drvCookie } }),
    env
  );
  assert.equal(drvInbox.status, 403);

  const drvUnread = await app.fetch(
    new Request('http://localhost/api/notifications/unread-count', { headers: { Cookie: drvCookie } }),
    env
  );
  assert.equal(drvUnread.status, 403);

  // Supervisor cannot manage notification recipients (Admin only)
  const supRec = await app.fetch(
    new Request('http://localhost/api/notification-recipients', { headers: { Cookie: supCookie } }),
    env
  );
  assert.equal(supRec.status, 403);

  // 2. Admin adds Email & WhatsApp recipients for Supervisor
  const addEmailRes = await app.fetch(
    new Request('http://localhost/api/notification-recipients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        user_id: supUser.id,
        channel: 'EMAIL',
        destination: 'loss.control@fleet.co.zw',
      }),
    }),
    env
  );
  assert.equal(addEmailRes.status, 201);
  const emailRec = ((await addEmailRes.json()) as { recipient: NotificationRecipient }).recipient;
  assert.equal(emailRec.channel, 'EMAIL');

  const addWaRes = await app.fetch(
    new Request('http://localhost/api/notification-recipients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        user_id: supUser.id,
        channel: 'WHATSAPP',
        destination: '+263772111222',
      }),
    }),
    env
  );
  assert.equal(addWaRes.status, 201);

  // Pause and delete the WhatsApp recipient
  const waRec = ((await addWaRes.json()) as { recipient: NotificationRecipient }).recipient;
  const pauseRes = await app.fetch(
    new Request(`http://localhost/api/notification-recipients/${waRec.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ active: false }),
    }),
    env
  );
  assert.equal(pauseRes.status, 200);
  assert.equal(((await pauseRes.json()) as { recipient: NotificationRecipient }).recipient.active, false);

  const delRes = await app.fetch(
    new Request(`http://localhost/api/notification-recipients/${waRec.id}`, {
      method: 'DELETE',
      headers: { Cookie: adminCookie },
    }),
    env
  );
  assert.equal(delRes.status, 200);

  // 3. Create vehicle & driver, then book a flagged Trip Out -> Supervisor gets HIGH-priority notification
  const vRes = await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: supCookie },
      body: JSON.stringify({
        reg_number: 'AFZ 7700',
        vehicle_type: 'Sedan',
        make_model: 'Toyota Corolla',
        condition: 'Good',
        last_known_mileage: 10000,
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
        full_name: 'Chipo Banda',
        licence_number: 'ZW-9911',
        phone: '+263771999111',
        address: 'Harare',
        licence_expiry: '2029-12-31',
      }),
    }),
    env
  );
  const d = ((await dRes.json()) as { driver: { id: number } }).driver;

  const outRes = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: drvCookie },
      body: JSON.stringify({
        trip_type: 'HIRE',
        vehicle_id: v.id,
        driver_id: d.id,
        client_name: 'Overdue Client',
        mileage_out: 10035, // +35km gap => HIGH priority alert
        fuel_out: 'Full',
        opening_checklist_by: 'Yard Driver',
      }),
    }),
    env
  );
  assert.equal(outRes.status, 201);
  const trip = ((await outRes.json()) as { trip: TripSummary }).trip;

  // Backdate trip_out by 30 hours -> overdue hire detection should emit one HIGH alert
  const oldIso = new Date(Date.now() - 30 * 3_600_000).toISOString();
  await db.prepare('UPDATE trip_out SET out_at = ? WHERE trip_id = ?').bind(oldIso, trip.id).run();

  const overdueFirst = await checkAndNotifyOverdueHires(db, { env });
  assert.equal(overdueFirst.newlyNotified, 1);

  // Second check must deduplicate and not spam managers again
  const overdueSecond = await checkAndNotifyOverdueHires(db, { env });
  assert.equal(overdueSecond.newlyNotified, 0);

  // Supervisor reads inbox and sees both TRIP_OUT_HIRE (HIGH) and HIRE_OVERDUE (HIGH)
  const inboxRes = await app.fetch(
    new Request('http://localhost/api/notifications?priority=HIGH', {
      headers: { Cookie: supCookie },
    }),
    env
  );
  assert.equal(inboxRes.status, 200);
  const inbox = (await inboxRes.json()) as {
    items: NotificationRecord[];
    unreadCount: number;
  };
  assert.ok(inbox.items.some((n) => n.event_type === 'HIRE_OVERDUE' && n.trip_id === trip.id));
  assert.ok(inbox.items.some((n) => n.event_type === 'TRIP_OUT_HIRE' && n.priority === 'HIGH'));
  assert.ok(inbox.unreadCount >= 2);

  // Mark one read
  const targetNotif = inbox.items[0];
  const readOneRes = await app.fetch(
    new Request(`http://localhost/api/notifications/${targetNotif.id}/read`, {
      method: 'POST',
      headers: { Cookie: supCookie },
    }),
    env
  );
  assert.equal(readOneRes.status, 200);
  const readOneBody = (await readOneRes.json()) as { notification: NotificationRecord };
  assert.ok(readOneBody.notification.read_at !== null);

  // Mark all read
  const readAllRes = await app.fetch(
    new Request('http://localhost/api/notifications/read-all', {
      method: 'POST',
      headers: { Cookie: supCookie },
    }),
    env
  );
  assert.equal(readAllRes.status, 200);

  const countAfterRes = await app.fetch(
    new Request('http://localhost/api/notifications/unread-count', {
      headers: { Cookie: supCookie },
    }),
    env
  );
  const countAfter = (await countAfterRes.json()) as { unreadCount: number; highUnreadCount: number };
  assert.equal(countAfter.unreadCount, 0);
  assert.equal(countAfter.highUnreadCount, 0);
});

test('External email graceful skip & WhatsApp stub interface', async () => {
  const emailRes = await sendEmailNotification({
    to: 'test@example.com',
    subject: 'Test',
    text: 'Body',
  });
  assert.equal(emailRes.ok, false);
  assert.equal(emailRes.skipped, true);

  const waRes = await sendWhatsApp('+263771000000', 'Test alert');
  assert.equal(waRes.ok, true);
  assert.equal(waRes.stubbed, true);
});

test('Hire days_hired, expected_return_date persistence across histories, and HIRE_RETURN_DUE notifications', async () => {
  const { db, env } = createTestEnv();
  const app = createApp();

  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '9999');

  const vRes = await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        reg_number: 'AGB 4412',
        vehicle_type: 'SUV',
        make_model: 'Toyota Fortuner',
        condition: 'Very Good',
        last_known_mileage: 22000,
      }),
    }),
    env
  );
  assert.equal(vRes.status, 201);
  const v = ((await vRes.json()) as { vehicle: { id: number } }).vehicle;

  const dRes = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        full_name: 'Rudo Chikwanda',
        licence_number: 'ZW-88412',
        phone: '+263772441122',
        address: 'Harare',
        licence_expiry: '2029-12-31',
      }),
    }),
    env
  );
  assert.equal(dRes.status, 201);
  const d = ((await dRes.json()) as { driver: { id: number } }).driver;

  const todayHarare = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Harare',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const outRes = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        trip_type: 'HIRE',
        vehicle_id: v.id,
        driver_id: d.id,
        client_name: 'Zambezi Logistics',
        days_hired: 3,
        expected_return_date: todayHarare,
        mileage_out: 22000,
        fuel_out: 'Full',
        opening_checklist_by: 'Test Admin',
      }),
    }),
    env
  );
  assert.equal(outRes.status, 201);
  const outBody = (await outRes.json()) as { trip: TripSummary };
  assert.equal(outBody.trip.days_hired, 3);
  assert.equal(outBody.trip.expected_return_date, todayHarare);
  assert.equal(outBody.trip.is_return_due, true);

  // Verify persistence in GET /trips, GET /trips/:id, GET /vehicles/:id, GET /drivers/:id, GET /dashboard
  const listRes = await app.fetch(
    new Request('http://localhost/api/trips', { headers: { Cookie: adminCookie } }),
    env
  );
  assert.equal(listRes.status, 200);
  const listBody = (await listRes.json()) as { items: TripSummary[] };
  assert.equal(listBody.items[0].days_hired, 3);
  assert.equal(listBody.items[0].expected_return_date, todayHarare);
  assert.equal(listBody.items[0].is_return_due, true);

  const detailRes = await app.fetch(
    new Request(`http://localhost/api/trips/${outBody.trip.id}`, { headers: { Cookie: adminCookie } }),
    env
  );
  assert.equal(detailRes.status, 200);
  const detailBody = (await detailRes.json()) as { trip: TripSummary };
  assert.equal(detailBody.trip.days_hired, 3);
  assert.equal(detailBody.trip.expected_return_date, todayHarare);

  const vehDetailRes = await app.fetch(
    new Request(`http://localhost/api/vehicles/${v.id}`, { headers: { Cookie: adminCookie } }),
    env
  );
  assert.equal(vehDetailRes.status, 200);
  const vehDetailBody = (await vehDetailRes.json()) as {
    trips: Array<{ days_hired: number | null; expected_return_date: string | null }>;
  };
  assert.equal(vehDetailBody.trips[0].days_hired, 3);
  assert.equal(vehDetailBody.trips[0].expected_return_date, todayHarare);

  const drvDetailRes = await app.fetch(
    new Request(`http://localhost/api/drivers/${d.id}`, { headers: { Cookie: adminCookie } }),
    env
  );
  assert.equal(drvDetailRes.status, 200);
  const drvDetailBody = (await drvDetailRes.json()) as {
    trips: Array<{ days_hired: number | null; expected_return_date: string | null }>;
  };
  assert.equal(drvDetailBody.trips[0].days_hired, 3);
  assert.equal(drvDetailBody.trips[0].expected_return_date, todayHarare);

  const dashRes = await app.fetch(
    new Request('http://localhost/api/dashboard', { headers: { Cookie: adminCookie } }),
    env
  );
  assert.equal(dashRes.status, 200);
  const dashBody = (await dashRes.json()) as { longest_vehicles_out: TripSummary[] };
  assert.equal(dashBody.longest_vehicles_out[0].days_hired, 3);
  assert.equal(dashBody.longest_vehicles_out[0].expected_return_date, todayHarare);
  assert.equal(dashBody.longest_vehicles_out[0].is_return_due, true);

  // Verify HIRE_RETURN_DUE notification created & deduplicated
  const notifRes = await app.fetch(
    new Request('http://localhost/api/notifications', { headers: { Cookie: adminCookie } }),
    env
  );
  assert.equal(notifRes.status, 200);
  const notifBody = (await notifRes.json()) as { items: NotificationRecord[] };
  const dueAlerts = notifBody.items.filter(
    (n) => n.event_type === 'HIRE_RETURN_DUE' && n.trip_id === outBody.trip.id
  );
  assert.equal(dueAlerts.length, 1);
  assert.ok(dueAlerts[0].body.includes(todayHarare));
  assert.ok(dueAlerts[0].body.includes('AGB 4412'));

  const repeatCheck = await checkAndNotifyOverdueHires(db, { env });
  assert.equal(repeatCheck.newlyNotified, 0);
});
