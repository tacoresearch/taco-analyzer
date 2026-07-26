/**
 * SQLite connection and migration runner.
 *
 * One process, one connection, WAL mode. At this app's scale (a handful of
 * collectors filling out forms) a single synchronous connection is not a
 * bottleneck, and it removes every class of pool-related bug.
 *
 * The driver is isolated to this file on purpose. Swapping better-sqlite3 for
 * another SQLite binding, or for a hosted database later, should mean editing
 * this module and nothing else.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/** @type {Database.Database|null} */
let connection = null;

/**
 * PRAGMAs applied to every connection, in order.
 *
 * foreign_keys is OFF by default in SQLite and must be set per connection, so
 * the schema's REFERENCES clauses are only actually enforced because of this.
 */
const PRAGMAS = [
  // Readers do not block the writer. Survives process crashes cleanly.
  ['journal_mode', 'WAL'],
  // Enforce the schema's foreign keys. Not optional for data integrity.
  ['foreign_keys', 'ON'],
  // WAL + NORMAL is durable against process crashes; only a host power loss can
  // lose the last transactions. The right trade for survey data on a container.
  ['synchronous', 'NORMAL'],
  // Wait rather than immediately throwing SQLITE_BUSY if a write overlaps.
  ['busy_timeout', '5000'],
  // Keep temp tables and sorting in memory instead of on disk.
  ['temp_store', 'MEMORY'],
  // Reclaim space from deletes gradually instead of in one long pause.
  ['auto_vacuum', 'INCREMENTAL'],
];

/**
 * Open (or return) the process-wide connection.
 * @param {{file: string, verbose?: boolean}} options
 * @returns {Database.Database}
 */
export function openDatabase({ file, verbose = false }) {
  if (connection) return connection;

  const directory = path.dirname(file);
  // recursive:true is also a no-op when the directory already exists, so this
  // doubles as the "first boot on a fresh container" path.
  fs.mkdirSync(directory, { recursive: true });

  connection = new Database(file, {
    verbose: verbose ? (sql) => process.stderr.write(`[sql] ${sql}\n`) : undefined,
  });

  for (const [name, value] of PRAGMAS) {
    connection.pragma(`${name} = ${value}`);
  }

  // Fail fast and loudly if foreign keys did not actually engage, rather than
  // discovering months later that ON DELETE CASCADE never ran.
  const [{ foreign_keys: fkEnabled }] = connection.pragma('foreign_keys');
  if (fkEnabled !== 1) {
    throw new Error('SQLite refused to enable foreign key enforcement.');
  }

  return connection;
}

/**
 * The open connection.
 * @returns {Database.Database}
 */
export function db() {
  if (!connection) {
    throw new Error('Database not open. Call openDatabase() during startup first.');
  }
  return connection;
}

export function closeDatabase() {
  if (connection) {
    // Fold the WAL back into the main file so a copied .db is complete.
    try {
      connection.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // A checkpoint failure must not prevent shutdown.
    }
    connection.close();
    connection = null;
  }
}

/**
 * Apply any migrations that have not run yet.
 *
 * Migrations are plain .sql files named `NNN_description.sql` and applied in
 * filename order. Each runs inside a transaction together with the bookkeeping
 * insert, so a failed migration leaves no record of having run and no partial
 * schema. Already-applied files are verified by checksum: editing a migration
 * that has shipped is an error, not something we silently ignore.
 *
 * @param {Database.Database} database
 * @param {{directory?: string, log?: (message: string) => void}} [options]
 * @returns {{applied: string[], alreadyCurrent: number}}
 */
export function migrate(database, options = {}) {
  const directory =
    options.directory ?? path.join(import.meta.dirname, 'migrations');
  const log = options.log ?? (() => {});

  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const files = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));

  const recorded = new Map(
    database
      .prepare('SELECT name, checksum FROM schema_migrations')
      .all()
      .map((row) => [row.name, row.checksum]),
  );

  const applied = [];
  let alreadyCurrent = 0;

  for (const name of files) {
    const sql = fs.readFileSync(path.join(directory, name), 'utf8');
    const checksum = sha256Hex(sql);

    if (recorded.has(name)) {
      if (recorded.get(name) !== checksum) {
        throw new Error(
          `Migration ${name} has changed since it was applied. ` +
            'Migrations are immutable once shipped; add a new one instead.',
        );
      }
      alreadyCurrent += 1;
      continue;
    }

    // better-sqlite3's transaction() wrapper cannot contain statements that
    // themselves start a transaction, which .exec() of a multi-statement file
    // does not, so this is safe.
    const run = database.transaction(() => {
      database.exec(sql);
      database
        .prepare(
          'INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)',
        )
        .run(name, checksum, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
    });
    run();

    applied.push(name);
    log(`applied migration ${name}`);
  }

  return { applied, alreadyCurrent };
}

/**
 * Hex SHA-256 of a string, used to detect edits to already-applied migrations.
 * @param {string} input
 */
function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
