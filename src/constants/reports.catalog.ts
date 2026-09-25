/**
 * Index of the reporting suite, served at `GET /api/reports/catalog`.
 *
 * It exists so the reports screen can build its navigation, filter controls
 * and permission gating from the API instead of keeping a second hardcoded
 * copy of this list in the Angular app — which is how the two drift apart.
 *
 * `filters` names the query parameters each report honours beyond the window
 * (`dateFrom`, `dateTo`, `preset`), which every report accepts.
 */

export interface ReportCatalogEntry {
  key: string;
  name: string;
  path: string;
  description: string;
  permission: string;
  filters: string[];
  /** Absent when the report is a point-in-time snapshot rather than a window. */
  ranged: boolean;
}

export interface ReportCatalogGroup {
  key: string;
  name: string;
  reports: ReportCatalogEntry[];
}

const BILL_FILTERS = ['paymentMethod', 'orderType', 'cashierId', 'customerId', 'includeVoided'];
const GRANULARITY = ['granularity (day|week|month)'];

export const REPORT_CATALOG: {
  presets: string[];
  commonFilters: string[];
  groups: ReportCatalogGroup[];
} = {
  presets: [
    'today',
    'yesterday',
    'last7',
    'last30',
    'last90',
    'thisWeek',
    'thisMonth',
    'lastMonth',
    'thisYear',
    'custom',
  ],
  commonFilters: ['dateFrom', 'dateTo', 'preset'],
  groups: [
    {
      key: 'sales',
      name: 'Sales Reports',
      reports: [
        {
          key: 'sales.products',
          name: 'Sales by product',
          path: '/api/reports/sales/products',
          description: 'Units, revenue, cost and margin per product, optionally split by portion variant.',
          permission: 'report.view',
          filters: [...BILL_FILTERS, 'categoryId', 'limit', 'groupBy (product|variant)'],
          ranged: true,
        },
        {
          key: 'sales.categories',
          name: 'Sales by category',
          path: '/api/reports/sales/categories',
          description: 'Revenue, units and margin per category with share of trade.',
          permission: 'report.view',
          filters: BILL_FILTERS,
          ranged: true,
        },
        {
          key: 'sales.employees',
          name: 'Sales by employee',
          path: '/api/reports/sales/employees',
          description: 'Takings per cashier with voids, discounts given and average bill value.',
          permission: 'report.view',
          filters: BILL_FILTERS,
          ranged: true,
        },
        {
          key: 'sales.hourly',
          name: 'Sales by hour',
          path: '/api/reports/sales/hourly',
          description: 'Trade by hour of day across the window, including dead hours.',
          permission: 'report.view',
          filters: BILL_FILTERS,
          ranged: true,
        },
        {
          key: 'sales.orderTypes',
          name: 'Sales by order type',
          path: '/api/reports/sales/order-types',
          description: 'Dine-in, takeaway and walk-in split with basket size per channel.',
          permission: 'report.view',
          filters: BILL_FILTERS,
          ranged: true,
        },
        {
          key: 'sales.daily',
          name: 'Daily sales',
          path: '/api/reports/sales/daily',
          description: 'Day-by-day takings with every calendar day present, plus best and worst day.',
          permission: 'report.view',
          filters: BILL_FILTERS,
          ranged: true,
        },
        {
          key: 'sales.monthly',
          name: 'Monthly sales',
          path: '/api/reports/sales/monthly',
          description: 'Month-by-month takings with month-on-month growth.',
          permission: 'report.view',
          filters: BILL_FILTERS,
          ranged: true,
        },
        {
          key: 'sales.trends',
          name: 'Sales trends',
          path: '/api/reports/sales/trends',
          description: 'This window against the equal window before it, with both series overlaid.',
          permission: 'report.view',
          filters: [...BILL_FILTERS, ...GRANULARITY],
          ranged: true,
        },
      ],
    },
    {
      key: 'finance',
      name: 'Finance Reports',
      reports: [
        {
          key: 'finance.revenue',
          name: 'Revenue',
          path: '/api/reports/finance/revenue',
          description: 'Gross to net waterfall with refunds, charges and period-on-period growth.',
          permission: 'report.view',
          filters: [...BILL_FILTERS, ...GRANULARITY],
          ranged: true,
        },
        {
          key: 'finance.tax',
          name: 'Tax',
          path: '/api/reports/finance/tax',
          description: 'Tax collected by rate, order type and period, with taxable value.',
          permission: 'report.view',
          filters: [...BILL_FILTERS, ...GRANULARITY],
          ranged: true,
        },
        {
          key: 'finance.discounts',
          name: 'Discounts',
          path: '/api/reports/finance/discounts',
          description: 'Bill, coupon and line discounts plus complimentary items, by cashier and product.',
          permission: 'report.view',
          filters: [...BILL_FILTERS, ...GRANULARITY],
          ranged: true,
        },
        {
          key: 'finance.refunds',
          name: 'Refunds',
          path: '/api/reports/finance/refunds',
          description: 'Refunds issued by reason, method, product and operator, with refund rate.',
          permission: 'report.view',
          filters: [...GRANULARITY, 'status', 'reasonCode'],
          ranged: true,
        },
        {
          key: 'finance.paymentMethods',
          name: 'Payment methods',
          path: '/api/reports/finance/payment-methods',
          description: 'Tender split from the payments ledger, with cash share and bill reconciliation.',
          permission: 'report.view',
          filters: [...BILL_FILTERS, ...GRANULARITY],
          ranged: true,
        },
        {
          key: 'finance.expenses',
          name: 'Expenses',
          path: '/api/reports/finance/expenses',
          description: 'Operating spend by category, vendor, method and fixed-vs-variable split.',
          permission: 'report.view',
          filters: ['category', 'paymentMethod', 'vendorId', 'includePending'],
          ranged: true,
        },
        {
          key: 'finance.profit',
          name: 'Profit',
          path: '/api/reports/finance/profit',
          description: 'Net revenue less cost of goods sold less expenses, with margins and break-even.',
          permission: 'report.view',
          filters: [...BILL_FILTERS, ...GRANULARITY],
          ranged: true,
        },
      ],
    },
    {
      key: 'inventory',
      name: 'Inventory Reports',
      reports: [
        {
          key: 'inventory.valuation',
          name: 'Stock valuation',
          path: '/api/reports/inventory/valuation',
          description: 'Current stock at cost and retail with potential margin. Point-in-time.',
          permission: 'report.view',
          filters: ['categoryId', 'lowStockOnly', 'includeInactive'],
          ranged: false,
        },
        {
          key: 'inventory.movement',
          name: 'Stock movement',
          path: '/api/reports/inventory/movement',
          description: 'Inflow, outflow and net change per item with reconstructed opening balance.',
          permission: 'report.view',
          filters: ['stockItemId', 'categoryId', ...GRANULARITY],
          ranged: true,
        },
        {
          key: 'inventory.wastage',
          name: 'Wastage',
          path: '/api/reports/inventory/wastage',
          description: 'Stock written off by item, reason and operator, as a share of outflow.',
          permission: 'report.view',
          filters: ['stockItemId', 'categoryId', ...GRANULARITY],
          ranged: true,
        },
        {
          key: 'inventory.purchases',
          name: 'Purchase',
          path: '/api/reports/inventory/purchases',
          description: 'Stock purchases by item and supplier with unit-price spread and vendor invoices.',
          permission: 'report.view',
          filters: ['stockItemId', ...GRANULARITY, 'limit'],
          ranged: true,
        },
        {
          key: 'inventory.consumption',
          name: 'Consumption',
          path: '/api/reports/inventory/consumption',
          description: 'Booked depletion against sales-implied depletion, with days of cover per item.',
          permission: 'report.view',
          filters: ['stockItemId', 'categoryId', ...GRANULARITY],
          ranged: true,
        },
        {
          key: 'inventory.foodCost',
          name: 'Food cost',
          path: '/api/reports/inventory/food-cost',
          description: 'Recipe and purchase food cost percentages overall, by category and by product.',
          permission: 'report.view',
          filters: ['categoryId', ...GRANULARITY, 'limit'],
          ranged: true,
        },
        {
          key: 'inventory.variance',
          name: 'Inventory variance',
          path: '/api/reports/inventory/variance',
          description: 'Master stock balance against its own movement ledger. Whole-history, not ranged.',
          permission: 'report.view',
          filters: ['stockItemId', 'onlyDiscrepancies', 'tolerance'],
          ranged: false,
        },
        {
          key: 'inventory.adjustments',
          name: 'Stock adjustment',
          path: '/api/reports/inventory/adjustments',
          description: 'Manual stock corrections by item, reason and operator, excluding wastage.',
          permission: 'report.view',
          filters: ['stockItemId', 'categoryId', ...GRANULARITY, 'limit'],
          ranged: true,
        },
      ],
    },
    {
      key: 'bi',
      name: 'Business Intelligence',
      reports: [
        {
          key: 'bi.productPerformance',
          name: 'Product performance',
          path: '/api/reports/bi/product-performance',
          description: 'Menu engineering: every product classified star, ploughhorse, puzzle or dog.',
          permission: 'report.view',
          filters: [...BILL_FILTERS, 'limit'],
          ranged: true,
        },
        {
          key: 'bi.customerAnalytics',
          name: 'Customer analytics',
          path: '/api/reports/bi/customer-analytics',
          description: 'Identified versus anonymous trade, top and lapsed customers, visit frequency.',
          permission: 'report.view',
          filters: [...BILL_FILTERS, 'limit'],
          ranged: true,
        },
        {
          key: 'bi.salesTrends',
          name: 'Sales trends',
          path: '/api/reports/bi/sales-trends',
          description: 'Same as the sales trends report, served under the BI group.',
          permission: 'report.view',
          filters: [...BILL_FILTERS, ...GRANULARITY],
          ranged: true,
        },
        {
          key: 'bi.peakHours',
          name: 'Peak hours',
          path: '/api/reports/bi/peak-hours',
          description: 'Day-of-week by hour grid with ranked peak slots, averaged per occurrence.',
          permission: 'report.view',
          filters: [...BILL_FILTERS, 'limit'],
          ranged: true,
        },
        {
          key: 'bi.averageOrderValue',
          name: 'Average order value',
          path: '/api/reports/bi/average-order-value',
          description: 'Basket size by channel, operator and period, with the value distribution.',
          permission: 'report.view',
          filters: [...BILL_FILTERS, ...GRANULARITY],
          ranged: true,
        },
        {
          key: 'bi.repeatCustomers',
          name: 'Repeat customers',
          path: '/api/reports/bi/repeat-customers',
          description: 'In-window and lifetime repeat rates, visit cohorts and top returners.',
          permission: 'report.view',
          filters: [...BILL_FILTERS, 'limit'],
          ranged: true,
        },
        {
          key: 'bi.dashboardKpis',
          name: 'Dashboard KPIs',
          path: '/api/reports/bi/dashboard-kpis',
          description: 'One headline panel over the window: revenue, profit, basket, customers, stock.',
          permission: 'report.view',
          filters: [...BILL_FILTERS, ...GRANULARITY],
          ranged: true,
        },
        {
          key: 'bi.employeePerformance',
          name: 'Employee performance',
          path: '/api/reports/bi/employee-performance',
          description: 'Throughput per operator: bills and sales per active hour, voids, refunds, discounts.',
          permission: 'report.view',
          filters: [...BILL_FILTERS, 'limit'],
          ranged: true,
        },
      ],
    },
  ],
};
