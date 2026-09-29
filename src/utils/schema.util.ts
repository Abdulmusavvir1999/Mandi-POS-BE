import { dbService } from '../database/db';

/**
 * Small, idempotent schema checks for the ensureSchema() methods that bring an
 * existing database forward on boot. Each is a no-op once the change is in.
 */
export const SchemaUtil = {
  async columnExists(table: string, column: string): Promise<boolean> {
    const row = await dbService.queryOne<{ c: number }>(
      `SELECT COUNT(*) c FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    );
    return Number(row?.c ?? 0) > 0;
  },

  async addColumn(table: string, column: string, definition: string): Promise<void> {
    if (!(await this.columnExists(table, column))) {
      await dbService.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    }
  },

  /** Lets an INT column hold NULL, keeping any foreign key on it. */
  async makeIntNullable(table: string, column: string): Promise<void> {
    const row = await dbService.queryOne<{ IS_NULLABLE: string }>(
      `SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    );
    if (row && row.IS_NULLABLE === 'NO') {
      await dbService.execute(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` INT NULL`);
    }
  },

  /** Drops every foreign key on `table` that sits on `column`. */
  async dropForeignKeysOn(table: string, column: string): Promise<void> {
    const fks = await dbService.query<{ CONSTRAINT_NAME: string }>(
      `SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
         AND COLUMN_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
      [table, column]
    );
    for (const fk of fks) {
      await dbService.execute(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${fk.CONSTRAINT_NAME}\``);
    }
  },

  /** Drops a column together with the foreign keys that sit on it. */
  async dropColumn(table: string, column: string): Promise<void> {
    if (!(await this.columnExists(table, column))) return;
    await this.dropForeignKeysOn(table, column);
    await dbService.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
  },

  async addForeignKey(table: string, column: string, refTable: string, name: string, onDelete: string): Promise<void> {
    const existing = await dbService.queryOne<{ c: number }>(
      `SELECT COUNT(*) c FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
         AND COLUMN_NAME = ? AND REFERENCED_TABLE_NAME = ?`,
      [table, column, refTable]
    );
    if (Number(existing?.c ?? 0) === 0) {
      await dbService.execute(
        `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${name}\` FOREIGN KEY (\`${column}\`) REFERENCES \`${refTable}\`(\`id\`) ON DELETE ${onDelete}`
      );
    }
  },
};
