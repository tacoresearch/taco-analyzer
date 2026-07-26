#!/usr/bin/env node
/**
 * Issue a fresh one-time password for an existing account, from the command line.
 *
 * This is the recovery path when nobody can reach the admin area: a locked-out
 * last administrator, or an expired initial password. It requires shell access to
 * the container, which is the point.
 *
 * Every existing session for the account is ended, and the account is unlocked
 * and reactivated, since an operator running this is explicitly intervening.
 *
 * Usage:
 *   npm run reset-password -- --email you@example.org
 */

import { loadConfig, ensureDirectories } from '../server/config.js';
import { closeDatabase, migrate, openDatabase } from '../server/db/index.js';
import { probeHashing } from '../server/auth/passwords.js';
import { findUserByEmail, resetPassword, setUserActive } from '../server/auth/users.js';
import { formatDateTime } from '../server/lib/format.js';

const USAGE = `
Issue a new one-time password for an existing account.

  npm run reset-password -- --email you@example.org

  --email <address>   The account to reset (required)
  --activate          Also reactivate the account if it was deactivated
`;

async function main() {
  const argv = process.argv.slice(2);
  let email = null;
  let activate = false;

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--email') {
      email = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--activate') {
      activate = true;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write(USAGE);
      return;
    } else {
      process.stderr.write(`Unknown option: ${argv[i]}\n${USAGE}`);
      process.exit(64);
    }
  }

  if (!email) {
    process.stderr.write(`--email is required.\n${USAGE}`);
    process.exit(64);
  }

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
  await probeHashing({ log: () => {} });

  const row = findUserByEmail(email);
  if (!row) {
    // No enumeration concern here: reaching this script already requires shell
    // access to the box, so a clear message is more useful than a vague one.
    process.stderr.write(`\nNo account found for ${email}.\n\n`);
    closeDatabase();
    process.exit(1);
  }

  if (activate && row.is_active !== 1) {
    setUserActive(row.id, true);
  }

  const { initialPassword, expiresAt } = await resetPassword(row.id);

  process.stdout.write(`
Password reset for ${row.display_name} (${row.email}).

  Password  ${initialPassword}

Shown once, not recoverable. Expires ${formatDateTime(expiresAt)}.
Must be changed at next sign-in. All existing sessions were ended.
`);

  closeDatabase();
}

main().catch((error) => {
  process.stderr.write(`\n${error?.stack ?? error}\n\n`);
  process.exit(1);
});
