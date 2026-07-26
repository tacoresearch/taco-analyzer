/**
 * Server-side session store.
 *
 * Design points that matter (see docs/security-decisions.md):
 *
 *  - The database holds SHA-256(token), never the token. A leaked database file
 *    yields no usable sessions. Plain SHA-256 is correct because the token
 *    already carries 256 bits of entropy; there is nothing to brute-force, so a
 *    slow KDF here would only cost latency on every request.
 *  - Two independent expiries: a sliding idle timeout and a hard absolute
 *    ceiling. Idle alone lets a stolen token live forever if it is used.
 *  - The identifier is regenerated on login, on password change, and on any
 *    privilege change, with the old row deleted in the same transaction.
 */

import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { nowIso } from '../lib/format.js';

/** 32 bytes, base64url. 256 bits, well above the 128-bit ASVS floor. */
const TOKEN_BYTES = 32;
const CSRF_BYTES = 32;

/** Sliding inactivity window. OWASP suggests 15 to 30 minutes for low risk. */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Hard ceiling regardless of activity. Long enough for a full day of collecting,
 * comfortably inside NIST's AAL2 24-hour reauthentication ceiling.
 */
export const ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/**
 * Do not rewrite last_seen_at more than once a minute. Without this, every page
 * view is a database write, and the sliding timeout does not need per-request
 * resolution.
 */
const LAST_SEEN_REFRESH_MS = 60 * 1000;

/**
 * SHA-256 of a session token, hex. The stored primary key.
 * @param {string} token
 */
function tokenToId(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** @param {number} bytes */
function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * @param {number} ms
 * @param {number} [from]
 */
function isoIn(ms, from = Date.now()) {
  return new Date(from + ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Create a session for a user.
 *
 * @param {number} userId
 * @param {{ip?: ?string, userAgent?: ?string}} [context]
 * @returns {{token: string, csrfToken: string, absoluteExpiresAt: string}}
 */
export function createSession(userId, context = {}) {
  const token = randomToken(TOKEN_BYTES);
  const csrfToken = randomToken(CSRF_BYTES);
  const now = nowIso();
  const absoluteExpiresAt = isoIn(ABSOLUTE_TIMEOUT_MS);

  db()
    .prepare(
      `INSERT INTO sessions
         (id, user_id, created_at, last_seen_at, absolute_expires_at, csrf_token, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      tokenToId(token),
      userId,
      now,
      now,
      absoluteExpiresAt,
      csrfToken,
      context.ip ?? null,
      // Bounded: a hostile client can send a very long User-Agent, and this
      // column is only ever shown as a hint about which device signed in.
      context.userAgent ? String(context.userAgent).slice(0, 400) : null,
    );

  return { token, csrfToken, absoluteExpiresAt };
}

/**
 * Look up a session and its user.
 *
 * Returns null for a missing, expired, or deactivated-user session, deleting the
 * row when it is expired so the table stays clean without a separate sweep.
 *
 * @param {?string} token
 * @returns {{
 *   session: {id: string, userId: number, csrfToken: string, createdAt: string},
 *   user: {id: number, email: string, displayName: string, role: 'admin'|'collector',
 *          mustChangePassword: boolean, passwordExpiresAt: ?string},
 * } | null}
 */
export function loadSession(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 200) {
    return null;
  }
  const id = tokenToId(token);

  const row = db()
    .prepare(
      `SELECT s.id                AS session_id,
              s.user_id           AS user_id,
              s.created_at         AS created_at,
              s.last_seen_at       AS last_seen_at,
              s.absolute_expires_at AS absolute_expires_at,
              s.csrf_token         AS csrf_token,
              u.email              AS email,
              u.display_name       AS display_name,
              u.role               AS role,
              u.is_active          AS is_active,
              u.must_change_password AS must_change_password,
              u.password_expires_at  AS password_expires_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
    )
    .get(id);

  if (!row) return null;

  const now = Date.now();
  const absoluteExpired = Date.parse(row.absolute_expires_at) <= now;
  const idleExpired = Date.parse(row.last_seen_at) + IDLE_TIMEOUT_MS <= now;

  if (absoluteExpired || idleExpired) {
    db().prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }

  // A deactivated account must not keep working on an existing session.
  if (row.is_active !== 1) {
    db().prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
    return null;
  }

  if (Date.parse(row.last_seen_at) + LAST_SEEN_REFRESH_MS <= now) {
    db()
      .prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
      .run(nowIso(), id);
  }

  return {
    session: {
      id: row.session_id,
      userId: row.user_id,
      csrfToken: row.csrf_token,
      createdAt: row.created_at,
    },
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      mustChangePassword: row.must_change_password === 1,
      passwordExpiresAt: row.password_expires_at,
    },
  };
}

/**
 * Replace a session with a fresh one for the same user.
 *
 * Required on login, on password change, and on any privilege change (ASVS
 * 7.2.4). Both statements run in one transaction so there is never a moment
 * where the old token still works alongside the new one.
 *
 * @param {?string} oldToken may be null when there was no prior session
 * @param {number} userId
 * @param {{ip?: ?string, userAgent?: ?string}} [context]
 */
export function rotateSession(oldToken, userId, context = {}) {
  const database = db();
  const run = database.transaction(() => {
    if (oldToken) {
      database.prepare('DELETE FROM sessions WHERE id = ?').run(tokenToId(oldToken));
    }
    return createSession(userId, context);
  });
  return run();
}

/** @param {?string} token */
export function destroySession(token) {
  if (typeof token !== 'string' || !token) return;
  db().prepare('DELETE FROM sessions WHERE id = ?').run(tokenToId(token));
}

/**
 * End every session for a user. Called when an account is deactivated, its role
 * changes, or its password is reset by an admin.
 * @param {number} userId
 * @returns {number} sessions ended
 */
export function destroyUserSessions(userId) {
  return db().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

/**
 * Delete sessions past their absolute expiry, plus stale throttling rows.
 * Cheap enough to call on an interval from the server process.
 * @returns {{sessions: number, loginAttempts: number}}
 */
export function pruneExpired() {
  const database = db();
  const now = nowIso();
  const sessions = database
    .prepare('DELETE FROM sessions WHERE absolute_expires_at <= ?')
    .run(now).changes;
  // Login attempt rows only matter inside the throttling window; keep a day for
  // a little forensic breathing room, then drop them.
  const cutoff = isoIn(-24 * 60 * 60 * 1000);
  const loginAttempts = database
    .prepare('DELETE FROM login_attempts WHERE attempted_at <= ?')
    .run(cutoff).changes;
  return { sessions, loginAttempts };
}

/**
 * Sessions for a user, newest first, for an "active devices" display.
 * @param {number} userId
 */
export function listUserSessions(userId) {
  return db()
    .prepare(
      `SELECT id, created_at, last_seen_at, ip, user_agent
         FROM sessions
        WHERE user_id = ?
        ORDER BY last_seen_at DESC`,
    )
    .all(userId);
}
