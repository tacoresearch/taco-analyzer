#!/usr/bin/env node
/**
 * Apply pending migrations, then exit.
 *
 * Safe to run on every deploy: already-applied migrations are skipped, and an
 * edit to a migration that has already run is a hard error rather than a silent
 * no-op.
 */

import { loadConfig, ensureDirectories } from '../server/config.js';
import { closeDatabase, migrate, openDatabase } from '../server/db/index.js';

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`\nConfiguration error:\n\n${error.message}\n\n`);
    process.exit(78);
  }

  ensureDirectories(config);

  const database = openDatabase({ file: config.databaseFile });
  const { applied, alreadyCurrent } = migrate(database, {
    log: (message) => process.stdout.write(`${message}\n`),
  });

  if (applied.length === 0) {
    process.stdout.write(
      `Schema already current (${alreadyCurrent} migration${alreadyCurrent === 1 ? '' : 's'}).\n`,
    );
  } else {
    process.stdout.write(`Applied ${applied.length} migration(s).\n`);
  }

  closeDatabase();
}

main();
