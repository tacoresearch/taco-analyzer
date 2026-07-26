/**
 * User accounts and the authentication flow.
 *
 * The login path here is written to be uniform in *time*, not just in wording.
 * A generic "Login failed" message is worthless if a missing account returns in
 * two milliseconds while a real one spends 300 in the KDF: response latency is
 * machine-measurable and becomes a reliable account-enumeration oracle.
 *
 * So `authenticate` always performs one password verification (against a dummy
 * hash when the account does not exist), always applies the same delay ladder,
 * and evaluates every rejection reason only AFTER that work is done. The
 * lockout check in particular comes after verification, not before, for exactly
 * this reason.
 */

import { db } from '../db/index.js';
import { nowIso } from '../lib/format.js';
import {
  checkPasswordPolicy,
  generateInitialPassword,
  hashPassword,
  verifyDummyPassword,
  verifyPassword,
} from './passwords.js';
import {
  accountLockState,
  checkIpThrottle,
  clearAccountFailures,
  delay,
  recordAccountFailure,
  recordAttempt,
} from '../security/ratelimit.js';
import { destroyUserSessions } from './sessions.js';

/** How long an admin-issued initial password stays usable. */
const INITIAL_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000;

/** @param {number} ms */
function isoIn(ms) {
  return new Date(Date.now() + ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Public shape of a user. Never includes the password hash.
 * @param {any} row
 */
function toUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active === 1,
    mustChangePassword: row.must_change_password === 1,
    passwordExpiresAt: row.password_expires_at,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    lockedUntil: row.locked_until,
    failedLoginCount: row.failed_login_count,
    lifetimeFailedLogins: row.lifetime_failed_logins,
  };
}

/** @param {string} email */
export function findUserByEmail(email) {
  return db()
    .prepare('SELECT * FROM users WHERE email = ?')
    .get(String(email).trim().toLowerCase());
}

/** @param {number} id */
export function findUserById(id) {
  return toUser(db().prepare('SELECT * FROM users WHERE id = ?').get(id));
}

export function listUsers() {
  return db()
    .prepare(
      `SELECT u.*,
              (SELECT COUNT(*) FROM surveys s
                WHERE s.user_id = u.id AND s.status = 'submitted') AS survey_count
         FROM users u
        ORDER BY u.display_name COLLATE NOCASE`,
    )
    .all()
    .map((row) => ({ ...toUser(row), surveyCount: row.survey_count }));
}

export function countAdmins() {
  return (
    db()
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1")
      .get()?.n ?? 0
  );
}

/**
 * Create an account with a server-generated one-time password.
 *
 * The admin never chooses the password, so no guessable house pattern can exist
 * across accounts. The plaintext is returned exactly once, for the admin to hand
 * over, and is never recoverable afterwards.
 *
 * @param {{email: string, displayName: string, role: 'admin'|'collector',
 *          createdBy: ?number}} input
 * @returns {Promise<{user: object, initialPassword: string, expiresAt: string}>}
 */
export async function createUser({ email, displayName, role, createdBy }) {
  const normalizedEmail = String(email).trim().toLowerCase();
  const initialPassword = generateInitialPassword();
  const passwordHash = await hashPassword(initialPassword);
  const expiresAt = isoIn(INITIAL_PASSWORD_TTL_MS);
  const now = nowIso();

  let row;
  try {
    row = db()
      .prepare(
        `INSERT INTO users
           (email, display_name, password_hash, role, is_active,
            must_change_password, password_expires_at, password_updated_at,
            created_at, created_by)
         VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        normalizedEmail,
        String(displayName).trim(),
        passwordHash,
        role,
        expiresAt,
        now,
        now,
        createdBy ?? null,
      );
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) {
      const conflict = new Error('An account with that email address already exists.');
      conflict.code = 'EMAIL_TAKEN';
      throw conflict;
    }
    throw error;
  }

  return { user: toUser(row), initialPassword, expiresAt };
}

/**
 * Issue a fresh one-time password for an existing account.
 *
 * Every existing session is terminated: if the account needed a reset, any live
 * session on it is suspect.
 *
 * @param {number} userId
 * @returns {Promise<{initialPassword: string, expiresAt: string}>}
 */
export async function resetPassword(userId) {
  const initialPassword = generateInitialPassword();
  const passwordHash = await hashPassword(initialPassword);
  const expiresAt = isoIn(INITIAL_PASSWORD_TTL_MS);

  const database = db();
  const run = database.transaction(() => {
    database
      .prepare(
        `UPDATE users
            SET password_hash        = ?,
                must_change_password = 1,
                password_expires_at  = ?,
                password_updated_at  = ?,
                failed_login_count   = 0,
                last_failed_login_at = NULL,
                locked_until         = NULL
          WHERE id = ?`,
      )
      .run(passwordHash, expiresAt, nowIso(), userId);
    database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  });
  run();

  return { initialPassword, expiresAt };
}

/**
 * Set a user-chosen password after policy checks.
 *
 * Clears the must-change gate and the expiry, since this is now a real password
 * rather than an admin-issued handover credential. NIST forbids periodic expiry,
 * so no new expiry is set.
 *
 * @param {number} userId
 * @param {string} newPassword
 * @param {{email: string, displayName: string}} context
 * @returns {Promise<{ok: boolean, problems: string[]}>}
 */
export async function setChosenPassword(userId, newPassword, context) {
  const problems = checkPasswordPolicy(newPassword, context);
  if (problems.length > 0) return { ok: false, problems };

  const passwordHash = await hashPassword(newPassword);
  db()
    .prepare(
      `UPDATE users
          SET password_hash        = ?,
              must_change_password = 0,
              password_expires_at  = NULL,
              password_updated_at  = ?,
              failed_login_count   = 0,
              last_failed_login_at = NULL,
              locked_until         = NULL
        WHERE id = ?`,
    )
    .run(passwordHash, nowIso(), userId);

  return { ok: true, problems: [] };
}

/**
 * Activate or deactivate an account. Deactivating ends its sessions immediately
 * (ASVS 7.4.2) and clears the lifetime failure counter, since re-enabling an
 * account disabled by the NIST cap is exactly the admin intervention that cap
 * calls for.
 *
 * @param {number} userId
 * @param {boolean} isActive
 */
export function setUserActive(userId, isActive) {
  const database = db();
  const run = database.transaction(() => {
    database
      .prepare(
        `UPDATE users
            SET is_active              = ?,
                failed_login_count     = 0,
                last_failed_login_at   = NULL,
                locked_until           = NULL,
                lifetime_failed_logins = CASE WHEN ? = 1 THEN 0 ELSE lifetime_failed_logins END
          WHERE id = ?`,
      )
      .run(isActive ? 1 : 0, isActive ? 1 : 0, userId);
    if (!isActive) {
      database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
  });
  run();
}

/**
 * Change a user's role. A privilege change invalidates existing sessions, so the
 * new role cannot be exercised on a session established under the old one.
 * @param {number} userId
 * @param {'admin'|'collector'} role
 */
export function setUserRole(userId, role) {
  const database = db();
  const run = database.transaction(() => {
    database.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
    database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  });
  run();
}

/**
 * Attempt a login.
 *
 * Every failure mode returns the same `reason: 'invalid'` with the same generic
 * message, except the two cases a user genuinely cannot act on without help
 * (a timed lock, and an expired handover password), which are distinguished only
 * AFTER the password was verified correct. Revealing "your password expired" to
 * someone who supplied the right password leaks nothing they do not know.
 *
 * @param {{email: unknown, password: unknown, ip: ?string, userAgent: ?string}} input
 * @returns {Promise<
 *   | {ok: true, user: object, mustChangePassword: boolean}
 *   | {ok: false, reason: 'invalid'|'locked'|'expired'|'ip_throttled'|'disabled',
 *      retryAfterSeconds?: number, lockedUntil?: string}
 * >}
 */
export async function authenticate({ email, password, ip, userAgent }) {
  // A spraying source is stopped before it can consume KDF time at all. This is
  // the one check that precedes verification, and it is keyed on the source
  // address rather than on any account, so it reveals nothing about accounts.
  const ipThrottle = checkIpThrottle(ip);
  if (!ipThrottle.allowed) {
    return {
      ok: false,
      reason: 'ip_throttled',
      retryAfterSeconds: ipThrottle.retryAfterSeconds,
    };
  }

  const normalizedEmail =
    typeof email === 'string' ? email.trim().toLowerCase() : '';
  const suppliedPassword = typeof password === 'string' ? password : '';
  const row = normalizedEmail ? findUserByEmail(normalizedEmail) : null;

  const lockState = row
    ? accountLockState(row)
    : { locked: false, lockedUntil: null, consecutiveFailures: 0 };

  // Always spend the KDF budget, whether or not the account exists.
  let passwordOk = false;
  let needsRehash = false;
  if (row) {
    const result = await verifyPassword(suppliedPassword, row.password_hash);
    passwordOk = result.ok;
    needsRehash = result.needsRehash;
  } else {
    await verifyDummyPassword();
  }

  /* --- Now, and only now, decide the outcome. --- */

  if (!row || !passwordOk) {
    // Note the delay is applied for unknown accounts too, keyed off the IP
    // counter, so the presence of a delay is not itself an existence oracle.
    let delayMs;
    if (row) {
      const failure = recordAccountFailure(row.id, lockState.consecutiveFailures);
      delayMs = failure.delayMs;
    } else {
      const { failures } = checkIpThrottle(ip);
      delayMs = Math.min(1000 * 2 ** Math.max(0, failures - 3), 60000);
    }
    recordAttempt(ip, false);
    await delay(delayMs);
    return { ok: false, reason: 'invalid' };
  }

  // The password was correct. Remaining refusals are account-state problems.

  if (row.is_active !== 1) {
    recordAttempt(ip, false);
    await delay(delayForCorrectButRefused());
    return { ok: false, reason: 'disabled' };
  }

  if (lockState.locked) {
    recordAttempt(ip, false);
    await delay(delayForCorrectButRefused());
    return { ok: false, reason: 'locked', lockedUntil: lockState.lockedUntil };
  }

  if (
    row.password_expires_at &&
    Date.parse(row.password_expires_at) <= Date.now()
  ) {
    recordAttempt(ip, false);
    await delay(delayForCorrectButRefused());
    return { ok: false, reason: 'expired' };
  }

  // Success. Upgrade the stored hash if it was made with weaker parameters or an
  // older algorithm, while the plaintext is still available.
  if (needsRehash) {
    try {
      const upgraded = await hashPassword(suppliedPassword);
      db()
        .prepare('UPDATE users SET password_hash = ?, password_updated_at = ? WHERE id = ?')
        .run(upgraded, nowIso(), row.id);
    } catch {
      // A failed upgrade must never fail the login; the old hash is still valid.
    }
  }

  clearAccountFailures(row.id);
  recordAttempt(ip, true);

  return {
    ok: true,
    user: toUser(row),
    mustChangePassword: row.must_change_password === 1,
  };
}

/**
 * A small fixed delay for "password was right but the account cannot be used".
 * Keeps these responses from being conspicuously faster than a rejected
 * password, which would let an attacker who has already found a valid password
 * map account states cheaply.
 */
function delayForCorrectButRefused() {
  return 250;
}

/**
 * Delete a user, but only when they hold no data. Surveys reference users with
 * ON DELETE RESTRICT, so a collector with submissions cannot be deleted without
 * losing the provenance of their data; deactivate them instead.
 * @param {number} userId
 * @returns {{deleted: boolean, reason?: string}}
 */
export function deleteUserIfUnused(userId) {
  const surveys = db()
    .prepare('SELECT COUNT(*) AS n FROM surveys WHERE user_id = ?')
    .get(userId)?.n;
  if (surveys > 0) {
    return {
      deleted: false,
      reason:
        'That account has submitted surveys. Deactivate it instead, so the data ' +
        'keeps its author.',
    };
  }
  destroyUserSessions(userId);
  db().prepare('DELETE FROM users WHERE id = ?').run(userId);
  return { deleted: true };
}
