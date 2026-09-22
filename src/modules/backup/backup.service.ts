import mysql from 'mysql2';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { Writable } from 'stream';
import { dbService } from '../../database/db';
import { logger } from '../../config/logger';
import { SettingsService } from '../settings/settings.service';
import { AppError } from '../../core/errors/AppError';

/**
 * Full database export.
 *
 * Produces a plain `.sql` file that recreates the database from scratch —
 * schema and every row — and is restorable with any MySQL client:
 *
 *     mysql -u user -p pos < 11-10-2025.sql
 *
 * WHY NOT mysqldump
 *
 * Shelling out to `mysqldump` would be shorter, but the binary is not
 * guaranteed to exist on the machine running the API, and when it is missing
 * the failure surfaces as an opaque spawn error at the moment someone is
 * trying to take a backup. This generates the same output from
 * INFORMATION_SCHEMA and plain SELECTs, so it works wherever the API itself
 * works.
 *
 * READ-ONLY BY CONSTRUCTION
 *
 * Every statement issued here is a SELECT, a SHOW, or an INFORMATION_SCHEMA
 * read. Taking a backup cannot alter, delete or lock the data it is copying.
 *
 * MEMORY
 *
 * Tables are read in batches and written straight to the response as they are
 * produced, so a table of any size costs one batch of memory rather than the
 * whole table. `audit_logs` is usually the largest and is the reason this
 * matters.
 */

export interface BackupTableInfo {
  name: string;
  rows: number;
  sizeBytes: number;
}

export interface BackupInfo {
  database: string;
  tables: BackupTableInfo[];
  totalTables: number;
  /** Approximate — InnoDB row counts in INFORMATION_SCHEMA are estimates. */
  totalRows: number;
  totalSizeBytes: number;
  suggestedFileName: string;
  generatedAt: string;
}

/** Rows per SELECT when reading a table out. */
const BATCH_SIZE = 500;

/** Settings key holding the configured backup folder. */
export const BACKUP_FOLDER_KEY = 'BACKUP_FOLDER_PATH';

export interface FolderCheck {
  path: string;
  /** Usable as a backup destination right now. */
  ok: boolean;
  exists: boolean;
  writable: boolean;
  /** True when this call created the folder. */
  created: boolean;
  message: string;
}

export interface BrowseEntry {
  name: string;
  path: string;
}

export interface BrowseResult {
  /** Folder being listed. Empty string means "the roots". */
  path: string;
  /** Parent folder, or null at a root. */
  parent: string | null;
  /** Drive roots (Windows) or `/` (POSIX). Present at every level for jumping. */
  roots: BrowseEntry[];
  folders: BrowseEntry[];
  /** Whether `path` itself could be used as a backup destination. */
  writable: boolean;
  /** Set when a folder could be reached but not read. */
  error?: string;
}

export interface BackupRunResult {
  fileName: string;
  /** Absolute path the file was written to, on the machine running the API. */
  filePath: string;
  folder: string;
  bytes: number;
  /** Set when the name was adjusted to avoid overwriting an existing backup. */
  renamedFrom?: string;
}

export class BackupService {
  // ═══════════════════════════════════════════════════════════════════════
  // Configured folder
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * The folder backups are written to, or null when none is configured.
   *
   * IMPORTANT: this is a path on the machine running the API, not on the
   * machine running the browser. In the normal single-PC install those are the
   * same computer, which is what makes a typed path useful at all — a web page
   * cannot write to an arbitrary path on the client, only the server can.
   */
  static async getConfiguredFolder(): Promise<string | null> {
    try {
      const value = await SettingsService.getValue(BACKUP_FOLDER_KEY);
      const trimmed = String(value ?? '').trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  /**
   * Checks a folder is usable as a backup destination, optionally creating it.
   *
   * Writability is proved by actually writing a probe file rather than by
   * reading permission bits: on Windows an ACL can deny a write that the mode
   * bits suggest is allowed, and discovering that during a real backup would
   * mean losing the dump halfway through.
   */
  static async checkFolder(input: string, create = false): Promise<FolderCheck> {
    const folder = String(input ?? '').trim().replace(/[\\/]+$/, '');

    if (!folder) {
      return {
        path: '',
        ok: false,
        exists: false,
        writable: false,
        created: false,
        message: 'Enter a folder path.',
      };
    }

    // A relative path would resolve against wherever the API happens to have
    // been started from, which is not something an operator can reason about.
    if (!path.isAbsolute(folder)) {
      return {
        path: folder,
        ok: false,
        exists: false,
        writable: false,
        created: false,
        message: 'Use a full path, for example D:\\POS Backups or /var/backups/pos.',
      };
    }

    let exists = false;
    let created = false;

    try {
      const stat = await fsp.stat(folder);
      if (!stat.isDirectory()) {
        return {
          path: folder,
          ok: false,
          exists: true,
          writable: false,
          created: false,
          message: 'That path is a file, not a folder.',
        };
      }
      exists = true;
    } catch {
      if (!create) {
        return {
          path: folder,
          ok: false,
          exists: false,
          writable: false,
          created: false,
          message: 'That folder does not exist on the machine running the POS server.',
        };
      }

      try {
        await fsp.mkdir(folder, { recursive: true });
        exists = true;
        created = true;
      } catch (err: any) {
        return {
          path: folder,
          ok: false,
          exists: false,
          writable: false,
          created: false,
          message: `The folder could not be created: ${err?.message ?? 'unknown error'}`,
        };
      }
    }

    const probe = path.join(folder, `.pos-backup-write-test-${Date.now()}`);
    try {
      await fsp.writeFile(probe, 'ok');
      await fsp.unlink(probe);
    } catch (err: any) {
      return {
        path: folder,
        ok: false,
        exists,
        writable: false,
        created,
        message: `The folder exists but is not writable: ${err?.message ?? 'permission denied'}`,
      };
    }

    return {
      path: folder,
      ok: true,
      exists,
      writable: true,
      created,
      message: created ? 'Folder created and ready.' : 'Folder is ready.',
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Folder browser
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Lists folders on the machine running the API, for the Browse dialog.
   *
   * WHY THIS IS SERVER-SIDE
   *
   * The destination has to be a path this process can write to, and a web page
   * cannot discover one: `showDirectoryPicker` hands back a handle whose only
   * readable property is the folder's *name*, never its path. So the only way
   * to offer a real "Browse…" for a server destination is to browse the
   * server, which is what this does.
   *
   * Only directories are returned — a backup destination is never a file, and
   * listing files would expose more of the filesystem than the feature needs.
   *
   * Administrator-only, like everything else in this module. It does reveal
   * the server's folder structure to an admin, which is inherent to letting
   * them choose a path at all.
   */
  static async browse(input?: string): Promise<BrowseResult> {
    const roots = await this.filesystemRoots();
    const requested = String(input ?? '').trim();

    // No path yet: show the drive list rather than guessing a starting point.
    if (!requested) {
      return { path: '', parent: null, roots, folders: roots, writable: false };
    }

    if (!path.isAbsolute(requested)) {
      return {
        path: '',
        parent: null,
        roots,
        folders: roots,
        writable: false,
        error: 'Not a full path.',
      };
    }

    const folder = path.resolve(requested);
    const parent = path.dirname(folder);

    let folders: BrowseEntry[] = [];
    let error: string | undefined;

    try {
      const entries = await fsp.readdir(folder, { withFileTypes: true });
      folders = entries
        .filter((entry) => {
          if (!entry.isDirectory()) return false;
          // Windows bookkeeping folders nobody would pick, and which throw on
          // read anyway.
          if (entry.name.startsWith('$')) return false;
          if (entry.name === 'System Volume Information') return false;
          return true;
        })
        .map((entry) => ({ name: entry.name, path: path.join(folder, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    } catch (err: any) {
      error =
        err?.code === 'EACCES' || err?.code === 'EPERM'
          ? 'This folder cannot be opened — permission denied.'
          : err?.code === 'ENOENT'
            ? 'This folder no longer exists.'
            : `This folder could not be read: ${err?.message ?? 'unknown error'}`;
    }

    const check = await this.checkFolder(folder, false);

    return {
      path: folder,
      // At a drive root `dirname` returns the same path; null stops the dialog
      // offering an "up" that goes nowhere.
      parent: parent === folder ? null : parent,
      roots,
      folders,
      writable: check.ok,
      error,
    };
  }

  /**
   * Drive roots on Windows, `/` elsewhere.
   *
   * Probed with `existsSync` rather than shelling out to `wmic` or PowerShell:
   * 26 stat calls are cheaper than spawning a process, and `wmic` is deprecated
   * and absent from recent Windows builds.
   */
  private static async filesystemRoots(): Promise<BrowseEntry[]> {
    if (process.platform !== 'win32') {
      return [{ name: '/', path: '/' }];
    }

    const drives: BrowseEntry[] = [];
    for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
      const letter = String.fromCharCode(code);
      const root = `${letter}:\\`;
      try {
        if (fs.existsSync(root)) drives.push({ name: `${letter}:`, path: root });
      } catch {
        // An empty card reader or disconnected network drive; skip it.
      }
    }
    return drives;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Native folder dialog
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Opens Windows' own "Select Folder" dialog and returns what was chosen.
   *
   * The dialog opens on the desktop of the machine running this API, which in
   * the normal single-PC install is the machine the operator is sitting at —
   * so clicking Browse in the browser pops the real shell dialog in front of
   * them. That is the only way to get the native picker at all: a web page
   * cannot open it, and the browser's own `showDirectoryPicker` never reveals
   * a path.
   *
   * Consequences worth knowing:
   *  - Windows only. Elsewhere this reports unsupported and the caller falls
   *    back to the in-app folder browser.
   *  - Needs an interactive desktop session. Run the API as a Windows service
   *    with no desktop and the dialog has nowhere to appear, which surfaces as
   *    a timeout rather than a hang.
   *  - The request is held open while the dialog is up, hence the long
   *    timeout: someone browsing their drives is not a stalled request.
   */
  static async pickFolderNatively(initialPath?: string): Promise<{
    status: 'picked' | 'cancelled' | 'unsupported' | 'timeout' | 'error';
    path?: string;
    message?: string;
  }> {
    if (process.platform !== 'win32') {
      return {
        status: 'unsupported',
        message: 'The native folder dialog is only available on Windows.',
      };
    }

    const script = this.pickerScriptPath();
    if (!script) {
      return {
        status: 'unsupported',
        message: 'The folder dialog helper script is missing from this installation.',
      };
    }

    const args = [
      '-STA', // the shell dialog requires a single-threaded apartment
      '-NoProfile',
      // Deliberately NOT -NonInteractive: that flag tells PowerShell to refuse
      // anything needing user input, which is precisely what this does.
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
    ];
    if (initialPath && path.isAbsolute(initialPath)) {
      args.push('-InitialPath', initialPath);
    }

    try {
      const output = await this.runPowerShell(args, 4 * 60_000);
      const line = output
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();

      if (!line) return { status: 'error', message: 'The folder dialog returned nothing.' };
      if (line === 'CANCELLED') return { status: 'cancelled' };
      if (line.startsWith('PATH:')) return { status: 'picked', path: line.slice(5) };
      if (line.startsWith('ERROR:')) return { status: 'error', message: line.slice(6) };

      return { status: 'error', message: `Unexpected response from the folder dialog: ${line}` };
    } catch (err: any) {
      if (err?.message === 'TIMEOUT') {
        return {
          status: 'timeout',
          message:
            'The folder dialog did not respond. It opens on the computer running the POS server — check that machine, or type the path instead.',
        };
      }
      return { status: 'error', message: err?.message ?? 'The folder dialog could not be opened.' };
    }
  }

  /** Whether the native dialog can be offered at all. */
  static async nativePickerAvailable(): Promise<boolean> {
    if (process.platform !== 'win32') return false;

    const script = this.pickerScriptPath();
    if (!script) return false;

    try {
      const out = await this.runPowerShell(
        ['-STA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-SelfTest'],
        20_000
      );
      return out.includes('SELFTEST:OK');
    } catch {
      return false;
    }
  }

  /**
   * Locates the helper script in both layouts: `src` under tsx in
   * development, and `dist` after a build. Checked rather than assumed so a
   * missing script degrades to the in-app browser instead of throwing.
   */
  private static pickerScriptPath(): string | null {
    const candidates = [
      path.join(__dirname, 'scripts', 'pick-folder.ps1'),
      path.join(__dirname, '..', '..', '..', 'src', 'modules', 'backup', 'scripts', 'pick-folder.ps1'),
    ];

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* keep looking */
      }
    }
    return null;
  }

  private static runPowerShell(args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', args, { windowsHide: true });

      let stdout = '';
      let stderr = '';
      let finished = false;

      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        child.kill();
        reject(new Error('TIMEOUT'));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });

      child.on('error', (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);

        if (!stdout.trim() && stderr.trim()) {
          logger.warn(`Folder dialog helper wrote to stderr: ${stderr.trim()}`);
          reject(new Error(stderr.trim().split(/\r?\n/)[0]));
          return;
        }
        resolve(stdout);
      });
    });
  }

  /**
   * Creates a subfolder while browsing, so a destination can be made without
   * leaving the dialog.
   *
   * The name is a single path segment: anything containing a separator, or the
   * `..` that would climb out of the parent, is refused.
   */
  static async createSubfolder(parent: string, name: string): Promise<FolderCheck> {
    const folderName = String(name ?? '').trim();

    if (!folderName) {
      return this.failedCheck('', 'Enter a folder name.');
    }
    if (folderName !== path.basename(folderName) || folderName === '.' || folderName === '..') {
      return this.failedCheck(folderName, 'Use a single folder name, not a path.');
    }
    // Windows rejects these outright; catching them here gives a clear message
    // rather than a raw EINVAL.
    if (/[<>:"/\\|?*]/.test(folderName)) {
      return this.failedCheck(folderName, 'A folder name cannot contain \\ / : * ? " < > or |');
    }

    const parentPath = String(parent ?? '').trim();
    if (!parentPath || !path.isAbsolute(parentPath)) {
      return this.failedCheck(parentPath, 'Open a folder first, then create one inside it.');
    }

    return this.checkFolder(path.join(parentPath, folderName), true);
  }

  private static failedCheck(target: string, message: string): FolderCheck {
    return { path: target, ok: false, exists: false, writable: false, created: false, message };
  }

  /** Validates, then persists the folder as the backup destination. */
  static async setConfiguredFolder(input: string, userId: number, create = false): Promise<FolderCheck> {
    const check = await this.checkFolder(input, create);
    if (!check.ok) return check;

    await SettingsService.updateBulk({ [BACKUP_FOLDER_KEY]: check.path }, userId, "databackup");
    return check;
  }

  /**
   * Writes a backup into the configured folder.
   *
   * The dump goes to a `.part` file and is renamed only once it has completed,
   * so an interrupted backup never leaves a half-written `.sql` sitting in the
   * folder looking like a valid one. On failure the partial file is removed.
   */
  static async runToConfiguredFolder(): Promise<BackupRunResult> {
    const folder = await this.getConfiguredFolder();
    if (!folder) {
      throw new Error('NO_BACKUP_FOLDER_CONFIGURED');
    }

    const check = await this.checkFolder(folder, false);
    if (!check.ok) {
      // An AppError, not a bare Error: a configured folder that has gone
      // missing — a removed drive, a renamed directory — is a condition the
      // operator can fix, and the global handler turns anything else into an
      // opaque "Internal server error" that says nothing about the folder.
      throw AppError.badRequest(check.message, 'BACKUP_FOLDER_UNAVAILABLE');
    }

    const preferred = this.suggestedFileName();
    const fileName = await this.nonClashingName(folder, preferred);
    const filePath = path.join(folder, fileName);
    const partPath = `${filePath}.part`;

    const stream = fs.createWriteStream(partPath, { encoding: 'utf8' });

    try {
      await this.writeDump(stream);
      await new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
      await fsp.rename(partPath, filePath);
    } catch (err) {
      stream.destroy();
      try {
        await fsp.unlink(partPath);
      } catch {
        /* nothing to clean up */
      }
      throw err;
    }

    const stat = await fsp.stat(filePath);

    return {
      fileName,
      filePath,
      folder,
      bytes: stat.size,
      renamedFrom: fileName === preferred ? undefined : preferred,
    };
  }

  /**
   * `21-09-2026.sql`, or `21-09-2026_2.sql` when that already exists.
   *
   * Two backups on the same day must not silently replace one another, so the
   * folder is checked rather than the name simply reused.
   */
  private static async nonClashingName(folder: string, preferred: string): Promise<string> {
    if (!fs.existsSync(path.join(folder, preferred))) return preferred;

    const base = preferred.replace(/\.sql$/i, '');
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${base}_${n}.sql`;
      if (!fs.existsSync(path.join(folder, candidate))) return candidate;
    }

    return `${base}_${Date.now()}.sql`;
  }

  /**
   * What a backup would contain, for the confirmation screen.
   *
   * Row counts come from INFORMATION_SCHEMA, which for InnoDB are estimates —
   * good enough to tell an operator whether they are about to export 200 rows
   * or 2 million, and far cheaper than counting every table exactly.
   */
  static async getInfo(): Promise<BackupInfo> {
    const rows = await dbService.query<{
      TABLE_NAME: string;
      TABLE_ROWS: number | null;
      DATA_LENGTH: number | null;
      INDEX_LENGTH: number | null;
    }>(
      `SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME ASC`
    );

    const dbRow = await dbService.queryOne<{ db: string }>('SELECT DATABASE() AS db');

    const tables: BackupTableInfo[] = rows.map((row) => ({
      name: row.TABLE_NAME,
      rows: Number(row.TABLE_ROWS ?? 0),
      sizeBytes: Number(row.DATA_LENGTH ?? 0) + Number(row.INDEX_LENGTH ?? 0),
    }));

    return {
      database: dbRow?.db ?? 'unknown',
      tables,
      totalTables: tables.length,
      totalRows: tables.reduce((sum, t) => sum + t.rows, 0),
      totalSizeBytes: tables.reduce((sum, t) => sum + t.sizeBytes, 0),
      suggestedFileName: this.suggestedFileName(),
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * `11-10-2025.sql` — the date the backup was taken, in DD-MM-YYYY.
   *
   * Hyphens rather than slashes because `/` is a path separator on every
   * platform and would be rejected (or silently create a directory) as part of
   * a file name.
   */
  static suggestedFileName(at: Date = new Date()): string {
    const dd = String(at.getDate()).padStart(2, '0');
    const mm = String(at.getMonth() + 1).padStart(2, '0');
    const yyyy = at.getFullYear();
    return `${dd}-${mm}-${yyyy}.sql`;
  }

  /**
   * Writes the whole database to `out` as SQL.
   *
   * The caller owns the stream: this never ends it, so a controller can set
   * headers, stream the body and decide how to finish. An error mid-stream is
   * rethrown after a SQL comment is written into the file, so a truncated
   * backup announces itself rather than looking complete.
   */
  static async writeDump(out: Writable): Promise<void> {
    const write = (chunk: string): Promise<void> =>
      new Promise((resolve, reject) => {
        // Respect backpressure: without waiting for the drain callback a large
        // table would buffer the entire dump in memory, which is the thing the
        // batching is there to avoid.
        out.write(chunk, (err) => (err ? reject(err) : resolve()));
      });

    const dbRow = await dbService.queryOne<{ db: string }>('SELECT DATABASE() AS db');
    const versionRow = await dbService.queryOne<{ v: string }>('SELECT VERSION() AS v');
    const database = dbRow?.db ?? 'unknown';

    await write(this.header(database, versionRow?.v ?? 'unknown'));

    try {
      const tables = await dbService.query<{ TABLE_NAME: string }>(
        `SELECT TABLE_NAME
         FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
         ORDER BY TABLE_NAME ASC`
      );

      for (const { TABLE_NAME: table } of tables) {
        await this.writeTable(table, write);
      }

      // Views are recreated after the tables they read from exist.
      const views = await dbService.query<{ TABLE_NAME: string }>(
        `SELECT TABLE_NAME
         FROM INFORMATION_SCHEMA.VIEWS
         WHERE TABLE_SCHEMA = DATABASE()
         ORDER BY TABLE_NAME ASC`
      );
      for (const { TABLE_NAME: view } of views) {
        await this.writeView(view, write);
      }

      await write(this.footer());
    } catch (err) {
      logger.error('Database backup failed part-way through:', err);
      await write(
        `\n-- ==========================================================\n` +
        `-- BACKUP FAILED AND IS INCOMPLETE. DO NOT RESTORE FROM THIS FILE.\n` +
        `-- ${String((err as Error)?.message ?? err).replace(/\r?\n/g, ' ')}\n` +
        `-- ==========================================================\n`
      );
      throw err;
    }
  }

  /** Schema and rows for one table. */
  private static async writeTable(table: string, write: (chunk: string) => Promise<void>): Promise<void> {
    const quoted = mysql.escapeId(table);

    await write(
      `\n--\n-- Table structure for ${table}\n--\n\n` + `DROP TABLE IF EXISTS ${quoted};\n`
    );

    // SHOW CREATE TABLE reproduces the definition exactly as the server holds
    // it — engine, charset, generated columns, keys and constraints — which is
    // not reconstructable from INFORMATION_SCHEMA without losing detail.
    const created = await dbService.queryOne<Record<string, string>>(`SHOW CREATE TABLE ${quoted}`);
    const createSql = created?.['Create Table'] ?? created?.['Create table'];
    if (!createSql) {
      throw new Error(`Could not read the table definition for ${table}`);
    }
    await write(`${createSql};\n`);

    const countRow = await dbService.queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM ${quoted}`);
    const total = Number(countRow?.total ?? 0);

    if (total === 0) {
      await write(`\n-- ${table} has no rows\n`);
      return;
    }

    await write(`\n--\n-- Data for ${table} (${total} rows)\n--\n\n`);

    const columnRows = await dbService.query<{ COLUMN_NAME: string; EXTRA: string }>(
      `SELECT COLUMN_NAME, EXTRA
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION ASC`,
      [table]
    );

    // Generated columns are computed by the server on insert and rejected if
    // supplied, so they are read but never written back.
    const columns = columnRows
      .filter((c) => !String(c.EXTRA ?? '').toUpperCase().includes('GENERATED'))
      .map((c) => c.COLUMN_NAME);

    if (columns.length === 0) {
      await write(`-- ${table} has no insertable columns\n`);
      return;
    }

    const columnList = columns.map((c) => mysql.escapeId(c)).join(', ');

    // Ordered by the primary key where there is one so successive backups of
    // an unchanged table produce identical files, which makes them diffable.
    const orderBy = await this.primaryKeyOrder(table);

    for (let offset = 0; offset < total; offset += BATCH_SIZE) {
      const batch = await dbService.query<Record<string, any>>(
        `SELECT ${columnList} FROM ${quoted} ${orderBy} LIMIT ${BATCH_SIZE} OFFSET ${offset}`
      );
      if (batch.length === 0) break;

      const values = batch
        .map((row) => `(${columns.map((col) => mysql.escape(row[col])).join(', ')})`)
        .join(',\n  ');

      await write(`INSERT INTO ${quoted} (${columnList}) VALUES\n  ${values};\n`);
    }
  }

  private static async writeView(view: string, write: (chunk: string) => Promise<void>): Promise<void> {
    const quoted = mysql.escapeId(view);
    const created = await dbService.queryOne<Record<string, string>>(`SHOW CREATE VIEW ${quoted}`);
    const createSql = created?.['Create View'] ?? created?.['Create view'];
    if (!createSql) return;

    await write(`\n--\n-- View ${view}\n--\n\nDROP VIEW IF EXISTS ${quoted};\n${createSql};\n`);
  }

  /** `ORDER BY` over the primary key, or empty when the table has none. */
  private static async primaryKeyOrder(table: string): Promise<string> {
    const keyCols = await dbService.query<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
       ORDER BY SEQ_IN_INDEX ASC`,
      [table]
    );

    if (keyCols.length === 0) return '';
    return `ORDER BY ${keyCols.map((c) => mysql.escapeId(c.COLUMN_NAME)).join(', ')}`;
  }

  private static header(database: string, serverVersion: string): string {
    return [
      `-- ============================================================`,
      `--  POS database backup`,
      `--`,
      `-- Database : ${database}`,
      `-- Server   : ${serverVersion}`,
      `-- Taken    : ${new Date().toISOString()}`,
      `--`,
      `-- Restore with:`,
      `--   mysql -u <user> -p ${database} < <this file>`,
      `--`,
      `-- Contains the schema and every row. The target database is dropped`,
      `-- table by table as this runs, so restore into an empty database or one`,
      `-- you intend to replace.`,
      `-- ============================================================`,
      ``,
      `/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;`,
      `/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;`,
      `/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;`,
      `/*!40101 SET NAMES utf8mb4 */;`,
      `/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;`,
      `/*!40103 SET TIME_ZONE='+00:00' */;`,
      `/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;`,
      `/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;`,
      `/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;`,
      ``,
    ].join('\n');
  }

  private static footer(): string {
    return [
      ``,
      `/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;`,
      `/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;`,
      `/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;`,
      `/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;`,
      `/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;`,
      `/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;`,
      `/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;`,
      ``,
      `-- Backup completed successfully at ${new Date().toISOString()}`,
      ``,
    ].join('\n');
  }
}
