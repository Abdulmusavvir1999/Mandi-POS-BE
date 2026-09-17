import { dbService } from '../../database/db';
import { AppError } from '../../core/errors/AppError';
import { AuditService } from '../audit/audit.service';

export class CategoriesService {
  static async getAll(includeInactive = false) {
    const where = includeInactive ? '' : "WHERE status = 'ACTIVE'";
    const categories = await dbService.query(
      `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) as product_count
       FROM categories c
       ${where}
       ORDER BY c.display_order ASC, c.name ASC`
    );
    return categories;
  }

  static async getById(id: number) {
    const category = await dbService.queryOne(
      `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) as product_count
       FROM categories c
       WHERE c.id = ?`,
      [id]
    );
    if (!category) {
      throw AppError.notFound('Category not found');
    }
    return category;
  }

  static async create(data: { name: string; description?: string; icon?: string; image_url?: string; display_order?: number; status?: string }, userId: number) {
    const res = await dbService.execute(
      `INSERT INTO categories (name, description, icon, image_url, display_order, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [data.name, data.description || null, data.icon || 'utensils', data.image_url || null, data.display_order || 0, data.status || 'ACTIVE']
    );

    await AuditService.log({
      userId,
      action: 'CATEGORY_CREATED',
      module: 'CATEGORIES',
      recordId: res.lastInsertRowid,
      newValues: data,
    });

    return await this.getById(res.lastInsertRowid);
  }

  static async update(id: number, data: { name?: string; description?: string; icon?: string; image_url?: string; display_order?: number; status?: string }, userId: number) {
    const current = await this.getById(id);
    await dbService.execute(
      `UPDATE categories
       SET name = COALESCE(?, name),
           description = COALESCE(?, description),
           icon = COALESCE(?, icon),
           image_url = COALESCE(?, image_url),
           display_order = COALESCE(?, display_order),
           status = COALESCE(?, status),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [data.name, data.description, data.icon, data.image_url, data.display_order, data.status, id]
    );

    await AuditService.log({
      userId,
      action: 'CATEGORY_UPDATED',
      module: 'CATEGORIES',
      recordId: id,
      oldValues: current,
      newValues: data,
    });

    return await this.getById(id);
  }

  static async delete(id: number, userId: number) {
    const current = await this.getById(id);
    const prodCount = await dbService.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM products WHERE category_id = ?', [id]);
    if (prodCount && prodCount.count > 0) {
      throw AppError.badRequest(`Cannot delete category with ${prodCount.count} existing products. Move or delete products first.`);
    }

    await dbService.execute('DELETE FROM categories WHERE id = ?', [id]);

    await AuditService.log({
      userId,
      action: 'CATEGORY_DELETED',
      module: 'CATEGORIES',
      recordId: id,
      oldValues: current,
    });

    return { success: true, message: 'Category deleted successfully' };
  }
}
