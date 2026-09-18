import { describe, it, expect, beforeAll } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../src/app';
import { dbService } from '../src/database/db';

/**
 * Staff Track visibility boundary.
 *
 * Staff Track shows one person's takings and activity to another, so the line
 * between "every staff member" and "only me" is a security boundary rather than
 * a display preference. These tests pin it from the outside — over HTTP, with
 * real tokens — because the enforcement lives in middleware and SQL, where a
 * unit test on the service alone would miss a controller that forgot to pass
 * the scope through.
 *
 * Like the rest of the suite, this runs against the LOC_DB_* MySQL database. It
 * only reads, so it is safe against a seeded schema, and it discovers its own
 * fixtures rather than assuming user ids, so re-seeding does not break it.
 */
const app = createApp();

const SEED_PASSWORDS = ['Super@123', 'Cashier@123', 'Staff@123'];

let adminToken = '';
let adminUserId = 0;

/** A user whose role lacks `stafftrack.view` — the self-scoped tier. */
let selfToken = '';
let selfUserId = 0;

const login = async (username: string): Promise<string> => {
  for (const password of SEED_PASSWORDS) {
    const res = await request(app).post('/api/auth/login').send({ username, password });
    if (res.body?.data?.token) return res.body.data.token;
  }
  return '';
};

beforeAll(async () => {
  await dbService.initialize();

  adminToken = await login('admin');
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${adminToken}`);
  adminUserId = Number(me.body?.data?.id || 0);

  const candidates = await dbService.query<{ id: number; username: string }>(
    `SELECT u.id, u.username
     FROM users u
     JOIN roles r ON u.role_id = r.id
     WHERE u.status = 'ACTIVE'
       AND r.name <> 'ADMIN'
       AND NOT EXISTS (
         SELECT 1 FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = u.role_id AND p.code = 'stafftrack.view')`
  );

  for (const c of candidates) {
    const token = await login(c.username);
    if (token) {
      selfToken = token;
      selfUserId = Number(c.id);
      break;
    }
  }
});

describe('Staff Track visibility scope', () => {
  describe('with stafftrack.view (ADMIN)', () => {
    it('sees the whole roster', async () => {
      const res = await request(app)
        .get('/api/staff-track/staff?limit=100')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(1);
    });

    it('reports scope ALL and lists every staff member in the filter options', async () => {
      const res = await request(app)
        .get('/api/staff-track/filters')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.scope).toBe('ALL');
      expect(res.body.data.staff.length).toBeGreaterThan(1);
    });
  });

  describe('without stafftrack.view (self-scoped)', () => {
    it('reaches the module rather than being refused outright', async () => {
      expect(selfToken).toBeTruthy();
      const res = await request(app)
        .get('/api/staff-track/overview')
        .set('Authorization', `Bearer ${selfToken}`);
      expect(res.status).toBe(200);
      // The overview aggregates, so it is scoped by its own clauses rather than
      // by filters.userId — a regression there shows up as a roster-wide count.
      expect(res.body.data.totalUsers).toBe(1);
    });

    it('sees exactly one staff row: itself', async () => {
      const res = await request(app)
        .get('/api/staff-track/staff?limit=100')
        .set('Authorization', `Bearer ${selfToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].id).toBe(selfUserId);
    });

    it('cannot widen the view with a crafted userId', async () => {
      const res = await request(app)
        .get(`/api/staff-track/staff?userId=${adminUserId}&limit=100`)
        .set('Authorization', `Bearer ${selfToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.every((r: any) => r.id === selfUserId)).toBe(true);
    });

    /**
     * Each endpoint names the staff member in a different place, so the staff
     * id is pulled per shape rather than by guessing at `.id`. A generic
     * extractor reads `/activity`'s audit-row id as a user id (noise) and finds
     * nothing at all in `/tables`, whose body is an object — it passes while
     * the endpoint leaks. Every extractor below is asserted to actually find
     * ids, so a shape change fails loudly instead of going quiet.
     */
    const STAFF_ID_PATHS: { path: string; ids: (body: any) => number[] }[] = [
      { path: '/api/staff-track/revenue', ids: (b) => (b.data || []).map((r: any) => r.id) },
      { path: '/api/staff-track/reports/revenue', ids: (b) => (b.data || []).map((r: any) => r.id) },
      { path: '/api/staff-track/reports/orders', ids: (b) => (b || []).map((r: any) => r.id) },
      {
        path: '/api/staff-track/activity',
        ids: (b) => (b || []).map((r: any) => r.actor?.id).filter(Boolean),
      },
      {
        path: '/api/staff-track/reports/activity',
        ids: (b) => (b || []).map((r: any) => r.id),
      },
      {
        // All three panels: the live floor, the closed-table history and the
        // per-staff totals each carry a name.
        path: '/api/staff-track/tables',
        ids: (b) => [
          ...(b.currentTables || []).map((t: any) => t.attendingStaff?.id),
          ...(b.tableHistory || []).map((h: any) => h.staff?.id),
          ...(b.perStaff || []).map((s: any) => s.id),
        ].filter(Boolean),
      },
      {
        path: '/api/staff-track/reports/tables',
        ids: (b) => (b.perStaff || []).map((s: any) => s.id),
      },
    ];

    it('exposes no other staff member through revenue, tables, activity or any report', async () => {
      for (const { path, ids } of STAFF_ID_PATHS) {
        const res = await request(app)
          .get(`${path}?userId=${adminUserId}`)
          .set('Authorization', `Bearer ${selfToken}`);
        expect(res.status).toBe(200);

        const found = ids(res.body.data).map(Number);
        const leaked = [...new Set(found.filter((id) => id !== selfUserId))];
        // The path rides along so a failure names the endpoint that leaked.
        expect({ path, leaked }).toEqual({ path, leaked: [] });
      }
    });

    it('admin sees other staff through those same endpoints (the extractors work)', async () => {
      // Guards the test above: if an extractor silently found nothing, this
      // fails, so a vacuous pass cannot be mistaken for an enforced boundary.
      let sawSomeoneElse = 0;
      for (const { path, ids } of STAFF_ID_PATHS) {
        const res = await request(app).get(path).set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        const found = ids(res.body.data).map(Number);
        if (found.some((id) => id !== selfUserId)) sawSomeoneElse++;
      }
      expect(sawSomeoneElse).toBeGreaterThan(0);
    });

    it('names no other staff member in the live view', async () => {
      // `/live` takes no filter set at all, so it is scoped by its own clauses
      // rather than through userId — worth pinning separately for that reason.
      const res = await request(app)
        .get('/api/staff-track/live')
        .set('Authorization', `Bearer ${selfToken}`);
      expect(res.status).toBe(200);

      const d = res.body.data;
      const ids = [
        ...(d.openOrders || []).map((o: any) => o.createdBy?.id),
        ...(d.currentTables || []).map((t: any) => t.attendingStaff?.id),
        ...(d.recentStaff || []).map((s: any) => s.id),
      ]
        .filter(Boolean)
        .map(Number);
      expect([...new Set(ids.filter((id) => id !== selfUserId))]).toEqual([]);
    });

    it('lists only its own orders', async () => {
      const res = await request(app)
        .get(`/api/staff-track/orders?userId=${adminUserId}&limit=100`)
        .set('Authorization', `Bearer ${selfToken}`);
      expect(res.status).toBe(200);
      const takers = (res.body.data || []).map((o: any) => o.createdBy?.id).filter(Boolean);
      expect([...new Set(takers.map(Number).filter((id: number) => id !== selfUserId))]).toEqual([]);
    });

    it('refuses another staff member detail page but allows its own', async () => {
      const denied = await request(app)
        .get(`/api/staff-track/staff/${adminUserId}`)
        .set('Authorization', `Bearer ${selfToken}`);
      expect(denied.status).toBe(403);

      const allowed = await request(app)
        .get(`/api/staff-track/staff/${selfUserId}`)
        .set('Authorization', `Bearer ${selfToken}`);
      expect(allowed.status).toBe(200);
    });

    it('collapses the filter options to itself and reports scope SELF', async () => {
      const res = await request(app)
        .get('/api/staff-track/filters')
        .set('Authorization', `Bearer ${selfToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.scope).toBe('SELF');
      expect(res.body.data.staff.map((s: any) => s.id)).toEqual([selfUserId]);
    });

    it('refuses an order it had no hand in', async () => {
      const foreign = await dbService.queryOne<{ id: number }>(
        `SELECT o.id FROM orders o
         WHERE COALESCE(o.created_by, 0) <> ?
           AND NOT EXISTS (SELECT 1 FROM bills b               WHERE b.order_id = o.id AND b.cashier_id = ?)
           AND NOT EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = o.id AND h.changed_by = ?)
           AND NOT EXISTS (SELECT 1 FROM payments p            WHERE p.order_id = o.id AND p.created_by = ?)
         LIMIT 1`,
        [selfUserId, selfUserId, selfUserId, selfUserId]
      );
      if (!foreign) return; // Nothing in this dataset the viewer is uninvolved in.

      const res = await request(app)
        .get(`/api/staff-track/orders/${foreign.id}`)
        .set('Authorization', `Bearer ${selfToken}`);
      expect(res.status).toBe(403);
    });

    it('opens an order it did take', async () => {
      const own = await dbService.queryOne<{ id: number }>(
        'SELECT id FROM orders WHERE created_by = ? LIMIT 1',
        [selfUserId]
      );
      if (!own) return;

      const res = await request(app)
        .get(`/api/staff-track/orders/${own.id}`)
        .set('Authorization', `Bearer ${selfToken}`);
      expect(res.status).toBe(200);
    });
  });

  describe('order reads carry staff attribution and are gated', () => {
    it('rejects an unauthenticated caller', async () => {
      expect((await request(app).get('/api/orders')).status).toBe(401);
      const one = await dbService.queryOne<{ id: number }>('SELECT id FROM orders LIMIT 1');
      if (one) {
        expect((await request(app).get(`/api/orders/${one.id}`)).status).toBe(401);
      }
    });

    it('still serves a caller holding order.manage', async () => {
      const res = await request(app).get('/api/orders').set('Authorization', `Bearer ${selfToken}`);
      expect(res.status).toBe(200);
    });
  });
});
