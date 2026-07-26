/**
 * Process entry point.
 *
 * Startup deliberately fails fast and loudly. A misconfigured deployment should
 * refuse to start with an explanation, not boot into a state where logins
 * mysteriously do not work. Everything that can be checked at startup is:
 * configuration coherence, directory permissions, schema migrations, and whether
 * the password KDF actually runs at the parameters we intend.
 */

import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { configWarnings, ensureDirectories, loadConfig } from './config.js';
import { closeDatabase, migrate, openDatabase } from './db/index.js';
import { probeHashing } from './auth/passwords.js';
import { pruneExpired } from './auth/sessions.js';
import { prunePreAuthTokens } from './auth/preauth.js';

/** How often to sweep expired sessions and throttling rows. */
const PRUNE_INTERVAL_MS = 15 * 60 * 1000;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function warn(message) {
  process.stderr.write(`WARNING: ${message}\n`);
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // A configuration error is an operator problem, so it gets a plain message
    // rather than a stack trace.
    process.stderr.write(`\nConfiguration error:\n\n${error.message}\n\n`);
    process.exit(78); // EX_CONFIG
  }

  ensureDirectories(config);

  for (const message of configWarnings(config)) {
    warn(message);
  }

  const database = openDatabase({ file: config.databaseFile, verbose: config.logSql });
  const { applied, alreadyCurrent } = migrate(database, { log });
  if (applied.length === 0) {
    log(`database schema current (${alreadyCurrent} migrations)`);
  }

  // Verify the password KDF before accepting any traffic. Discovering that
  // scrypt refuses our parameters on the first login attempt would be a much
  // worse way to find out.
  const { algorithm } = await probeHashing({ log });

  const app = createApp({ config });

  const server = serve(
    { fetch: app.fetch, hostname: config.host, port: config.port },
    (info) => {
      log('');
      log('  Taco Analyzer is running.');
      log(`  listening   http://${info.address}:${info.port}`);
      log(`  base URL    ${config.baseUrl}`);
      log(`  data        ${config.dataDir}`);
      log(`  hashing     ${algorithm}`);
      log(`  cookies     ${config.cookieSecure ? 'Secure (__Host- prefixed)' : 'NOT Secure'}`);
      log('');
    },
  );

  const prune = setInterval(() => {
    try {
      const { sessions, loginAttempts } = pruneExpired();
      const preAuth = prunePreAuthTokens();
      if (sessions || loginAttempts || preAuth) {
        log(
          `pruned ${sessions} sessions, ${loginAttempts} login attempts, ` +
            `${preAuth} pre-auth tokens`,
        );
      }
    } catch (error) {
      warn(`prune failed: ${error.message}`);
    }
  }, PRUNE_INTERVAL_MS);
  // Do not hold the event loop open just for the sweep.
  prune.unref();

  let shuttingDown = false;
  /** @param {string} signal */
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`\n${signal} received, shutting down`);
    clearInterval(prune);

    // Stop accepting connections, then close the database so the WAL is folded
    // back into the main file and a copied .db is complete.
    server.close(() => {
      closeDatabase();
      process.exit(0);
    });

    // Do not hang forever on a stuck connection. systemd sends SIGKILL after
    // TimeoutStopSec anyway; exiting first keeps the logs tidy.
    setTimeout(() => {
      warn('shutdown timed out, exiting anyway');
      try {
        closeDatabase();
      } catch {
        // Nothing useful to do at this point.
      }
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // An unhandled rejection means an await was missed somewhere. Log it loudly
  // rather than letting Node's default behaviour take the process down silently.
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[unhandledRejection] ${reason?.stack ?? reason}\n`);
  });
}

main().catch((error) => {
  process.stderr.write(`\nFailed to start:\n\n${error?.stack ?? error}\n\n`);
  process.exit(1);
});
