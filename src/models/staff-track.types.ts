/**
 * Staff Track — read-only analytics layer over data the POS already records.
 *
 * Nothing in this module writes. Every figure below is traceable to an existing
 * column, and the shapes deliberately keep the three kinds of staff involvement
 * apart, because the checkout flow proves they can be different people: when a
 * bill is raised against an existing order, the order keeps the `created_by` of
 * the waiter who took it while the bill records the `cashier_id` of whoever
 * settled it. Collapsing those into one "staff" number would credit the wrong
 * person, so `ordersTaken` (orders.created_by), `revenue` (bills.cashier_id)
 * and the lifecycle actors (order_status_history.changed_by) never mix.
 */

/** Fields the POS does not record, kept here so the UI can say so explicitly. */
export const UNTRACKED_BY_SYSTEM = [
  'department',
  'branch',
  'shift',
  'logout',
  'tableAssignment',
  'tableTransfer',
  'refund',
  'void',
  'orderModification',
] as const;

export interface StaffTrackFilters {
  dateFrom?: string;
  dateTo?: string;
  userId?: number;
  roleId?: number;
  status?: string;
  search?: string;
}

/** A user plus the metrics that can be attributed to them for a date window. */
export interface StaffTrackRow {
  id: number;
  name: string;
  username: string;
  email: string;
  imageUrl: string | null;
  roleName: string;
  status: string;
  lastLoginAt: string | null;
  lastActivityAt: string | null;
  currentActivity: StaffCurrentActivity | null;

  /** orders.created_by — the staff member who took the order. */
  ordersTaken: number;
  completedOrders: number;
  cancelledOrders: number;
  pendingOrders: number;
  inProgressOrders: number;
  orderValue: number;
  averageOrderValue: number;
  itemsHandled: number;

  /** bills.cashier_id — the staff member who settled the transaction. */
  revenue: number;
  billsSettled: number;
  grossSales: number;
  discountAmount: number;
  taxAmount: number;

  /** dining_tables joined through the table's current order. */
  activeTables: number;
  tablesAttended: number;

  /** order_status_history: created_at → COMPLETED, in seconds. */
  averageServiceSeconds: number | null;
}

export interface StaffCurrentActivity {
  action: string;
  module: string;
  recordId: string | null;
  at: string;
}

/**
 * Who did what to one order. Every field is either a real column or null —
 * a null means the POS never recorded that actor, not that nobody acted.
 */
export interface OrderAttribution {
  orderId: number;
  orderNumber: string;
  createdBy: StaffRef | null;
  startedBy: StaffRef | null;
  completedBy: StaffRef | null;
  cancelledBy: StaffRef | null;
  paymentBy: StaffRef | null;
}

export interface StaffRef {
  id: number;
  name: string;
  username: string;
  roleName?: string;
  at?: string;
}

export interface OrderTimelineEntry {
  at: string;
  actor: StaffRef | null;
  action: string;
  source: 'ORDER' | 'ORDER_STATUS_HISTORY' | 'BILL' | 'PAYMENT' | 'AUDIT';
  detail?: string | null;
}

export interface ActivityEntry {
  id: number;
  at: string;
  actor: StaffRef | null;
  action: string;
  module: string;
  recordId: string | null;
  orderNumber?: string | null;
  billNumber?: string | null;
  amount?: number | null;
}
