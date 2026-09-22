// SUPER_ADMIN is not a row in `roles` — it is what a user with no `role_id`
// resolves to. See core/utils/role.util.ts.
export type RoleName = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'CASHIER' | 'STAFF';

/**
 * The two ways an order leaves the counter.
 *
 * Walk-in, pickup and counter were separate values once. They described how
 * the customer arrived rather than how the order is served, and nothing in
 * the kitchen, the receipt or the reports ever treated them differently, so
 * they are all TAKEAWAY now. DINING keeps its original spelling because it is
 * the value already written to every dine-in row in every deployed database.
 */
export type OrderType = 'DINING' | 'TAKEAWAY';

export type OrderStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export type TableStatus = 'AVAILABLE' | 'SELECTED' | 'OCCUPIED' | 'RESERVED' | 'CLEANING' | 'UNAVAILABLE';

export type PaymentMethod = 'CASH' | 'CARD' | 'UPI' | 'ONLINE' | 'OTHER';

export type PaymentStatus = 'PAID' | 'PENDING' | 'FAILED' | 'REFUNDED' | 'VOIDED';

export type StockTransactionType = 'STOCK_IN' | 'SALE' | 'ADJUSTMENT' | 'RETURN';

export type StockUnitType = 'piece' | 'kg' | 'liter' | 'gram' | 'box' | 'packet' | 'portion' | 'other';
export type StockEntryStatus = 'draft' | 'posted' | 'cancelled';
export type StockMovementType = 'in' | 'out' | 'adjustment' | 'return' | 'wastage' | 'transfer_in' | 'transfer_out';

export interface StockItemModel {
  id: number;
  uuid: string;
  stock_code: string;
  name: string;
  unit_type: StockUnitType;
  current_quantity: number;
  current_value: number;
  average_unit_price: number;
  status: 'active' | 'inactive';
  min_stock_alert: number;
  product_id?: number | null;
  product_name?: string;
  sku?: string;
  category_name?: string;
  created_at: string;
  updated_at: string;
}

export interface StockEntryModel {
  id: number;
  uuid: string;
  stock_item_id: number;
  stock_item_name?: string;
  stock_code?: string;
  unit_type?: StockUnitType;
  entry_number: string;
  entry_date: string;
  quantity: number;
  multiplier: number;
  total_quantity: number;
  total_price: number;
  unit_price: number;
  status: StockEntryStatus;
  supplier?: string | null;
  invoice_number?: string | null;
  notes?: string | null;
  created_by?: number | null;
  created_by_name?: string;
  created_at: string;
  updated_at: string;
}

export interface StockMovementModel {
  id: number;
  uuid: string;
  stock_item_id: number;
  stock_item_name?: string;
  stock_code?: string;
  unit_type?: StockUnitType;
  movement_type: StockMovementType;
  reference_type: string;
  reference_id?: string | null;
  quantity: number;
  unit_price: number;
  total_value: number;
  balance_quantity: number;
  balance_value: number;
  movement_date: string;
  notes?: string | null;
  created_by?: number | null;
  created_by_name?: string;
  created_at: string;
}

export type QueueStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export interface UserPayload {
  id: number;
  username: string;
  email: string;
  name: string;
  role: RoleName;
  permissions: string[];
}

export interface PaginationParams {
  page?: number;
  limit?: number;
  search?: string;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  data?: T;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  error?: {
    code: string;
    details?: any;
  };
}
