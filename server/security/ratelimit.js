/**
 * Login throttling.
 *
 * Two independent counters, because they stop different attacks:
 *
 *  - Per account: someone guessing one user's password.
 *  - Per source IP: someone spraying one common password across many accounts,
 *    which a per-account counter cannot see at all.
 *
 * OWASP deliberately gives no numbers here and warns that hard lockout can be
 * turned around into a denial of service against legitimate users. The
 * thresholds below are a reasoned synthesis; the one hard requirement is NIST
 * SP 800-63B 3.2.2, which SHALLs a cap of at most 100 consecutive failures
 * before the authenticator is disabled.
 *
 * Lockout is a mild remedy in this app specifically because accounts are
 * admin-provisioned and few, so an admin unlock path already exists.
 */

import { db } from '../db/index.js';
import { nowIso } from '../lib/format.js';

/** Consecutive failures decay after this much quiet. */
const DECAY_WINDOW_MS = 15 * 60 * 1000;

/** Failures before any delay is applied. */
const FREE_ATTEMPTS = 3;

/** First delay, then doubling. */
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60 * 1000;

/** Consecutive failures that trigger a timed lock, and how long it lasts. */
const LOCK_THRESHOLD = 10;
const LOCK_DURATION_MS = 15 * 60 * 1000;

/** NIST SHALL: disable the account past this many lifetime failures. */
const LIFETIME_FAILURE_CAP = 100;

/** Per-IP ceiling inside the window. */
const IP_FAILURE_LIMIT = 20;
const IP_WINDOW_MS = 15 * 60 * 1000;

/**
 * @param {number} ms
 * @param {number} [from]
 */
function isoIn(ms, from = Date.now()) {
  return new Date(from + ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * How long to stall a response given a consecutive-failure count.
 *
 * The delay is applied to unknown usernames too. If it were not, the presence or
 * absence of a delay would itself reveal whether an account exists, which is the
 * same leak the generic error message and the dummy hash exist to close.
 *
 * @param {number} failureCount count including the attempt just made
 * @returns {number} milliseconds
 */
export function delayForFailureCount(failureCount) {
  if (failureCount <= FREE_ATTEMPTS) return 0;
  const doublings = failureCount - FREE_ATTEMPTS - 1;
  return Math.min(BASE_DELAY_MS * 2 ** doublings, MAX_DELAY_MS);
}

/**
 * Current lock state for an account.
 *
 * Callers must verify the password BEFORE acting on this. Skipping the KDF for a
 * locked account makes the lock detectable by response time, which turns the
 * lockout itself into an account-enumeration oracle.
 *
 * @param {{locked_until: ?string, failed_login_count: number,
 *          last_failed_login_at: ?string}} userRow
 * @returns {{locked: boolean, lockedUntil: ?string, consecutiveFailures: number}}
 */
export function accountLockState(userRow) {
  const now = Date.now();

  const lockedUntil = userRow.locked_until;
  const locked = Boolean(lockedUntil) && Date.parse(lockedUntil) > now;

  // Failures older than the decay window no longer count toward the ladder.
  let consecutiveFailures = userRow.failed_login_count ?? 0;
  if (
    userRow.last_failed_login_at &&
    Date.parse(userRow.last_failed_login_at) + DECAY_WINDOW_MS <= now
  ) {
    consecutiveFailures = 0;
  }

  return { locked, lockedUntil: locked ? lockedUntil : null, consecutiveFailures };
}

/**
 * Record a failed attempt against an account.
 *
 * @param {number} userId
 * @param {number} priorConsecutiveFailures from accountLockState, already decayed
 * @returns {{consecutiveFailures: number, lockedUntil: ?string, disabled: boolean,
 *            delayMs: number}}
 */
export function recordAccountFailure(userId, priorConsecutiveFailures) {
  const consecutiveFailures = priorConsecutiveFailures + 1;
  const now = nowIso();

  const lockedUntil =
    consecutiveFailures >= LOCK_THRESHOLD ? isoIn(LOCK_DURATION_MS) : null;

  const database = db();
  const result = database
    .prepare(
      `UPDATE users
          SET failed_login_count     = ?,
              last_failed_login_at   = ?,
              lifetime_failed_logins = lifetime_failed_logins + 1,
              locked_until           = COALESCE(?, locked_until)
        WHERE id = ?
        RETURNING lifetime_failed_logins`,
    )
    .get(consecutiveFailures, now, lockedUntil, userId);

  // NIST SHALL: past the lifetime cap the authenticator is disabled outright and
  // only an admin can bring it back.
  let disabled = false;
  if (result && result.lifetime_failed_logins >= LIFETIME_FAILURE_CAP) {
    database.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(userId);
    database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    disabled = true;
  }

  return {
    consecutiveFailures,
    lockedUntil,
    disabled,
    delayMs: delayForFailureCount(consecutiveFailures),
  };
}

/**
 * Clear the per-account counters after a successful login.
 * lifetime_failed_logins is intentionally NOT reset: it is the NIST cap, and a
 * cap you can clear by occasionally logging in successfully is not a cap.
 * @param {number} userId
 */
export function clearAccountFailures(userId) {
  db()
    .prepare(
      `UPDATE users
          SET failed_login_count   = 0,
              last_failed_login_at = NULL,
              locked_until         = NULL,
              last_login_at        = ?
        WHERE id = ?`,
    )
    .run(nowIso(), userId);
}

/**
 * Log an attempt in the IP-keyed table and prune old rows.
 * @param {?string} ip
 * @param {boolean} successful
 */
export function recordAttempt(ip, successful) {
  const database = db();
  database
    .prepare(
      'INSERT INTO login_attempts (bucket, attempted_at, successful) VALUES (?, ?, ?)',
    )
    .run(`ip:${ip ?? 'unknown'}`, nowIso(), successful ? 1 : 0);

  // Pruning on write keeps this table small without a scheduled job.
  database
    .prepare('DELETE FROM login_attempts WHERE attempted_at <= ?')
    .run(isoIn(-IP_WINDOW_MS * 4));
}

/**
 * Whether an IP has exceeded its failure budget.
 *
 * Only meaningful with a real client address. Behind a reverse proxy this must
 * be the forwarded client IP, or every user shares one bucket and the app
 * denies service to itself. See config.trustProxy.
 *
 * @param {?string} ip
 * @returns {{allowed: boolean, failures: number, retryAfterSeconds: number}}
 */
export function checkIpThrottle(ip) {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS failures
         FROM login_attempts
        WHERE bucket = ? AND successful = 0 AND attempted_at > ?`,
    )
    .get(`ip:${ip ?? 'unknown'}`, isoIn(-IP_WINDOW_MS));

  const failures = row?.failures ?? 0;
  return {
    allowed: failures < IP_FAILURE_LIMIT,
    failures,
    retryAfterSeconds: Math.ceil(IP_WINDOW_MS / 1000),
  };
}

/**
 * Stall a response. Used to implement the delay ladder.
 *
 * Callers must not hold a database write open across this: SQLite serializes
 * writers, so sleeping with the write lock held would stall unrelated requests.
 *
 * @param {number} ms
 */
export function delay(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

export const THROTTLE_CONSTANTS = Object.freeze({
  DECAY_WINDOW_MS,
  FREE_ATTEMPTS,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  LOCK_THRESHOLD,
  LOCK_DURATION_MS,
  LIFETIME_FAILURE_CAP,
  IP_FAILURE_LIMIT,
  IP_WINDOW_MS,
});
