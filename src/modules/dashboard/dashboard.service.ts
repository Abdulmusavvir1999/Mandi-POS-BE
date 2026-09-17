import { dbService } from '../../database/db';

export class DashboardService {
  static async getMetrics() {
    // 1. Today's & Lifetime Financials
    const financialStats = await dbService.queryOne<{
      today_sales: number;
      today_bills_count: number;
      today_tax: number;
      today_discount: number;
      all_time_sales: number;
      all_time_bills_count: number;
    }>(
      `SELECT
         COALESCE(SUM(CASE WHEN DATE(created_at) = CURDATE() THEN total_amount ELSE 0 END), 0) as today_sales,
         COALESCE(SUM(CASE WHEN DATE(created_at) = CURDATE() THEN 1 ELSE 0 END), 0) as today_bills_count,
         COALESCE(SUM(CASE WHEN DATE(created_at) = CURDATE() THEN tax_amount ELSE 0 END), 0) as today_tax,
         COALESCE(SUM(CASE WHEN DATE(created_at) = CURDATE() THEN discount_amount ELSE 0 END), 0) as today_discount,
         COALESCE(SUM(total_amount), 0) as all_time_sales,
         COUNT(id) as all_time_bills_count
       FROM bills`
    );

    // 2. Order Statistics (Today + All-time)
    const orderStats = await dbService.queryOne<{
      today_orders: number;
      pending_orders: number;
      in_progress_orders: number;
      completed_orders: number;
      cancelled_orders: number;
      dine_in_orders: number;
      takeaway_orders: number;
      walk_in_orders: number;
      all_time_orders: number;
    }>(
      `SELECT
         COALESCE(SUM(CASE WHEN DATE(created_at) = CURDATE() THEN 1 ELSE 0 END), 0) as today_orders,
         COALESCE(SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END), 0) as pending_orders,
         COALESCE(SUM(CASE WHEN status = 'IN_PROGRESS' THEN 1 ELSE 0 END), 0) as in_progress_orders,
         COALESCE(SUM(CASE WHEN status = 'COMPLETED' AND (DATE(created_at) = CURDATE()) THEN 1 ELSE 0 END), 0) as completed_orders,
         COALESCE(SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END), 0) as cancelled_orders,
         COALESCE(SUM(CASE WHEN order_type = 'DINING' THEN 1 ELSE 0 END), 0) as dine_in_orders,
         COALESCE(SUM(CASE WHEN order_type = 'TAKEAWAY' THEN 1 ELSE 0 END), 0) as takeaway_orders,
         COALESCE(SUM(CASE WHEN order_type = 'WALK_IN' THEN 1 ELSE 0 END), 0) as walk_in_orders,
         COUNT(id) as all_time_orders
       FROM orders`
    );

    // 3. Table Occupancy
    const tableStats = await dbService.queryOne<{
      total_tables: number;
      occupied_tables: number;
      available_tables: number;
      selected_tables: number;
    }>(
      `SELECT
         COUNT(id) as total_tables,
         COALESCE(SUM(CASE WHEN status = 'OCCUPIED' THEN 1 ELSE 0 END), 0) as occupied_tables,
         COALESCE(SUM(CASE WHEN status = 'AVAILABLE' THEN 1 ELSE 0 END), 0) as available_tables,
         COALESCE(SUM(CASE WHEN status = 'SELECTED' THEN 1 ELSE 0 END), 0) as selected_tables
       FROM dining_tables`
    );

    // 4. Low Stock & Product Count
    const stockStats = await dbService.queryOne<{
      low_stock_count: number;
      out_of_stock_count: number;
      total_products: number;
    }>(
      `SELECT
         COALESCE(SUM(CASE WHEN p.status = 'ACTIVE' AND s.current_stock <= s.min_stock_alert AND s.current_stock > 0 THEN 1 ELSE 0 END), 0) as low_stock_count,
         COALESCE(SUM(CASE WHEN p.status = 'ACTIVE' AND s.current_stock <= 0 THEN 1 ELSE 0 END), 0) as out_of_stock_count,
         COUNT(p.id) as total_products
       FROM products p
       LEFT JOIN stock s ON p.id = s.product_id
       WHERE p.status = 'ACTIVE'`
    );

    // 5. Customer Metrics
    const customerStats = await dbService.queryOne<{ total_customers: number }>(
      `SELECT COUNT(id) as total_customers FROM customers WHERE status = 'ACTIVE'`
    );

    // 6. Active Kitchen Queue Tokens
    const queueStats = await dbService.queryOne<{ active_tokens: number }>(
      `SELECT COUNT(id) as active_tokens FROM queue WHERE status IN ('PENDING', 'IN_PROGRESS')`
    );

    // 7. Sales by Category
    const categorySales = await dbService.query(
      `SELECT c.id, c.name as category_name, c.icon,
              COALESCE(SUM(bi.quantity), 0) as total_quantity,
              COALESCE(SUM(bi.total_amount), 0) as total_revenue
       FROM categories c
       LEFT JOIN products p ON c.id = p.category_id
       LEFT JOIN bill_items bi ON p.id = bi.product_id
       GROUP BY c.id
       ORDER BY total_revenue DESC`
    );

    // 8. Top 6 Selling Delicacies
    const topProducts = await dbService.query(
      `SELECT p.id, p.name as product_name, p.sku, c.name as category_name,
              COALESCE(SUM(bi.quantity), 0) as total_sold,
              COALESCE(SUM(bi.total_amount), 0) as total_revenue
       FROM products p
       JOIN bill_items bi ON p.id = bi.product_id
       JOIN categories c ON p.category_id = c.id
       GROUP BY p.id
       ORDER BY total_sold DESC, total_revenue DESC
       LIMIT 6`
    );

    // 9. Payment Method Breakdown (Today + All-Time fallback)
    let paymentBreakdown = await dbService.query(
      `SELECT payment_method,
              COUNT(id) as transaction_count,
              COALESCE(SUM(amount), 0) as total_amount
       FROM payments
       WHERE DATE(created_at) = CURDATE()
       GROUP BY payment_method`
    );
    if (!paymentBreakdown || paymentBreakdown.length === 0) {
      paymentBreakdown = await dbService.query(
        `SELECT payment_method,
                COUNT(id) as transaction_count,
                COALESCE(SUM(amount), 0) as total_amount
         FROM payments
         GROUP BY payment_method`
      );
    }

    // 10. Recent Orders (Latest 8)
    const recentOrders = await dbService.query(
      `SELECT o.id, o.order_number, o.order_type, o.status, o.total_amount, o.created_at,
              COALESCE(c.name, 'Walk-in Guest') as customer_name,
              t.table_number, t.name as table_name
       FROM orders o
       LEFT JOIN customers c ON o.customer_id = c.id
       LEFT JOIN dining_tables t ON o.dining_table_id = t.id
       ORDER BY o.created_at DESC
       LIMIT 8`
    );

    // Calculations
    const todaySales = financialStats?.today_sales || 0;
    const allTimeSales = financialStats?.all_time_sales || 0;
    const todayBills = financialStats?.today_bills_count || 0;
    const allTimeBills = financialStats?.all_time_bills_count || 0;
    const avgOrderValue = todayBills > 0 ? (todaySales / todayBills) : (allTimeBills > 0 ? allTimeSales / allTimeBills : 0);

    const totalTables = tableStats?.total_tables || 0;
    const occupiedTables = tableStats?.occupied_tables || 0;
    const occupancyRate = totalTables > 0 ? Math.round((occupiedTables / totalTables) * 100) : 0;

    return {
      kpis: {
        todaySales,
        allTimeSales,
        todayBillsCount: todayBills,
        allTimeBillsCount: allTimeBills,
        todayOrdersCount: orderStats?.today_orders || 0,
        allTimeOrdersCount: orderStats?.all_time_orders || 0,
        pendingOrders: orderStats?.pending_orders || 0,
        inProgressOrders: orderStats?.in_progress_orders || 0,
        completedOrders: orderStats?.completed_orders || 0,
        cancelledOrders: orderStats?.cancelled_orders || 0,
        dineInOrders: orderStats?.dine_in_orders || 0,
        takeawayOrders: orderStats?.takeaway_orders || 0,
        walkInOrders: orderStats?.walk_in_orders || 0,
        avgOrderValue: Math.round(avgOrderValue),
        occupiedTables,
        availableTables: tableStats?.available_tables || 0,
        totalTables,
        occupancyRate,
        lowStockCount: stockStats?.low_stock_count || 0,
        outOfStockCount: stockStats?.out_of_stock_count || 0,
        totalProducts: stockStats?.total_products || 0,
        totalCustomers: customerStats?.total_customers || 0,
        todayTax: financialStats?.today_tax || 0,
        todayDiscount: financialStats?.today_discount || 0,
        activeQueueTokens: queueStats?.active_tokens || 0,
      },
      categorySales,
      topProducts,
      paymentBreakdown,
      recentOrders,
    };
  }
}

