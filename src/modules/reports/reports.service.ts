import { dbService } from '../../database/db';

export class ReportsService {
  static async getSalesReport(dateFrom?: string, dateTo?: string, paymentMethod?: string, orderType?: string, cashierId?: number) {
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (dateFrom) {
      where += ' AND DATE(b.created_at) >= DATE(?)';
      params.push(dateFrom);
    }
    if (dateTo) {
      where += ' AND DATE(b.created_at) <= DATE(?)';
      params.push(dateTo);
    }
    if (paymentMethod) {
      where += ' AND b.payment_method = ?';
      params.push(paymentMethod);
    }
    if (orderType) {
      where += ' AND b.order_type = ?';
      params.push(orderType);
    }
    if (cashierId) {
      where += ' AND b.cashier_id = ?';
      params.push(cashierId);
    }

    const summary = await dbService.queryOne<{
      total_sales: number;
      total_bills: number;
      total_tax: number;
      total_discount: number;
      total_subtotal: number;
    }>(
      `SELECT
         COALESCE(SUM(b.total_amount), 0) as total_sales,
         COUNT(b.id) as total_bills,
         COALESCE(SUM(b.tax_amount), 0) as total_tax,
         COALESCE(SUM(b.discount_amount), 0) as total_discount,
         COALESCE(SUM(b.subtotal), 0) as total_subtotal
       FROM bills b
       ${where}`,
      params
    );

    const dailyBreakdown = await dbService.query(
      `SELECT
         DATE(b.created_at) as sale_date,
         COUNT(b.id) as bills_count,
         SUM(b.subtotal) as subtotal,
         SUM(b.discount_amount) as discount,
         SUM(b.tax_amount) as tax,
         SUM(b.total_amount) as total_revenue
       FROM bills b
       ${where}
       GROUP BY DATE(b.created_at)
       ORDER BY sale_date DESC`,
      params
    );

    return {
      summary,
      dailyBreakdown,
    };
  }

  static async getProductSalesReport(dateFrom?: string, dateTo?: string, categoryId?: number) {
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (dateFrom) {
      where += ' AND DATE(b.created_at) >= DATE(?)';
      params.push(dateFrom);
    }
    if (dateTo) {
      where += ' AND DATE(b.created_at) <= DATE(?)';
      params.push(dateTo);
    }
    if (categoryId) {
      where += ' AND p.category_id = ?';
      params.push(categoryId);
    }

    const products = await dbService.query(
      `SELECT
         p.id as product_id,
         p.name as product_name,
         p.sku,
         c.name as category_name,
         SUM(bi.quantity) as quantity_sold,
         SUM(bi.total_amount) as revenue_generated,
         SUM(bi.quantity * p.cost_price) as total_cost,
         (SUM(bi.total_amount) - SUM(bi.quantity * p.cost_price)) as estimated_gross_profit
       FROM bill_items bi
       JOIN bills b ON bi.bill_id = b.id
       JOIN products p ON bi.product_id = p.id
       JOIN categories c ON p.category_id = c.id
       ${where}
       GROUP BY p.id
       ORDER BY quantity_sold DESC`,
      params
    );

    return products;
  }

  static async getCategorySalesReport(dateFrom?: string, dateTo?: string) {
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (dateFrom) {
      where += ' AND DATE(b.created_at) >= DATE(?)';
      params.push(dateFrom);
    }
    if (dateTo) {
      where += ' AND DATE(b.created_at) <= DATE(?)';
      params.push(dateTo);
    }

    const categories = await dbService.query(
      `SELECT
         c.id as category_id,
         c.name as category_name,
         c.icon,
         COUNT(DISTINCT bi.bill_id) as orders_count,
         SUM(bi.quantity) as total_units_sold,
         SUM(bi.total_amount) as total_revenue
       FROM bill_items bi
       JOIN bills b ON bi.bill_id = b.id
       JOIN products p ON bi.product_id = p.id
       JOIN categories c ON p.category_id = c.id
       ${where}
       GROUP BY c.id
       ORDER BY total_revenue DESC`,
      params
    );

    return categories;
  }

  static async getStockReport() {
    const stockReport = await dbService.query(
      `SELECT
         si.id as stock_item_id,
         si.stock_code,
         si.name as item_name,
         si.unit_type,
         si.current_quantity,
         si.average_unit_price,
         si.current_value,
         si.min_stock_alert,
         p.id as product_id,
         p.name as product_name,
         p.sku,
         c.name as category_name,
         COALESCE(p.selling_price, 0) as selling_price,
         si.current_quantity as current_stock,
         si.current_value as stock_valuation_cost,
         (si.current_quantity * COALESCE(p.selling_price, si.average_unit_price)) as stock_valuation_retail,
         (si.current_quantity <= si.min_stock_alert) as is_low_stock
       FROM stock_items si
       LEFT JOIN products p ON si.product_id = p.id
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE si.status = 'active'
       ORDER BY (si.current_quantity <= si.min_stock_alert) DESC, si.current_quantity ASC`
    );

    const totals = await dbService.queryOne<{
      total_items_in_stock: number;
      total_valuation_cost: number;
      total_valuation_retail: number;
    }>(
      `SELECT
         COALESCE(SUM(si.current_quantity), 0) as total_items_in_stock,
         COALESCE(SUM(si.current_value), 0) as total_valuation_cost,
         COALESCE(SUM(si.current_quantity * COALESCE(p.selling_price, si.average_unit_price)), 0) as total_valuation_retail
       FROM stock_items si
       LEFT JOIN products p ON si.product_id = p.id
       WHERE si.status = 'active'`
    );

    return {
      totals,
      items: stockReport,
    };
  }
}
