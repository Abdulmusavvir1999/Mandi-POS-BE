import { dbService } from '../database/db';
import { AppError } from '../errors/AppError';
import { AuditService } from './audit.service';
import { CategoryImageService } from './category-image.service';

export class CategoriesService {
  private static schemaEnsured = false;

  static async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) return;
    try {
      // Safely drop deprecated 'icon' column if it exists
      const iconColCheck = await dbService.queryOne<{ count: number }>(`
        SELECT COUNT(*) as count 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
          AND TABLE_NAME = 'categories' 
          AND COLUMN_NAME = 'icon'
      `);
      if (iconColCheck && iconColCheck.count > 0) {
        await dbService.execute('ALTER TABLE categories DROP COLUMN icon');
      }
      this.schemaEnsured = true;
    } catch (_) {}
  }

  static async getAll(includeInactive = false) {
    await this.ensureSchema();
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
    await this.ensureSchema();
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

  static async create(data: { name: string; description?: string; image_url?: string; display_order?: number; status?: string }, userId: number) {
    await this.ensureSchema();
    const res = await dbService.execute(
      `INSERT INTO categories (name, description, image_url, display_order, status)
       VALUES (?, ?, ?, ?, ?)`,
      [data.name, data.description || null, data.image_url || null, data.display_order || 0, data.status || 'ACTIVE']
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

  static async update(id: number, data: { name?: string; description?: string; image_url?: string; display_order?: number; status?: string }, userId: number) {
    await this.ensureSchema();
    const current = await this.getById(id);

    // A replaced or cleared image leaves its file behind otherwise, and a POS
    // that runs for years would accumulate them indefinitely.
    if (data.image_url !== undefined && current && (current as any).image_url && (current as any).image_url !== data.image_url) {
      CategoryImageService.removeByUrl((current as any).image_url);
    }
    await dbService.execute(
      `UPDATE categories
       SET name = COALESCE(?, name),
           description = COALESCE(?, description),
           image_url = COALESCE(?, image_url),
           display_order = COALESCE(?, display_order),
           status = COALESCE(?, status),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [data.name, data.description, data.image_url, data.display_order, data.status, id]
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
    await this.ensureSchema();
    const current = await this.getById(id);
    const prodCount = await dbService.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM products WHERE category_id = ?', [id]);
    if (prodCount && prodCount.count > 0) {
      throw AppError.badRequest(`Cannot delete category with ${prodCount.count} existing products. Move or delete products first.`);
    }

    await dbService.execute('DELETE FROM categories WHERE id = ?', [id]);
    CategoryImageService.removeByUrl((current as any)?.image_url);

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
