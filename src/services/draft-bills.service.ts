import { dbService } from '../database/db';
import { AppError } from '../errors/AppError';
import { AuditService } from './audit.service';
import { OrderType } from '../models';
import { ParamUtil } from '../utils/param.util';

export class DraftBillsService {
  static async getAll() {
    const drafts = await dbService.query(
      `SELECT d.*, c.name as customer_name, c.phone as customer_phone,
              t.table_number, t.name as table_name,
              u.name as created_by_name,
              (SELECT COUNT(*) FROM draft_bill_items dbi WHERE dbi.draft_bill_id = d.id) as item_count,
              (SELECT SUM(dbi.quantity * dbi.unit_price) FROM draft_bill_items dbi WHERE dbi.draft_bill_id = d.id) as subtotal
       FROM draft_bills d
       LEFT JOIN customers c ON d.customer_id = c.id
       LEFT JOIN dining_tables t ON d.dining_table_id = t.id
       LEFT JOIN users u ON d.created_by = u.id
       ORDER BY d.created_at DESC`
    );

    return drafts;
  }

  static async getById(id: number) {
    const draft = await dbService.queryOne(
      `SELECT d.*, c.name as customer_name, c.phone as customer_phone,
              t.table_number, t.name as table_name,
              u.name as created_by_name
       FROM draft_bills d
       LEFT JOIN customers c ON d.customer_id = c.id
       LEFT JOIN dining_tables t ON d.dining_table_id = t.id
       LEFT JOIN users u ON d.created_by = u.id
       WHERE d.id = ?`,
      [id]
    );

    if (!draft) {
      throw AppError.notFound('Draft bill not found');
    }

    const items = await dbService.query(
      `SELECT dbi.*, p.sku, p.image_url, s.current_stock
       FROM draft_bill_items dbi
       JOIN products p ON dbi.product_id = p.id
       LEFT JOIN stock s ON p.id = s.product_id
       WHERE dbi.draft_bill_id = ?`,
      [id]
    );

    return {
      ...draft,
      items,
    };
  }

  static async create(data: {
    customerId?: number | null;
    diningTableId?: number | null;
    orderType: OrderType;
    discountType?: 'FIXED' | 'PERCENTAGE';
    discountValue?: number;
    notes?: string;
    items: Array<{ productId: number; quantity: number; unitPrice?: number; notes?: string }>;
  }, userId: number) {
    if (!data.items || data.items.length === 0) {
      throw AppError.badRequest('Draft bill must contain at least one item');
    }

    return await dbService.transaction(async () => {
      const now = new Date();
      const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      const draftNumber = `DFT-${datePart}-${randomSuffix}`;

      const res = await dbService.execute(
        `INSERT INTO draft_bills (
          draft_number, customer_id, dining_table_id, order_type,
          discount_type, discount_value, notes, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          draftNumber,
          data.customerId || null,
          data.diningTableId || null,
          ParamUtil.orderType(data.orderType),
          data.discountType || 'FIXED',
          data.discountValue || 0.0,
          data.notes || null,
          userId,
        ]
      );

      const draftId = res.lastInsertRowid;

      for (const item of data.items) {
        const product = await dbService.queryOne<{ id: number; name: string }>(
          'SELECT id, name FROM products WHERE id = ?',
          [item.productId]
        );
        if (!product) {
          throw AppError.badRequest(`Product ID ${item.productId} does not exist`);
        }

        let variantPrice = 0;
        const variant = await dbService.queryOne<{ selling_price: number }>(
          'SELECT selling_price FROM product_variants WHERE product_id = ? ORDER BY is_default DESC, display_order ASC, id ASC LIMIT 1',
          [product.id]
        );
        if (variant) {
          variantPrice = Number(variant.selling_price);
        }
        const price = item.unitPrice !== undefined ? item.unitPrice : variantPrice;

        await dbService.execute(
          `INSERT INTO draft_bill_items (draft_bill_id, product_id, product_name, quantity, unit_price, notes)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [draftId, product.id, product.name, item.quantity, price, item.notes || null]
        );
      }

      await AuditService.log({
        userId,
        action: 'DRAFT_BILL_HOLD',
        module: 'DRAFT_BILLS',
        recordId: draftId,
        newValues: { draftNumber, itemCount: data.items.length },
      });

      return await this.getById(draftId);
    });
  }

  static async resume(id: number, userId: number) {
    const draft = await this.getById(id);

    // Delete draft after resuming into cart
    await dbService.execute('DELETE FROM draft_bills WHERE id = ?', [id]);

    await AuditService.log({
      userId,
      action: 'DRAFT_BILL_RESUMED',
      module: 'DRAFT_BILLS',
      recordId: id,
      oldValues: { draftNumber: draft.draft_number },
    });

    return draft;
  }

  static async delete(id: number, userId: number) {
    const draft = await this.getById(id);
    await dbService.execute('DELETE FROM draft_bills WHERE id = ?', [id]);

    await AuditService.log({
      userId,
      action: 'DRAFT_BILL_DELETED',
      module: 'DRAFT_BILLS',
      recordId: id,
      oldValues: { draftNumber: draft.draft_number },
    });

    return { success: true, message: 'Draft bill removed successfully' };
  }
}
