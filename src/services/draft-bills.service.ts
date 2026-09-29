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
      `SELECT dbi.*, COALESCE(p.sku, cd.combo_code) AS sku, COALESCE(p.image_url, pa.image_url, cd.image_url) AS image_url,
              s.current_quantity AS current_stock
       FROM draft_bill_items dbi
       LEFT JOIN products p ON dbi.product_id = p.id
       LEFT JOIN product_addons pa ON pa.id = dbi.addon_id
       LEFT JOIN combo_deals cd ON cd.id = dbi.combo_id
       LEFT JOIN stocks s ON p.stock_id = s.id
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
    items: Array<{
      productId?: number | null;
      quantity: number;
      unitPrice?: number;
      notes?: string;
      itemType?: 'PRODUCT' | 'COMBO' | 'ADDON';
      comboId?: number | null;
      addonId?: number | null;
    }>;
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
        // A held line is a dish, a combo or a stand-alone add-on; each names
        // its own row and is priced from it unless the till sent a price.
        const itemType = item.itemType === 'COMBO' || item.itemType === 'ADDON' ? item.itemType : 'PRODUCT';
        let productId: number | null = null;
        let name: string;
        let listPrice = 0;

        if (itemType === 'COMBO') {
          const combo = await dbService.queryOne<{ name: string; combo_price: number }>(
            'SELECT name, combo_price FROM combo_deals WHERE id = ? AND is_deleted = 0',
            [item.comboId]
          );
          if (!combo) throw AppError.badRequest(`Combo deal ${item.comboId} does not exist`);
          name = combo.name;
          listPrice = Number(combo.combo_price) || 0;
        } else if (itemType === 'ADDON') {
          const addon = await dbService.queryOne<{ name: string; price: number }>(
            'SELECT name, price FROM product_addons WHERE id = ? AND is_deleted = 0',
            [item.addonId]
          );
          if (!addon) throw AppError.badRequest(`Add-on ${item.addonId} does not exist`);
          name = addon.name;
          listPrice = Number(addon.price) || 0;
        } else {
          const product = await dbService.queryOne<{ id: number; name: string }>(
            'SELECT id, name FROM products WHERE id = ?',
            [item.productId]
          );
          if (!product) {
            throw AppError.badRequest(`Product ID ${item.productId} does not exist`);
          }
          const variant = await dbService.queryOne<{ selling_price: number }>(
            'SELECT selling_price FROM product_variants WHERE product_id = ? ORDER BY is_default DESC, display_order ASC, id ASC LIMIT 1',
            [product.id]
          );
          productId = product.id;
          name = product.name;
          listPrice = variant ? Number(variant.selling_price) : 0;
        }
        const price = item.unitPrice !== undefined ? item.unitPrice : listPrice;

        await dbService.execute(
          `INSERT INTO draft_bill_items (draft_bill_id, product_id, product_name, quantity, unit_price, notes, item_type, combo_id, addon_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            draftId,
            productId,
            name,
            item.quantity,
            price,
            item.notes || null,
            itemType,
            itemType === 'COMBO' ? Number(item.comboId) : null,
            itemType === 'ADDON' ? Number(item.addonId) : null,
          ]
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
