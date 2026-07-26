/**
 * CSRF tokens for forms shown before a session exists, which in practice means
 * the login form.
 *
 * Why this exists at all: login CSRF is a real attack, not a theoretical one. An
 * attacker who can forge a login POST can force a victim's browser into a session
 * the attacker controls, and then observe what the victim does in it. OWASP wants
 * the login form protected like any other state-changing form.
 *
 * Every other form in this app carries a synchronizer token stored on its session
 * row. An anonymous visitor has no session row, so rather than exempting the
 * login form from the CSRF check (the tempting shortcut), pre-authentication
 * forms get their own short-lived server-side store. Same pattern, same
 * guarantees, different table.
 *
 * As with sessions, only a hash of the cookie value is stored, so a leaked
 * database yields nothing usable.
 */

import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { nowIso } from '../lib/format.js';

/** Cookie carrying the pre-auth handle. Distinct from the session cookie. */
export const PRE_AUTH_COOKIE = 'pa';
export const PRE_AUTH_COOKIE_SECURE = '__Host-pa';

/**
 * Long enough that someone can leave the login page open, get a coffee, and
 * still sign in; short enough that these rows do not accumulate.
 */
const TTL_MS = 60 * 60 * 1000;

/** @param {string} value */
function toId(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Issue a fresh pre-auth token.
 * @returns {{cookieValue: string, csrfToken: string}}
 */
export function issuePreAuthToken() {
  const cookieValue = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TTL_MS)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  const database = db();
  database
    .prepare(
      'INSERT INTO pre_auth_tokens (id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?)',
    )
    .run(toId(cookieValue), csrfToken, nowIso(), expiresAt);

  // Opportunistic cleanup on write, so no scheduled job is needed for a table
  // that only ever holds a handful of live rows.
  database.prepare('DELETE FROM pre_auth_tokens WHERE expires_at <= ?').run(nowIso());

  return { cookieValue, csrfToken };
}

/**
 * The CSRF token expected for a pre-auth form, given its cookie value.
 *
 * Deliberately NOT single-use. A failed login re-renders the form, and consuming
 * the token on a wrong password would mean the retry fails for a confusing
 * second reason. Expiry bounds the lifetime instead, which is how per-session
 * synchronizer tokens normally work.
 *
 * @param {?string} cookieValue
 * @returns {string|null}
 */
export function preAuthCsrfToken(cookieValue) {
  if (typeof cookieValue !== 'string' || !cookieValue || cookieValue.length > 200) {
    return null;
  }
  const row = db()
    .prepare('SELECT csrf_token, expires_at FROM pre_auth_tokens WHERE id = ?')
    .get(toId(cookieValue));
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    db().prepare('DELETE FROM pre_auth_tokens WHERE id = ?').run(toId(cookieValue));
    return null;
  }
  return row.csrf_token;
}

/**
 * Drop a pre-auth token once it has served its purpose, i.e. after a successful
 * login. Keeps the table from holding rows nobody will use again.
 * @param {?string} cookieValue
 */
export function discardPreAuthToken(cookieValue) {
  if (typeof cookieValue !== 'string' || !cookieValue) return;
  db().prepare('DELETE FROM pre_auth_tokens WHERE id = ?').run(toId(cookieValue));
}

/** Remove expired rows. Called by the periodic prune alongside sessions. */
export function prunePreAuthTokens() {
  return db().prepare('DELETE FROM pre_auth_tokens WHERE expires_at <= ?').run(nowIso())
    .changes;
}
