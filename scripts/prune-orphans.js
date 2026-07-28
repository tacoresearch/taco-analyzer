#!/usr/bin/env node
/**
 * Find upload files that no survey and no pending upload references.
 *
 * Reports by default and requires --delete to remove anything, because these are
 * the user's photos and a heuristic that deletes them by default is a bad trade.
 *
 * Orphans come from two places:
 *  - Submissions that failed validation before unclaimed uploads were tracked.
 *    Every one of those leaked a file permanently.
 *  - A crash between writing a file and committing its database row.
 *
 * Usage:
 *   npm run prune-orphans            # list them
 *   npm run prune-orphans -- --delete
 */

import { loadConfig, ensureDirectories } from '../server/config.js';
import { closeDatabase, migrate, openDatabase } from '../server/db/index.js';
import { findOrphanedUploads } from '../server/db/pending-photos.js';

function main() {
  const shouldDelete = process.argv.includes('--delete');

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`\nConfiguration error:\n\n${error.message}\n\n`);
    process.exit(78);
  }

  ensureDirectories(config);
  const database = openDatabase({ file: config.databaseFile });
  migrate(database);

  const { orphans, bytes, deleted } = findOrphanedUploads(config.uploadDir, {
    delete: shouldDelete,
  });

  if (orphans.length === 0) {
    process.stdout.write('No orphaned uploads. Every file belongs to a survey.\n');
    closeDatabase();
    return;
  }

  process.stdout.write(
    `\n${orphans.length} orphaned file(s) in ${config.uploadDir}, ` +
      `${(bytes / 1024).toFixed(0)} KB total:\n\n`,
  );
  for (const name of orphans) process.stdout.write(`  ${name}\n`);

  if (shouldDelete) {
    process.stdout.write(`\nDeleted ${deleted} file(s).\n\n`);
  } else {
    process.stdout.write(
      '\nNothing was deleted. These are photos somebody took, so check that none ' +
        'of them matter before removing them.\n' +
        'To delete: sudo deploy/taco-cli.sh prune-orphans --delete\n\n',
    );
  }

  closeDatabase();
}

main();
