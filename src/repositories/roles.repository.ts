import { dbService } from '../database/db';

/**
 * Data access for roles, permissions and the role_permissions join.
 *
 * Every SQL statement the module runs lives here — the service layer above
 * holds the rules (name uniqueness, the custom-role cap, the "role still has
 * staff" guard) and never touches dbService directly.
 *
 * These methods take no transaction handle: dbService.transaction() pins a
 * single pooled connection for the duration of its callback, so a repository
 * call made inside that callback runs on the same connection and joins the
 * transaction.
 */

const PERMISSIONS_FOR_ROLE_SQL = `
  SELECT p.id, p.code, p.module, p.description
  FROM permissions p
  JOIN role_permissions rp ON p.id = rp.permission_id
  WHERE rp.role_id = ?
  ORDER BY p.module ASC, p.code ASC`;

export class RolesRepository {
  // ---------------------------------------------------------------------------
  // Roles
  // ---------------------------------------------------------------------------
  static async findAllWithUserCount(): Promise<any[]> {
    return dbService.query<any>(
      `SELECT r.id, r.name, r.description, COALESCE(r.is_system, 0) as is_system, r.created_at, r.updated_at,
              COUNT(u.id) as user_count
       FROM roles r
       LEFT JOIN users u ON r.id = u.role_id
       GROUP BY r.id
       ORDER BY r.id ASC`
    );
  }

  static async findByIdWithUserCount(roleId: number): Promise<any | null> {
    return dbService.queryOne<any>(
      `SELECT r.id, r.name, r.description, COALESCE(r.is_system, 0) as is_system, r.created_at, r.updated_at,
              COUNT(u.id) as user_count
       FROM roles r
       LEFT JOIN users u ON r.id = u.role_id
       WHERE r.id = ?
       GROUP BY r.id`,
      [roleId]
    );
  }

  static async findById(roleId: number): Promise<any | null> {
    return dbService.queryOne<any>('SELECT * FROM roles WHERE id = ?', [roleId]);
  }

  /** Case-insensitive name lookup; `excludeId` skips the row being renamed. */
  static async findByName(name: string, excludeId?: number): Promise<any | null> {
    if (excludeId !== undefined) {
      return dbService.queryOne<any>(
        'SELECT id FROM roles WHERE LOWER(name) = LOWER(?) AND id != ?',
        [name, excludeId]
      );
    }
    return dbService.queryOne<any>('SELECT id FROM roles WHERE LOWER(name) = LOWER(?)', [name]);
  }

  /** Hand-made roles only — seeded roles carry is_system = 1 and are not counted. */
  static async countCustomRoles(): Promise<number> {
    const row = await dbService.queryOne<{ total: number }>(
      'SELECT COUNT(*) as total FROM roles WHERE COALESCE(is_system, 0) = 0'
    );
    return Number(row?.total || 0);
  }

  static async countUsersByRole(roleId: number): Promise<number> {
    const row = await dbService.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM users WHERE role_id = ?',
      [roleId]
    );
    return Number(row?.count || 0);
  }

  static async insertRole(name: string, description: string | null): Promise<number> {
    const result = await dbService.execute(
      'INSERT INTO roles (name, description) VALUES (?, ?)',
      [name, description]
    );
    return result.lastInsertRowid;
  }

  static async updateRole(roleId: number, name: string, description: string | null): Promise<void> {
    await dbService.execute(
      `UPDATE roles
       SET name = COALESCE(?, name),
           description = COALESCE(?, description),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [name, description, roleId]
    );
  }

  static async deleteRole(roleId: number): Promise<void> {
    await dbService.execute('DELETE FROM roles WHERE id = ?', [roleId]);
  }

  // ---------------------------------------------------------------------------
  // Permissions
  // ---------------------------------------------------------------------------
  static async findAllPermissions(): Promise<any[]> {
    return dbService.query<any>('SELECT * FROM permissions ORDER BY module ASC, code ASC');
  }

  static async findPermissionById(permissionId: number): Promise<any | null> {
    return dbService.queryOne<any>('SELECT * FROM permissions WHERE id = ?', [permissionId]);
  }

  /** `code` is expected already lower-cased by the caller. */
  static async findPermissionByCode(code: string): Promise<any | null> {
    return dbService.queryOne<any>('SELECT id FROM permissions WHERE LOWER(code) = ?', [code]);
  }

  static async insertPermission(code: string, module: string, description: string | null): Promise<number> {
    const result = await dbService.execute(
      'INSERT INTO permissions (code, module, description) VALUES (?, ?, ?)',
      [code, module, description]
    );
    return result.lastInsertRowid;
  }

  static async deletePermission(permissionId: number): Promise<void> {
    await dbService.execute('DELETE FROM permissions WHERE id = ?', [permissionId]);
  }

  // ---------------------------------------------------------------------------
  // role_permissions join
  // ---------------------------------------------------------------------------
  static async findPermissionsByRole(roleId: number): Promise<any[]> {
    return dbService.query<any>(PERMISSIONS_FOR_ROLE_SQL, [roleId]);
  }

  static async replaceRolePermissions(roleId: number, permissionIds: number[]): Promise<void> {
    await dbService.execute('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
    await this.insertRolePermissions(roleId, permissionIds);
  }

  static async insertRolePermissions(roleId: number, permissionIds: number[]): Promise<void> {
    for (const permissionId of permissionIds) {
      await dbService.execute(
        'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
        [roleId, permissionId]
      );
    }
  }

  static async deleteRolePermissionsByRole(roleId: number): Promise<void> {
    await dbService.execute('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
  }

  static async deleteRolePermissionsByPermission(permissionId: number): Promise<void> {
    await dbService.execute('DELETE FROM role_permissions WHERE permission_id = ?', [permissionId]);
  }
}
