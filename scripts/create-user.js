#!/usr/bin/env node
/**
 * Create an account from the command line.
 *
 * Used by the installer to make the first administrator, and available to an
 * operator afterwards. The generated one-time password is printed once and is
 * not recoverable: only its hash is stored.
 *
 * Usage:
 *   npm run create-user -- --email you@example.org --name "Your Name" --role admin
 *
 * Options:
 *   --email <address>   required
 *   --name <name>       required
 *   --role <role>       admin | collector   (default: collector)
 *   --quiet             print only the password, for scripting
 *   --if-none           do nothing (exit 0) if any user already exists
 */

import { loadConfig, ensureDirectories } from '../server/config.js';
import { closeDatabase, migrate, openDatabase } from '../server/db/index.js';
import { probeHashing } from '../server/auth/passwords.js';
import { createUser } from '../server/auth/users.js';
import { db } from '../server/db/index.js';
import { ValidationErrors, validateEmail, validateRole, validateText } from '../server/lib/validate.js';
import { formatDateTime } from '../server/lib/format.js';

/**
 * Minimal argument parser. Deliberately strict: an unrecognized flag is an error
 * rather than something ignored, so a typo cannot silently create an account with
 * the wrong role.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--quiet') {
      out.quiet = true;
    } else if (arg === '--if-none') {
      out.ifNone = true;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--email' || arg === '--name' || arg === '--role') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} needs a value.`);
      }
      out[arg.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return out;
}

const USAGE = `
Create a Taco Analyzer account.

  npm run create-user -- --email you@example.org --name "Your Name" --role admin

  --email <address>   Email address used to sign in (required)
  --name <name>       Display name (required)
  --role <role>       admin or collector (default: collector)
  --if-none           Do nothing if any account already exists
  --quiet             Print only the generated password
`;

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}`);
    process.exit(64); // EX_USAGE
  }

  if (args.help) {
    process.stdout.write(USAGE);
    return;
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

  if (args.ifNone) {
    const existing = db().prepare('SELECT COUNT(*) AS n FROM users').get()?.n ?? 0;
    if (existing > 0) {
      if (!args.quiet) {
        process.stdout.write(
          `${existing} account(s) already exist, leaving them alone.\n`,
        );
      }
      closeDatabase();
      return;
    }
  }

  const errors = new ValidationErrors();
  const email = validateEmail(errors, 'email', args.email);
  const displayName = validateText(errors, 'name', args.name, {
    label: 'Name',
    required: true,
    maxLength: 120,
  });
  const role = validateRole(errors, 'role', args.role ?? 'collector');

  if (!errors.ok) {
    process.stderr.write('\n');
    for (const { message } of errors.list) {
      process.stderr.write(`  ${message}\n`);
    }
    process.stderr.write(USAGE);
    closeDatabase();
    process.exit(64);
  }

  await probeHashing({ log: args.quiet ? () => {} : (m) => process.stdout.write(`${m}\n`) });

  try {
    const { user, initialPassword, expiresAt } = await createUser({
      email,
      displayName,
      role,
      createdBy: null,
    });

    if (args.quiet) {
      process.stdout.write(`${initialPassword}\n`);
    } else {
      process.stdout.write(`
Account created.

  Name      ${user.displayName}
  Email     ${user.email}
  Role      ${user.role}
  Password  ${initialPassword}

This password is shown once and cannot be recovered. It expires
${formatDateTime(expiresAt)}, and must be changed at first sign-in.
`);
    }
  } catch (error) {
    process.stderr.write(`\n${error.message}\n\n`);
    closeDatabase();
    process.exit(1);
  }

  closeDatabase();
}

main().catch((error) => {
  process.stderr.write(`\n${error?.stack ?? error}\n\n`);
  process.exit(1);
});
