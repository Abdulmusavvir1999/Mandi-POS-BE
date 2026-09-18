import { dbService } from '../../database/db';
import { AppError } from '../../core/errors/AppError';
import {
  ActivityEntry,
  OrderAttribution,
  OrderTimelineEntry,
  StaffRef,
  StaffTrackFilters,
  StaffTrackRow,
} from './staff-track.types';
import { StaffTrackScope, scopeClause } from './staff-track.scope';

/**
 * Staff Track query layer.
 *
 * Read-only by construction: this service issues no INSERT, UPDATE or DELETE.
 * Revenue figures come straight off the `bills` columns that ReportsService
 * already sums, so a Staff Track total and a sales-report total for the same
 * window agree by definition rather than by coincidence — there is no second
 * tax, discount or refund formula here.
 *
 * Per-staff metrics are assembled with derived-table joins rather than a query
 * per user; a 40-person roster costs the same handful of round trips as a
 * 4-person one.
 */
export class StaffTrackService {
  /**
   * Date filtering mirrors ReportsService exactly — `DATE(col)` against server
   * local time — so Staff Track and the sales reports bucket a late-evening
   * order into the same day instead of disagreeing across a UTC boundary.
   */
  private static dateClause(col: string, from?: string, to?: string): { sql: string; params: any[] } {
    let sql = '';
    const params: any[] = [];
    if (from) {
      sql += ` AND DATE(${col}) >= DATE(?)`;
      params.push(from);
    }
    if (to) {
      sql += ` AND DATE(${col}) <= DATE(?)`;
      params.push(to);
    }
    return { sql, params };
  }

  private static staffRef(
    id: number | null,
    name: string | null,
    username: string | null,
    roleName?: string | null,
    at?: string | null
  ): StaffRef | null {
    if (!id) return null;
    return {
      id,
      name: name || 'Unknown',
      username: username || '',
      ...(roleName ? { roleName } : {}),
      ...(at ? { at } : {}),
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Overview cards
  // ───────────────────────────────────────────────────────────────────────

  /**
   * `recentlyActiveStaff` counts distinct users with an audit entry inside
   * `activeWindowMinutes`. It is deliberately not called "currently working":
   * the POS has no shift, attendance or session table, and `/auth/logout` is a
   * no-op that writes nothing, so a genuine working-status figure has no source.
   * Recent audit activity is the strongest evidence the data actually supports,
   * and the window travels in the response so the UI can label it honestly.
   */
  static async getOverview(
    filters: StaffTrackFilters,
    scope: StaffTrackScope = { kind: 'ALL' },
    activeWindowMinutes = 30
  ) {
    const { dateFrom, dateTo } = filters;
    const orderDate = this.dateClause('o.created_at', dateFrom, dateTo);
    const billDate = this.dateClause('b.created_at', dateFrom, dateTo);

    // The overview aggregates rather than listing, so it ignores `filters.userId`
    // and has to be constrained on its own. Each card is pinned to the column
    // that actually attributes it: orders to the taker, bills to the settler,
    // audit rows and the roster counts to the viewer's own record.
    const ordersScope = scopeClause(scope, 'o.created_by');
    const billsScope = scopeClause(scope, 'b.cashier_id');
    const auditScope = scopeClause(scope, 'a.user_id');
    const userScope = scopeClause(scope, 'u.id');

    const users = await dbService.queryOne<{ total_users: number; active_users: number }>(
      `SELECT
         COUNT(*) AS total_users,
         SUM(u.status = 'ACTIVE') AS active_users
       FROM users u
       WHERE 1=1${userScope.sql}`,
      userScope.params
    );

    const recent = await dbService.queryOne<{ recently_active: number }>(
      `SELECT COUNT(DISTINCT a.user_id) AS recently_active
       FROM audit_logs a
       WHERE a.user_id IS NOT NULL
         AND a.created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)${auditScope.sql}`,
      [activeWindowMinutes, ...auditScope.params]
    );

    const orders = await dbService.queryOne<{
      orders_taken: number;
      completed_orders: number;
      cancelled_orders: number;
      pending_orders: number;
      in_progress_orders: number;
      tables_served: number;
      order_value: number;
    }>(
      `SELECT
         COUNT(*) AS orders_taken,
         COALESCE(SUM(o.status = 'COMPLETED'), 0) AS completed_orders,
         COALESCE(SUM(o.status = 'CANCELLED'), 0) AS cancelled_orders,
         COALESCE(SUM(o.status = 'PENDING'), 0) AS pending_orders,
         COALESCE(SUM(o.status = 'IN_PROGRESS'), 0) AS in_progress_orders,
         COUNT(DISTINCT o.dining_table_id) AS tables_served,
         COALESCE(SUM(o.total_amount), 0) AS order_value
       FROM orders o
       WHERE 1=1${orderDate.sql}${ordersScope.sql}`,
      [...orderDate.params, ...ordersScope.params]
    );

    const revenue = await dbService.queryOne<{
      revenue: number;
      bills_count: number;
      gross_sales: number;
      discount_amount: number;
      tax_amount: number;
    }>(
      `SELECT
         COALESCE(SUM(b.total_amount), 0) AS revenue,
         COUNT(b.id) AS bills_count,
         COALESCE(SUM(b.subtotal), 0) AS gross_sales,
         COALESCE(SUM(b.discount_amount), 0) AS discount_amount,
         COALESCE(SUM(b.tax_amount), 0) AS tax_amount
       FROM bills b
       WHERE 1=1${billDate.sql}${billsScope.sql}`,
      [...billDate.params, ...billsScope.params]
    );

    // `totalTables` is a property of the restaurant, not of any staff member, so
    // it stays whole at both scopes. `activeTables` is attributable, so a
    // self-scoped viewer sees only the occupied tables holding their own order.
    const tables = await dbService.queryOne<{ active_tables: number; total_tables: number }>(
      scope.kind === 'ALL'
        ? `SELECT
             COALESCE(SUM(t.status = 'OCCUPIED'), 0) AS active_tables,
             COUNT(*) AS total_tables
           FROM dining_tables t`
        : `SELECT
             COALESCE(SUM(t.status = 'OCCUPIED' AND o.created_by = ?), 0) AS active_tables,
             COUNT(*) AS total_tables
           FROM dining_tables t
           LEFT JOIN orders o ON t.current_order_id = o.id`,
      scope.kind === 'ALL' ? [] : [scope.userId]
    );

    return {
      totalUsers: Number(users?.total_users || 0),
      activeUsers: Number(users?.active_users || 0),
      recentlyActiveStaff: Number(recent?.recently_active || 0),
      activeWindowMinutes,
      ordersTaken: Number(orders?.orders_taken || 0),
      completedOrders: Number(orders?.completed_orders || 0),
      cancelledOrders: Number(orders?.cancelled_orders || 0),
      pendingOrders: Number(orders?.pending_orders || 0),
      inProgressOrders: Number(orders?.in_progress_orders || 0),
      orderValue: Number(orders?.order_value || 0),
      tablesServed: Number(orders?.tables_served || 0),
      revenue: Number(revenue?.revenue || 0),
      billsSettled: Number(revenue?.bills_count || 0),
      grossSales: Number(revenue?.gross_sales || 0),
      discountAmount: Number(revenue?.discount_amount || 0),
      taxAmount: Number(revenue?.tax_amount || 0),
      activeTables: Number(tables?.active_tables || 0),
      totalTables: Number(tables?.total_tables || 0),
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Staff list with per-user metrics
  // ───────────────────────────────────────────────────────────────────────

  /**
   * One query, five derived tables. The joins are the reason this stays flat
   * as the roster grows: pulling orders, bills, items, tables and last-activity
   * per user in a loop would be five round trips *per staff member*.
   *
   * Param order below follows the textual order of the joins, then the outer
   * WHERE, then LIMIT/OFFSET — MySQL binds positionally.
   */
  static async getStaffList(filters: StaffTrackFilters, page = 1, limit = 25) {
    const offset = (page - 1) * limit;
    const { dateFrom, dateTo } = filters;

    const outer: string[] = [];
    const outerParams: any[] = [];
    if (filters.userId) {
      outer.push('u.id = ?');
      outerParams.push(filters.userId);
    }
    if (filters.roleId) {
      outer.push('u.role_id = ?');
      outerParams.push(filters.roleId);
    }
    if (filters.status) {
      outer.push('u.status = ?');
      outerParams.push(filters.status);
    }
    if (filters.search) {
      outer.push('(u.name LIKE ? OR u.username LIKE ? OR u.email LIKE ?)');
      outerParams.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
    }
    const outerWhere = outer.length ? `WHERE ${outer.join(' AND ')}` : '';

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM users u ${outerWhere}`,
      outerParams
    );
    const total = Number(countRes?.total || 0);

    const od = this.dateClause('o.created_at', dateFrom, dateTo);
    const bd = this.dateClause('b.created_at', dateFrom, dateTo);
    const id2 = this.dateClause('o2.created_at', dateFrom, dateTo);
    const sd = this.dateClause('o3.created_at', dateFrom, dateTo);

    const joinParams = [...od.params, ...bd.params, ...id2.params, ...sd.params];

    const rows = await dbService.query<any>(
      `SELECT
         u.id, u.name, u.username, u.email, u.image_url, u.status, u.last_login_at,
         r.name AS role_name,

         COALESCE(ord.orders_taken, 0)      AS orders_taken,
         COALESCE(ord.completed_orders, 0)  AS completed_orders,
         COALESCE(ord.cancelled_orders, 0)  AS cancelled_orders,
         COALESCE(ord.pending_orders, 0)    AS pending_orders,
         COALESCE(ord.in_progress_orders,0) AS in_progress_orders,
         COALESCE(ord.order_value, 0)       AS order_value,
         COALESCE(ord.tables_attended, 0)   AS tables_attended,

         COALESCE(bil.revenue, 0)           AS revenue,
         COALESCE(bil.bills_count, 0)       AS bills_settled,
         COALESCE(bil.gross_sales, 0)       AS gross_sales,
         COALESCE(bil.discount_amount, 0)   AS discount_amount,
         COALESCE(bil.tax_amount, 0)        AS tax_amount,

         COALESCE(itm.items_handled, 0)     AS items_handled,
         COALESCE(cur.active_tables, 0)     AS active_tables,
         svc.avg_service_seconds            AS avg_service_seconds,

         act.action      AS last_action,
         act.module      AS last_module,
         act.record_id   AS last_record_id,
         act.created_at  AS last_activity_at

       FROM users u
       JOIN roles r ON u.role_id = r.id

       LEFT JOIN (
         SELECT o.created_by AS uid,
                COUNT(*) AS orders_taken,
                SUM(o.status = 'COMPLETED')   AS completed_orders,
                SUM(o.status = 'CANCELLED')   AS cancelled_orders,
                SUM(o.status = 'PENDING')     AS pending_orders,
                SUM(o.status = 'IN_PROGRESS') AS in_progress_orders,
                SUM(o.total_amount)           AS order_value,
                COUNT(DISTINCT o.dining_table_id) AS tables_attended
         FROM orders o
         WHERE o.created_by IS NOT NULL${od.sql}
         GROUP BY o.created_by
       ) ord ON ord.uid = u.id

       LEFT JOIN (
         SELECT b.cashier_id AS uid,
                COUNT(*)                   AS bills_count,
                SUM(b.total_amount)        AS revenue,
                SUM(b.subtotal)            AS gross_sales,
                SUM(b.discount_amount)     AS discount_amount,
                SUM(b.tax_amount)          AS tax_amount
         FROM bills b
         WHERE 1=1${bd.sql}
         GROUP BY b.cashier_id
       ) bil ON bil.uid = u.id

       LEFT JOIN (
         SELECT o2.created_by AS uid, SUM(oi.quantity) AS items_handled
         FROM order_items oi
         JOIN orders o2 ON oi.order_id = o2.id
         WHERE o2.created_by IS NOT NULL${id2.sql}
         GROUP BY o2.created_by
       ) itm ON itm.uid = u.id

       LEFT JOIN (
         SELECT o3.created_by AS uid,
                AVG(TIMESTAMPDIFF(SECOND, o3.created_at, h.completed_at)) AS avg_service_seconds
         FROM orders o3
         JOIN (
           SELECT order_id, MIN(created_at) AS completed_at
           FROM order_status_history
           WHERE new_status = 'COMPLETED'
           GROUP BY order_id
         ) h ON h.order_id = o3.id
         WHERE o3.created_by IS NOT NULL${sd.sql}
         GROUP BY o3.created_by
       ) svc ON svc.uid = u.id

       LEFT JOIN (
         SELECT ao.created_by AS uid, COUNT(*) AS active_tables
         FROM dining_tables dt
         JOIN orders ao ON dt.current_order_id = ao.id
         WHERE dt.status = 'OCCUPIED' AND ao.created_by IS NOT NULL
         GROUP BY ao.created_by
       ) cur ON cur.uid = u.id

       LEFT JOIN (
         SELECT al.user_id AS uid, al.action, al.module, al.record_id, al.created_at
         FROM audit_logs al
         JOIN (
           SELECT user_id, MAX(id) AS max_id
           FROM audit_logs
           WHERE user_id IS NOT NULL
           GROUP BY user_id
         ) m ON m.max_id = al.id
       ) act ON act.uid = u.id

       ${outerWhere}
       ORDER BY revenue DESC, orders_taken DESC, u.name ASC
       LIMIT ? OFFSET ?`,
      [...joinParams, ...outerParams, limit, offset]
    );

    const data: StaffTrackRow[] = rows.map((r) => this.mapStaffRow(r));

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  private static mapStaffRow(r: any): StaffTrackRow {
    const ordersTaken = Number(r.orders_taken || 0);
    const orderValue = Number(r.order_value || 0);
    return {
      id: r.id,
      name: r.name,
      username: r.username,
      email: r.email,
      imageUrl: r.image_url || null,
      roleName: r.role_name,
      status: r.status,
      lastLoginAt: r.last_login_at || null,
      lastActivityAt: r.last_activity_at || null,
      currentActivity: r.last_action
        ? {
            action: r.last_action,
            module: r.last_module,
            recordId: r.last_record_id || null,
            at: r.last_activity_at,
          }
        : null,
      ordersTaken,
      completedOrders: Number(r.completed_orders || 0),
      cancelledOrders: Number(r.cancelled_orders || 0),
      pendingOrders: Number(r.pending_orders || 0),
      inProgressOrders: Number(r.in_progress_orders || 0),
      orderValue,
      averageOrderValue: ordersTaken > 0 ? Math.round((orderValue / ordersTaken) * 100) / 100 : 0,
      itemsHandled: Number(r.items_handled || 0),
      revenue: Number(r.revenue || 0),
      billsSettled: Number(r.bills_settled || 0),
      grossSales: Number(r.gross_sales || 0),
      discountAmount: Number(r.discount_amount || 0),
      taxAmount: Number(r.tax_amount || 0),
      activeTables: Number(r.active_tables || 0),
      tablesAttended: Number(r.tables_attended || 0),
      averageServiceSeconds:
        r.avg_service_seconds === null || r.avg_service_seconds === undefined
          ? null
          : Math.round(Number(r.avg_service_seconds)),
    };
  }

  /** Single staff member's headline metrics for the detail page. */
  static async getStaffDetail(userId: number, filters: StaffTrackFilters) {
    const user = await dbService.queryOne<any>(
      `SELECT u.id, u.name, u.username, u.email, u.phone, u.image_url, u.status,
              u.last_login_at, u.created_at, r.name AS role_name
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.id = ?`,
      [userId]
    );
    if (!user) {
      throw AppError.notFound('Staff member not found');
    }

    const list = await this.getStaffList({ ...filters, userId }, 1, 1);
    const summary = list.data[0];

    return {
      profile: {
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        phone: user.phone || null,
        imageUrl: user.image_url || null,
        roleName: user.role_name,
        status: user.status,
        lastLoginAt: user.last_login_at || null,
        joinedAt: user.created_at,
      },
      summary: summary || null,
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Live activity
  // ───────────────────────────────────────────────────────────────────────

  /**
   * A snapshot, loaded on entry and on explicit refresh. The project ships no
   * socket, SSE or subscription layer, so there is nothing to subscribe to;
   * adding a poll loop here would be the background chatter the brief rules out.
   */
  static async getLiveActivity(activeWindowMinutes = 30, scope: StaffTrackScope = { kind: 'ALL' }) {
    // Live takes no filter set, so each of its three panels is constrained here.
    // Open orders and occupied tables are attributed through orders.created_by;
    // the recent-staff panel is a roster and collapses to the viewer alone.
    const liveOrders = scopeClause(scope, 'o.created_by');
    const liveTables = scopeClause(scope, 'o.created_by');
    const liveStaff = scopeClause(scope, 'u.id');

    const openOrders = await dbService.query<any>(
      `SELECT o.id, o.order_number, o.status, o.order_type, o.total_amount,
              o.created_at, o.updated_at,
              t.id AS table_id, t.table_number, t.name AS table_name, t.status AS table_status,
              c.name AS customer_name,
              u.id AS created_by_id, u.name AS created_by_name, u.username AS created_by_username,
              ru.name AS created_by_role,
              b.id AS bill_id, b.payment_status
       FROM orders o
       LEFT JOIN dining_tables t ON o.dining_table_id = t.id
       LEFT JOIN customers c     ON o.customer_id = c.id
       LEFT JOIN users u         ON o.created_by = u.id
       LEFT JOIN roles ru        ON u.role_id = ru.id
       LEFT JOIN bills b         ON b.order_id = o.id
       WHERE o.status IN ('PENDING', 'IN_PROGRESS')${liveOrders.sql}
       ORDER BY o.created_at ASC`,
      liveOrders.params
    );

    const occupiedTables = await dbService.query<any>(
      `SELECT t.id AS table_id, t.table_number, t.name AS table_name, t.section,
              t.status AS table_status, t.capacity,
              o.id AS order_id, o.order_number, o.status AS order_status,
              o.total_amount, o.created_at AS order_created_at, o.updated_at AS order_updated_at,
              u.id AS staff_id, u.name AS staff_name, u.username AS staff_username,
              u.image_url AS staff_image_url, ru.name AS staff_role
       FROM dining_tables t
       LEFT JOIN orders o ON t.current_order_id = o.id
       LEFT JOIN users u  ON o.created_by = u.id
       LEFT JOIN roles ru ON u.role_id = ru.id
       WHERE t.status = 'OCCUPIED'${liveTables.sql}
       ORDER BY t.display_order ASC, t.table_number ASC`,
      liveTables.params
    );

    const recentStaff = await dbService.query<any>(
      `SELECT u.id, u.name, u.username, u.image_url, u.status, u.last_login_at,
              r.name AS role_name,
              act.action AS last_action, act.module AS last_module,
              act.record_id AS last_record_id, act.created_at AS last_activity_at,
              COALESCE(cur.active_tables, 0) AS active_tables,
              COALESCE(opn.open_orders, 0)   AS open_orders
       FROM users u
       JOIN roles r ON u.role_id = r.id
       JOIN (
         SELECT al.user_id AS uid, al.action, al.module, al.record_id, al.created_at
         FROM audit_logs al
         JOIN (
           SELECT user_id, MAX(id) AS max_id
           FROM audit_logs
           WHERE user_id IS NOT NULL
           GROUP BY user_id
         ) m ON m.max_id = al.id
       ) act ON act.uid = u.id
       LEFT JOIN (
         SELECT ao.created_by AS uid, COUNT(*) AS active_tables
         FROM dining_tables dt
         JOIN orders ao ON dt.current_order_id = ao.id
         WHERE dt.status = 'OCCUPIED' AND ao.created_by IS NOT NULL
         GROUP BY ao.created_by
       ) cur ON cur.uid = u.id
       LEFT JOIN (
         SELECT oo.created_by AS uid, COUNT(*) AS open_orders
         FROM orders oo
         WHERE oo.status IN ('PENDING', 'IN_PROGRESS') AND oo.created_by IS NOT NULL
         GROUP BY oo.created_by
       ) opn ON opn.uid = u.id
       WHERE act.created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)${liveStaff.sql}
       ORDER BY act.created_at DESC`,
      [activeWindowMinutes, ...liveStaff.params]
    );

    return {
      activeWindowMinutes,
      capturedAt: new Date().toISOString(),
      openOrders: openOrders.map((o) => ({
        orderId: o.id,
        orderNumber: o.order_number,
        status: o.status,
        orderType: o.order_type,
        totalAmount: Number(o.total_amount || 0),
        createdAt: o.created_at,
        lastActivityAt: o.updated_at,
        paymentStatus: o.bill_id ? o.payment_status : 'UNBILLED',
        table: o.table_id
          ? { id: o.table_id, tableNumber: o.table_number, name: o.table_name, status: o.table_status }
          : null,
        customerName: o.customer_name || null,
        createdBy: this.staffRef(o.created_by_id, o.created_by_name, o.created_by_username, o.created_by_role),
      })),
      currentTables: occupiedTables.map((t) => ({
        tableId: t.table_id,
        tableNumber: t.table_number,
        tableName: t.table_name,
        section: t.section,
        capacity: t.capacity,
        tableStatus: t.table_status,
        order: t.order_id
          ? {
              orderId: t.order_id,
              orderNumber: t.order_number,
              status: t.order_status,
              totalAmount: Number(t.total_amount || 0),
              createdAt: t.order_created_at,
              lastActivityAt: t.order_updated_at,
            }
          : null,
        /**
         * Derived through the table's current order, not from a table-to-staff
         * assignment: `dining_tables` has no waiter column and no assignment
         * history, so the order's author is the only evidence available.
         */
        attendingStaff: this.staffRef(t.staff_id, t.staff_name, t.staff_username, t.staff_role),
        attendingStaffImageUrl: t.staff_image_url || null,
        attributionBasis: t.staff_id ? 'ORDER_CREATED_BY' : 'NONE',
      })),
      recentlyActiveStaff: recentStaff.map((s) => ({
        id: s.id,
        name: s.name,
        username: s.username,
        imageUrl: s.image_url || null,
        roleName: s.role_name,
        status: s.status,
        lastLoginAt: s.last_login_at || null,
        lastActivityAt: s.last_activity_at,
        activeTables: Number(s.active_tables || 0),
        openOrders: Number(s.open_orders || 0),
        currentActivity: {
          action: s.last_action,
          module: s.last_module,
          recordId: s.last_record_id || null,
          at: s.last_activity_at,
        },
      })),
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Orders
  // ───────────────────────────────────────────────────────────────────────

  static async getOrders(
    filters: StaffTrackFilters & { status?: string; paymentStatus?: string; tableId?: number },
    page = 1,
    limit = 25
  ) {
    const offset = (page - 1) * limit;
    const conditions: string[] = ['1=1'];
    const condParams: any[] = [];
    if (filters.dateFrom) {
      conditions.push('DATE(o.created_at) >= DATE(?)');
      condParams.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      conditions.push('DATE(o.created_at) <= DATE(?)');
      condParams.push(filters.dateTo);
    }
    if (filters.userId) {
      conditions.push('o.created_by = ?');
      condParams.push(filters.userId);
    }
    if (filters.status) {
      conditions.push('o.status = ?');
      condParams.push(filters.status);
    }
    if (filters.tableId) {
      conditions.push('o.dining_table_id = ?');
      condParams.push(filters.tableId);
    }
    if (filters.roleId) {
      conditions.push('u.role_id = ?');
      condParams.push(filters.roleId);
    }
    if (filters.paymentStatus) {
      if (filters.paymentStatus === 'UNBILLED') {
        conditions.push('b.id IS NULL');
      } else {
        conditions.push('b.payment_status = ?');
        condParams.push(filters.paymentStatus);
      }
    }
    if (filters.search) {
      conditions.push('(o.order_number LIKE ? OR u.name LIKE ?)');
      condParams.push(`%${filters.search}%`, `%${filters.search}%`);
    }

    const whereSql = `WHERE ${conditions.join(' AND ')}`;

    const baseFrom = `
      FROM orders o
      LEFT JOIN users u          ON o.created_by = u.id
      LEFT JOIN dining_tables t  ON o.dining_table_id = t.id
      LEFT JOIN customers c      ON o.customer_id = c.id
      LEFT JOIN bills b          ON b.order_id = o.id
    `;

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total ${baseFrom} ${whereSql}`,
      condParams
    );
    const total = Number(countRes?.total || 0);

    const rows = await dbService.query<any>(
      `SELECT o.id, o.order_number, o.status, o.order_type, o.total_amount,
              o.subtotal, o.discount_amount, o.tax_amount,
              o.created_at, o.updated_at,
              u.id AS created_by_id, u.name AS created_by_name, u.username AS created_by_username,
              t.id AS table_id, t.table_number, t.name AS table_name,
              c.name AS customer_name,
              b.id AS bill_id, b.bill_number, b.payment_status, b.payment_method,
              bu.id AS cashier_id, bu.name AS cashier_name, bu.username AS cashier_username,
              h.completed_at
       ${baseFrom}
       LEFT JOIN users bu ON b.cashier_id = bu.id
       LEFT JOIN (
         SELECT order_id, MIN(created_at) AS completed_at
         FROM order_status_history
         WHERE new_status = 'COMPLETED'
         GROUP BY order_id
       ) h ON h.order_id = o.id
       ${whereSql}
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
      [...condParams, limit, offset]
    );

    return {
      data: rows.map((o) => ({
        orderId: o.id,
        orderNumber: o.order_number,
        status: o.status,
        orderType: o.order_type,
        subtotal: Number(o.subtotal || 0),
        discountAmount: Number(o.discount_amount || 0),
        taxAmount: Number(o.tax_amount || 0),
        totalAmount: Number(o.total_amount || 0),
        createdAt: o.created_at,
        completedAt: o.completed_at || null,
        durationSeconds: o.completed_at
          ? Math.max(0, Math.round((new Date(o.completed_at).getTime() - new Date(o.created_at).getTime()) / 1000))
          : null,
        table: o.table_id ? { id: o.table_id, tableNumber: o.table_number, name: o.table_name } : null,
        customerName: o.customer_name || null,
        billNumber: o.bill_number || null,
        paymentStatus: o.bill_id ? o.payment_status : 'UNBILLED',
        paymentMethod: o.payment_method || null,
        /** Took the order. */
        createdBy: this.staffRef(o.created_by_id, o.created_by_name, o.created_by_username),
        /** Settled the bill — frequently, but not always, the same person. */
        settledBy: this.staffRef(o.cashier_id, o.cashier_name, o.cashier_username),
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  /**
   * Attribution and timeline for one order.
   *
   * Lifecycle actors come from `order_status_history.changed_by`, which the POS
   * writes on every transition. Where the POS never records an actor — nothing
   * marks an order "served", and there is no edit, refund or void flow — the
   * field is absent rather than guessed at from whoever last opened the order.
   */
  static async getOrderAttribution(orderId: number, scope: StaffTrackScope = { kind: 'ALL' }) {
    // A self-scoped viewer may open an order they had a hand in — one they took,
    // settled, moved through a status, or took a payment on. Anything else is
    // another person's work and returns 403 rather than a redacted body, since
    // the whole point of this screen is naming who did what.
    if (scope.kind === 'SELF') {
      const involved = await dbService.queryOne<{ involved: number }>(
        `SELECT EXISTS (
           SELECT 1 FROM orders o            WHERE o.id = ? AND o.created_by = ?
           UNION ALL
           SELECT 1 FROM bills b             WHERE b.order_id = ? AND b.cashier_id = ?
           UNION ALL
           SELECT 1 FROM order_status_history h WHERE h.order_id = ? AND h.changed_by = ?
           UNION ALL
           SELECT 1 FROM payments p          WHERE p.order_id = ? AND p.created_by = ?
         ) AS involved`,
        [orderId, scope.userId, orderId, scope.userId, orderId, scope.userId, orderId, scope.userId]
      );
      if (!Number(involved?.involved || 0)) {
        throw AppError.forbidden('Requires permission: stafftrack.view');
      }
    }

    const order = await dbService.queryOne<any>(
      `SELECT o.id, o.order_number, o.status, o.order_type, o.total_amount, o.subtotal,
              o.discount_amount, o.tax_amount, o.notes, o.created_at, o.updated_at,
              u.id AS created_by_id, u.name AS created_by_name, u.username AS created_by_username,
              ru.name AS created_by_role,
              t.id AS table_id, t.table_number, t.name AS table_name,
              c.name AS customer_name, c.phone AS customer_phone
       FROM orders o
       LEFT JOIN users u         ON o.created_by = u.id
       LEFT JOIN roles ru        ON u.role_id = ru.id
       LEFT JOIN dining_tables t ON o.dining_table_id = t.id
       LEFT JOIN customers c     ON o.customer_id = c.id
       WHERE o.id = ?`,
      [orderId]
    );
    if (!order) {
      throw AppError.notFound('Order not found');
    }

    const history = await dbService.query<any>(
      `SELECT h.id, h.previous_status, h.new_status, h.notes, h.created_at,
              u.id AS actor_id, u.name AS actor_name, u.username AS actor_username,
              r.name AS actor_role
       FROM order_status_history h
       LEFT JOIN users u ON h.changed_by = u.id
       LEFT JOIN roles r ON u.role_id = r.id
       WHERE h.order_id = ?
       ORDER BY h.created_at ASC, h.id ASC`,
      [orderId]
    );

    const bill = await dbService.queryOne<any>(
      `SELECT b.id, b.bill_number, b.payment_status, b.payment_method, b.total_amount,
              b.discount_amount, b.tax_amount, b.subtotal, b.created_at,
              u.id AS cashier_id, u.name AS cashier_name, u.username AS cashier_username,
              r.name AS cashier_role
       FROM bills b
       LEFT JOIN users u ON b.cashier_id = u.id
       LEFT JOIN roles r ON u.role_id = r.id
       WHERE b.order_id = ?`,
      [orderId]
    );

    const payments = await dbService.query<any>(
      `SELECT p.id, p.amount, p.payment_method, p.status, p.created_at,
              u.id AS actor_id, u.name AS actor_name, u.username AS actor_username
       FROM payments p
       LEFT JOIN users u ON p.created_by = u.id
       WHERE p.order_id = ?
       ORDER BY p.created_at ASC`,
      [orderId]
    );

    const findActor = (status: string) => {
      const row = history.find((h) => h.new_status === status && h.actor_id);
      return row ? this.staffRef(row.actor_id, row.actor_name, row.actor_username, row.actor_role, row.created_at) : null;
    };

    const attribution: OrderAttribution = {
      orderId: order.id,
      orderNumber: order.order_number,
      createdBy: this.staffRef(
        order.created_by_id,
        order.created_by_name,
        order.created_by_username,
        order.created_by_role,
        order.created_at
      ),
      startedBy: findActor('IN_PROGRESS'),
      completedBy: findActor('COMPLETED'),
      cancelledBy: findActor('CANCELLED'),
      paymentBy: bill
        ? this.staffRef(bill.cashier_id, bill.cashier_name, bill.cashier_username, bill.cashier_role, bill.created_at)
        : null,
    };

    const timeline: OrderTimelineEntry[] = [];

    if (order.created_by_id) {
      timeline.push({
        at: order.created_at,
        actor: this.staffRef(order.created_by_id, order.created_by_name, order.created_by_username, order.created_by_role),
        action: 'ORDER_CREATED',
        source: 'ORDER',
        detail: order.order_number,
      });
    }

    for (const h of history) {
      timeline.push({
        at: h.created_at,
        actor: this.staffRef(h.actor_id, h.actor_name, h.actor_username, h.actor_role),
        action: `STATUS_${h.previous_status || 'NEW'}_TO_${h.new_status}`,
        source: 'ORDER_STATUS_HISTORY',
        detail: h.notes || null,
      });
    }

    for (const p of payments) {
      timeline.push({
        at: p.created_at,
        actor: this.staffRef(p.actor_id, p.actor_name, p.actor_username),
        action: 'PAYMENT_RECORDED',
        source: 'PAYMENT',
        detail: `${p.payment_method} ${p.amount}`,
      });
    }

    // Audit rows carry actions the status history does not, such as BILL_PRINTED.
    const auditRows = await dbService.query<any>(
      `SELECT a.id, a.action, a.module, a.created_at,
              u.id AS actor_id, u.name AS actor_name, u.username AS actor_username
       FROM audit_logs a
       LEFT JOIN users u ON a.user_id = u.id
       WHERE (a.module = 'ORDERS' AND a.record_id = ?)
          ${bill ? "OR (a.module IN ('CHECKOUT','BILLS') AND a.record_id = ?)" : ''}
       ORDER BY a.created_at ASC`,
      bill ? [String(orderId), String(bill.id)] : [String(orderId)]
    );

    for (const a of auditRows) {
      timeline.push({
        at: a.created_at,
        actor: this.staffRef(a.actor_id, a.actor_name, a.actor_username),
        action: a.action,
        source: 'AUDIT',
        detail: a.module,
      });
    }

    timeline.sort((x, y) => new Date(x.at).getTime() - new Date(y.at).getTime());

    return {
      order: {
        orderId: order.id,
        orderNumber: order.order_number,
        status: order.status,
        orderType: order.order_type,
        subtotal: Number(order.subtotal || 0),
        discountAmount: Number(order.discount_amount || 0),
        taxAmount: Number(order.tax_amount || 0),
        totalAmount: Number(order.total_amount || 0),
        notes: order.notes || null,
        createdAt: order.created_at,
        table: order.table_id
          ? { id: order.table_id, tableNumber: order.table_number, name: order.table_name }
          : null,
        customerName: order.customer_name || null,
      },
      bill: bill
        ? {
            billId: bill.id,
            billNumber: bill.bill_number,
            paymentStatus: bill.payment_status,
            paymentMethod: bill.payment_method,
            subtotal: Number(bill.subtotal || 0),
            discountAmount: Number(bill.discount_amount || 0),
            taxAmount: Number(bill.tax_amount || 0),
            totalAmount: Number(bill.total_amount || 0),
            createdAt: bill.created_at,
          }
        : null,
      attribution,
      timeline,
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Revenue
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Per-cashier revenue, summed off the same `bills` columns ReportsService
   * uses. Cancelled-order value is reported from `orders`, kept separate from
   * revenue because a cancelled order never produces a bill and must not net
   * against takings.
   */
  static async getRevenue(filters: StaffTrackFilters) {
    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    if (filters.dateFrom) {
      conditions.push('DATE(b.created_at) >= DATE(?)');
      params.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      conditions.push('DATE(b.created_at) <= DATE(?)');
      params.push(filters.dateTo);
    }
    if (filters.userId) {
      conditions.push('b.cashier_id = ?');
      params.push(filters.userId);
    }
    if (filters.roleId) {
      conditions.push('u.role_id = ?');
      params.push(filters.roleId);
    }

    const byStaff = await dbService.query<any>(
      `SELECT u.id, u.name, u.username, u.image_url, r.name AS role_name,
              COUNT(b.id)                                   AS bills_count,
              COALESCE(SUM(b.subtotal), 0)                  AS gross_sales,
              COALESCE(SUM(b.discount_amount), 0)           AS discount_amount,
              COALESCE(SUM(b.tax_amount), 0)                AS tax_amount,
              COALESCE(SUM(b.total_amount), 0)              AS net_revenue,
              COALESCE(SUM(b.payment_status = 'PAID'), 0)   AS paid_orders,
              COALESCE(SUM(b.payment_status = 'PENDING'), 0) AS pending_orders,
              COALESCE(SUM(b.payment_status = 'REFUNDED'), 0) AS refunded_orders,
              COALESCE(SUM(CASE WHEN b.payment_status = 'REFUNDED' THEN b.total_amount ELSE 0 END), 0) AS refunded_amount
       FROM bills b
       JOIN users u ON b.cashier_id = u.id
       JOIN roles r ON u.role_id = r.id
       WHERE ${conditions.join(' AND ')}
       GROUP BY u.id, u.name, u.username, u.image_url, r.name
       ORDER BY net_revenue DESC`,
      params
    );

    // Cancelled value is an orders-side figure; it never becomes revenue.
    const cancelConditions: string[] = ["o.status = 'CANCELLED'"];
    const cancelParams: any[] = [];
    if (filters.dateFrom) {
      cancelConditions.push('DATE(o.created_at) >= DATE(?)');
      cancelParams.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      cancelConditions.push('DATE(o.created_at) <= DATE(?)');
      cancelParams.push(filters.dateTo);
    }
    if (filters.userId) {
      cancelConditions.push('o.created_by = ?');
      cancelParams.push(filters.userId);
    }

    const cancelled = await dbService.query<any>(
      `SELECT o.created_by AS uid, COUNT(*) AS cancelled_count,
              COALESCE(SUM(o.total_amount), 0) AS cancelled_value
       FROM orders o
       WHERE ${cancelConditions.join(' AND ')} AND o.created_by IS NOT NULL
       GROUP BY o.created_by`,
      cancelParams
    );
    const cancelledByUser = new Map<number, { count: number; value: number }>(
      cancelled.map((c) => [Number(c.uid), { count: Number(c.cancelled_count), value: Number(c.cancelled_value) }])
    );

    const data = byStaff.map((s) => {
      const c = cancelledByUser.get(Number(s.id));
      return {
        id: s.id,
        name: s.name,
        username: s.username,
        imageUrl: s.image_url || null,
        roleName: s.role_name,
        billsCount: Number(s.bills_count || 0),
        grossSales: Number(s.gross_sales || 0),
        discountAmount: Number(s.discount_amount || 0),
        taxAmount: Number(s.tax_amount || 0),
        netRevenue: Number(s.net_revenue || 0),
        paidOrders: Number(s.paid_orders || 0),
        pendingOrders: Number(s.pending_orders || 0),
        refundedOrders: Number(s.refunded_orders || 0),
        refundedAmount: Number(s.refunded_amount || 0),
        cancelledOrders: c?.count || 0,
        cancelledValue: c?.value || 0,
        averageBillValue:
          Number(s.bills_count) > 0
            ? Math.round((Number(s.net_revenue) / Number(s.bills_count)) * 100) / 100
            : 0,
      };
    });

    const totals = data.reduce(
      (acc, d) => ({
        billsCount: acc.billsCount + d.billsCount,
        grossSales: acc.grossSales + d.grossSales,
        discountAmount: acc.discountAmount + d.discountAmount,
        taxAmount: acc.taxAmount + d.taxAmount,
        netRevenue: acc.netRevenue + d.netRevenue,
        refundedAmount: acc.refundedAmount + d.refundedAmount,
        cancelledValue: acc.cancelledValue + d.cancelledValue,
      }),
      { billsCount: 0, grossSales: 0, discountAmount: 0, taxAmount: 0, netRevenue: 0, refundedAmount: 0, cancelledValue: 0 }
    );

    return { data, totals };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Tables
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Staff-to-table is derived through the order occupying the table, since
   * `dining_tables` carries no waiter column and the POS keeps no assignment or
   * transfer log. `attributionBasis` travels with every row so the UI never
   * presents a derivation as a recorded assignment.
   */
  static async getTables(filters: StaffTrackFilters) {
    // The live table panel names the staff member attending each table, so it
    // has to honour `userId` like the history query below it. Without this a
    // self-scoped viewer was served the whole floor with every colleague's name
    // on it, and a staff filter applied to the history left this panel showing
    // everyone — the two halves of one screen disagreeing about the filter.
    const currentWhere = filters.userId ? 'WHERE o.created_by = ?' : '';
    const currentParams = filters.userId ? [filters.userId] : [];

    const current = await dbService.query<any>(
      `SELECT t.id, t.table_number, t.name, t.section, t.capacity, t.status,
              o.id AS order_id, o.order_number, o.status AS order_status,
              o.total_amount, o.created_at AS order_created_at, o.updated_at AS order_updated_at,
              u.id AS staff_id, u.name AS staff_name, u.username AS staff_username,
              u.image_url AS staff_image_url, r.name AS staff_role,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
       FROM dining_tables t
       LEFT JOIN orders o ON t.current_order_id = o.id
       LEFT JOIN users u  ON o.created_by = u.id
       LEFT JOIN roles r  ON u.role_id = r.id
       ${currentWhere}
       ORDER BY t.display_order ASC, t.table_number ASC`,
      currentParams
    );

    const conditions: string[] = ['o.dining_table_id IS NOT NULL'];
    const params: any[] = [];
    if (filters.dateFrom) {
      conditions.push('DATE(o.created_at) >= DATE(?)');
      params.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      conditions.push('DATE(o.created_at) <= DATE(?)');
      params.push(filters.dateTo);
    }
    if (filters.userId) {
      conditions.push('o.created_by = ?');
      params.push(filters.userId);
    }

    const history = await dbService.query<any>(
      `SELECT o.id AS order_id, o.order_number, o.status AS order_status, o.total_amount,
              o.created_at, h.completed_at,
              t.id AS table_id, t.table_number, t.name AS table_name, t.section,
              u.id AS staff_id, u.name AS staff_name, u.username AS staff_username,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
       FROM orders o
       JOIN dining_tables t ON o.dining_table_id = t.id
       LEFT JOIN users u    ON o.created_by = u.id
       LEFT JOIN (
         SELECT order_id, MIN(created_at) AS completed_at
         FROM order_status_history
         WHERE new_status IN ('COMPLETED', 'CANCELLED')
         GROUP BY order_id
       ) h ON h.order_id = o.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY o.created_at DESC
       LIMIT 500`,
      params
    );

    const perStaff = await dbService.query<any>(
      `SELECT u.id, u.name, u.username, u.image_url, r.name AS role_name,
              COUNT(DISTINCT o.dining_table_id) AS tables_attended,
              COUNT(o.id) AS table_orders,
              COALESCE(SUM(o.total_amount), 0) AS table_revenue,
              AVG(TIMESTAMPDIFF(SECOND, o.created_at, h.completed_at)) AS avg_table_seconds
       FROM orders o
       JOIN users u ON o.created_by = u.id
       JOIN roles r ON u.role_id = r.id
       LEFT JOIN (
         SELECT order_id, MIN(created_at) AS completed_at
         FROM order_status_history
         WHERE new_status IN ('COMPLETED', 'CANCELLED')
         GROUP BY order_id
       ) h ON h.order_id = o.id
       WHERE ${conditions.join(' AND ')}
       GROUP BY u.id, u.name, u.username, u.image_url, r.name
       ORDER BY tables_attended DESC`,
      params
    );

    return {
      currentTables: current.map((t) => ({
        tableId: t.id,
        tableNumber: t.table_number,
        tableName: t.name,
        section: t.section,
        capacity: t.capacity,
        status: t.status,
        itemCount: Number(t.item_count || 0),
        order: t.order_id
          ? {
              orderId: t.order_id,
              orderNumber: t.order_number,
              status: t.order_status,
              totalAmount: Number(t.total_amount || 0),
              openedAt: t.order_created_at,
              lastActivityAt: t.order_updated_at,
              openSeconds: Math.max(
                0,
                Math.round((Date.now() - new Date(t.order_created_at).getTime()) / 1000)
              ),
            }
          : null,
        attendingStaff: this.staffRef(t.staff_id, t.staff_name, t.staff_username, t.staff_role),
        attendingStaffImageUrl: t.staff_image_url || null,
        attributionBasis: t.staff_id ? 'ORDER_CREATED_BY' : 'NONE',
      })),
      tableHistory: history.map((h) => ({
        orderId: h.order_id,
        orderNumber: h.order_number,
        orderStatus: h.order_status,
        totalAmount: Number(h.total_amount || 0),
        itemCount: Number(h.item_count || 0),
        table: { id: h.table_id, tableNumber: h.table_number, name: h.table_name, section: h.section },
        staff: this.staffRef(h.staff_id, h.staff_name, h.staff_username),
        openedAt: h.created_at,
        closedAt: h.completed_at || null,
        durationSeconds: h.completed_at
          ? Math.max(0, Math.round((new Date(h.completed_at).getTime() - new Date(h.created_at).getTime()) / 1000))
          : null,
        attributionBasis: h.staff_id ? 'ORDER_CREATED_BY' : 'NONE',
      })),
      perStaff: perStaff.map((s) => ({
        id: s.id,
        name: s.name,
        username: s.username,
        imageUrl: s.image_url || null,
        roleName: s.role_name,
        tablesAttended: Number(s.tables_attended || 0),
        tableOrders: Number(s.table_orders || 0),
        tableRevenue: Number(s.table_revenue || 0),
        averageTableSeconds:
          s.avg_table_seconds === null || s.avg_table_seconds === undefined
            ? null
            : Math.round(Number(s.avg_table_seconds)),
      })),
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Activity history
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Straight off `audit_logs`, the POS's own activity record. Order and bill
   * numbers are resolved with two batched lookups over the current page rather
   * than a join on `record_id` — that column is a string, so joining it to an
   * integer key would cast every row and drop the index.
   */
  static async getActivity(
    filters: StaffTrackFilters & { module?: string; action?: string },
    page = 1,
    limit = 50
  ) {
    const offset = (page - 1) * limit;
    const conditions: string[] = ['1=1'];
    const params: any[] = [];

    if (filters.dateFrom) {
      conditions.push('DATE(a.created_at) >= DATE(?)');
      params.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      conditions.push('DATE(a.created_at) <= DATE(?)');
      params.push(filters.dateTo);
    }
    if (filters.userId) {
      conditions.push('a.user_id = ?');
      params.push(filters.userId);
    }
    if (filters.roleId) {
      conditions.push('u.role_id = ?');
      params.push(filters.roleId);
    }
    if (filters.module) {
      conditions.push('a.module = ?');
      params.push(filters.module);
    }
    if (filters.action) {
      conditions.push('a.action LIKE ?');
      params.push(`%${filters.action}%`);
    }
    if (filters.search) {
      conditions.push('(u.name LIKE ? OR a.action LIKE ?)');
      params.push(`%${filters.search}%`, `%${filters.search}%`);
    }

    const whereSql = `WHERE ${conditions.join(' AND ')}`;

    const countRes = await dbService.queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total
       FROM audit_logs a
       LEFT JOIN users u ON a.user_id = u.id
       ${whereSql}`,
      params
    );
    const total = Number(countRes?.total || 0);

    const rows = await dbService.query<any>(
      `SELECT a.id, a.action, a.module, a.record_id, a.created_at,
              u.id AS actor_id, u.name AS actor_name, u.username AS actor_username,
              r.name AS actor_role
       FROM audit_logs a
       LEFT JOIN users u ON a.user_id = u.id
       LEFT JOIN roles r ON u.role_id = r.id
       ${whereSql}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const numericId = (v: any) => (/^\d+$/.test(String(v || '')) ? Number(v) : null);

    const orderIds = [
      ...new Set(rows.filter((r) => r.module === 'ORDERS').map((r) => numericId(r.record_id)).filter(Boolean)),
    ] as number[];
    const billIds = [
      ...new Set(
        rows
          .filter((r) => r.module === 'CHECKOUT' || r.module === 'BILLS')
          .map((r) => numericId(r.record_id))
          .filter(Boolean)
      ),
    ] as number[];

    const orderMap = new Map<number, string>();
    if (orderIds.length) {
      const os = await dbService.query<any>(
        `SELECT id, order_number FROM orders WHERE id IN (${orderIds.map(() => '?').join(',')})`,
        orderIds
      );
      os.forEach((o) => orderMap.set(Number(o.id), o.order_number));
    }

    const billMap = new Map<number, { billNumber: string; amount: number }>();
    if (billIds.length) {
      const bs = await dbService.query<any>(
        `SELECT id, bill_number, total_amount FROM bills WHERE id IN (${billIds.map(() => '?').join(',')})`,
        billIds
      );
      bs.forEach((b) => billMap.set(Number(b.id), { billNumber: b.bill_number, amount: Number(b.total_amount || 0) }));
    }

    const data: ActivityEntry[] = rows.map((r) => {
      const rid = numericId(r.record_id);
      const bill = rid && (r.module === 'CHECKOUT' || r.module === 'BILLS') ? billMap.get(rid) : undefined;
      return {
        id: r.id,
        at: r.created_at,
        actor: this.staffRef(r.actor_id, r.actor_name, r.actor_username, r.actor_role),
        action: r.action,
        module: r.module,
        recordId: r.record_id || null,
        orderNumber: rid && r.module === 'ORDERS' ? orderMap.get(rid) || null : null,
        billNumber: bill?.billNumber || null,
        amount: bill?.amount ?? null,
      };
    });

    return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 } };
  }

  /** Distinct modules and actions present in the log, for populating filters. */
  static async getActivityFacets() {
    const modules = await dbService.query<{ module: string }>(
      'SELECT DISTINCT module FROM audit_logs ORDER BY module ASC'
    );
    const actions = await dbService.query<{ action: string }>(
      'SELECT DISTINCT action FROM audit_logs ORDER BY action ASC'
    );
    return {
      modules: modules.map((m) => m.module),
      actions: actions.map((a) => a.action),
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Reports
  // ───────────────────────────────────────────────────────────────────────

  static async getOrdersReport(filters: StaffTrackFilters) {
    const conditions: string[] = ['o.created_by IS NOT NULL'];
    const params: any[] = [];
    if (filters.dateFrom) {
      conditions.push('DATE(o.created_at) >= DATE(?)');
      params.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      conditions.push('DATE(o.created_at) <= DATE(?)');
      params.push(filters.dateTo);
    }
    if (filters.userId) {
      conditions.push('o.created_by = ?');
      params.push(filters.userId);
    }
    if (filters.roleId) {
      conditions.push('u.role_id = ?');
      params.push(filters.roleId);
    }

    const rows = await dbService.query<any>(
      `SELECT u.id, u.name, u.username, r.name AS role_name,
              COUNT(*) AS orders_taken,
              COALESCE(SUM(o.status = 'COMPLETED'), 0)   AS completed_orders,
              COALESCE(SUM(o.status = 'CANCELLED'), 0)   AS cancelled_orders,
              COALESCE(SUM(o.status = 'PENDING'), 0)     AS pending_orders,
              COALESCE(SUM(o.status = 'IN_PROGRESS'), 0) AS in_progress_orders,
              COALESCE(SUM(o.total_amount), 0)           AS order_value
       FROM orders o
       JOIN users u ON o.created_by = u.id
       JOIN roles r ON u.role_id = r.id
       WHERE ${conditions.join(' AND ')}
       GROUP BY u.id, u.name, u.username, r.name
       ORDER BY orders_taken DESC`,
      params
    );

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      username: r.username,
      roleName: r.role_name,
      ordersTaken: Number(r.orders_taken || 0),
      completedOrders: Number(r.completed_orders || 0),
      cancelledOrders: Number(r.cancelled_orders || 0),
      pendingOrders: Number(r.pending_orders || 0),
      inProgressOrders: Number(r.in_progress_orders || 0),
      orderValue: Number(r.order_value || 0),
      averageOrderValue:
        Number(r.orders_taken) > 0
          ? Math.round((Number(r.order_value) / Number(r.orders_taken)) * 100) / 100
          : 0,
    }));
  }

  static async getActivityReport(filters: StaffTrackFilters & { module?: string }) {
    const conditions: string[] = ['a.user_id IS NOT NULL'];
    const params: any[] = [];
    if (filters.dateFrom) {
      conditions.push('DATE(a.created_at) >= DATE(?)');
      params.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      conditions.push('DATE(a.created_at) <= DATE(?)');
      params.push(filters.dateTo);
    }
    if (filters.userId) {
      conditions.push('a.user_id = ?');
      params.push(filters.userId);
    }
    if (filters.roleId) {
      conditions.push('u.role_id = ?');
      params.push(filters.roleId);
    }
    if (filters.module) {
      conditions.push('a.module = ?');
      params.push(filters.module);
    }

    const rows = await dbService.query<any>(
      `SELECT u.id, u.name, u.username, r.name AS role_name,
              a.module, a.action, COUNT(*) AS activity_count,
              MAX(a.created_at) AS last_at
       FROM audit_logs a
       JOIN users u ON a.user_id = u.id
       JOIN roles r ON u.role_id = r.id
       WHERE ${conditions.join(' AND ')}
       GROUP BY u.id, u.name, u.username, r.name, a.module, a.action
       ORDER BY u.name ASC, activity_count DESC`,
      params
    );

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      username: r.username,
      roleName: r.role_name,
      module: r.module,
      action: r.action,
      count: Number(r.activity_count || 0),
      lastAt: r.last_at,
    }));
  }

  /** Daily / weekly / monthly rollup driven by the same bills and orders data. */
  static async getSummaryReport(period: 'daily' | 'weekly' | 'monthly', filters: StaffTrackFilters) {
    const bucket =
      period === 'daily'
        ? 'DATE(b.created_at)'
        : period === 'weekly'
        ? "DATE_FORMAT(b.created_at, '%x-W%v')"
        : "DATE_FORMAT(b.created_at, '%Y-%m')";

    const orderBucket =
      period === 'daily'
        ? 'DATE(o.created_at)'
        : period === 'weekly'
        ? "DATE_FORMAT(o.created_at, '%x-W%v')"
        : "DATE_FORMAT(o.created_at, '%Y-%m')";

    const billConditions: string[] = ['1=1'];
    const billParams: any[] = [];
    const orderConditions: string[] = ['o.created_by IS NOT NULL'];
    const orderParams: any[] = [];

    if (filters.dateFrom) {
      billConditions.push('DATE(b.created_at) >= DATE(?)');
      billParams.push(filters.dateFrom);
      orderConditions.push('DATE(o.created_at) >= DATE(?)');
      orderParams.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      billConditions.push('DATE(b.created_at) <= DATE(?)');
      billParams.push(filters.dateTo);
      orderConditions.push('DATE(o.created_at) <= DATE(?)');
      orderParams.push(filters.dateTo);
    }
    if (filters.userId) {
      billConditions.push('b.cashier_id = ?');
      billParams.push(filters.userId);
      orderConditions.push('o.created_by = ?');
      orderParams.push(filters.userId);
    }

    const revenueRows = await dbService.query<any>(
      `SELECT ${bucket} AS bucket,
              COUNT(b.id) AS bills_count,
              COALESCE(SUM(b.subtotal), 0) AS gross_sales,
              COALESCE(SUM(b.discount_amount), 0) AS discount_amount,
              COALESCE(SUM(b.tax_amount), 0) AS tax_amount,
              COALESCE(SUM(b.total_amount), 0) AS net_revenue
       FROM bills b
       WHERE ${billConditions.join(' AND ')}
       GROUP BY bucket
       ORDER BY bucket DESC`,
      billParams
    );

    const orderRows = await dbService.query<any>(
      `SELECT ${orderBucket} AS bucket,
              COUNT(*) AS orders_taken,
              COALESCE(SUM(o.status = 'COMPLETED'), 0) AS completed_orders,
              COALESCE(SUM(o.status = 'CANCELLED'), 0) AS cancelled_orders,
              COUNT(DISTINCT o.created_by) AS active_staff,
              COUNT(DISTINCT o.dining_table_id) AS tables_served
       FROM orders o
       WHERE ${orderConditions.join(' AND ')}
       GROUP BY bucket
       ORDER BY bucket DESC`,
      orderParams
    );

    const merged = new Map<string, any>();
    for (const r of revenueRows) {
      merged.set(String(r.bucket), {
        bucket: String(r.bucket),
        billsCount: Number(r.bills_count || 0),
        grossSales: Number(r.gross_sales || 0),
        discountAmount: Number(r.discount_amount || 0),
        taxAmount: Number(r.tax_amount || 0),
        netRevenue: Number(r.net_revenue || 0),
        ordersTaken: 0,
        completedOrders: 0,
        cancelledOrders: 0,
        activeStaff: 0,
        tablesServed: 0,
      });
    }
    for (const r of orderRows) {
      const key = String(r.bucket);
      const existing = merged.get(key) || {
        bucket: key,
        billsCount: 0,
        grossSales: 0,
        discountAmount: 0,
        taxAmount: 0,
        netRevenue: 0,
      };
      merged.set(key, {
        ...existing,
        ordersTaken: Number(r.orders_taken || 0),
        completedOrders: Number(r.completed_orders || 0),
        cancelledOrders: Number(r.cancelled_orders || 0),
        activeStaff: Number(r.active_staff || 0),
        tablesServed: Number(r.tables_served || 0),
      });
    }

    return [...merged.values()].sort((a, b) => (a.bucket < b.bucket ? 1 : -1));
  }

  /**
   * Roles list for the filter bar — reuses the existing roles table.
   *
   * The staff list is scoped too. Leaving it whole would have handed a
   * self-scoped viewer the full roster of names and usernames through the
   * filter dropdown, which is the disclosure the scoping exists to prevent
   * even though the figures behind it stay hidden. Roles and tables are not
   * personal data and stay whole so the date and table filters keep working.
   */
  static async getFilterOptions(scope: StaffTrackScope = { kind: 'ALL' }) {
    const roles = await dbService.query<{ id: number; name: string }>(
      'SELECT id, name FROM roles ORDER BY name ASC'
    );
    const staffScope = scopeClause(scope, 'id');
    const staff = await dbService.query<{ id: number; name: string; username: string }>(
      `SELECT id, name, username FROM users WHERE 1=1${staffScope.sql} ORDER BY name ASC`,
      staffScope.params
    );
    const tables = await dbService.query<{ id: number; table_number: string; name: string }>(
      'SELECT id, table_number, name FROM dining_tables ORDER BY display_order ASC, table_number ASC'
    );
    return { roles, staff, tables };
  }
}
