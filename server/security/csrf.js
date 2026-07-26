/**
 * CSRF protection: a per-session synchronizer token, with an Origin check as a
 * second, independent layer.
 *
 * Why a token at all, in 2026, with SameSite=Strict cookies? Because OWASP is
 * explicit that SameSite "is useful as a defense-in-depth control but it does
 * not replace a proper CSRF defense": the protection is scoped to the
 * registrable domain rather than the origin, so a sibling subdomain or a
 * compromised same-site host is still a path in.
 *
 * Why Origin and not Sec-Fetch-Site? The Fetch Metadata spec only emits
 * Sec-Fetch-* from trustworthy origins, so those headers are absent entirely
 * when the app runs on a LAN over plain HTTP. Origin is sent on same-origin form
 * POSTs over HTTP and therefore works in both deployment phases. This is also
 * why the app sets Referrer-Policy to strict-origin-when-cross-origin rather
 * than no-referrer, which can null Origin out on non-CORS requests.
 */

import crypto from 'node:crypto';
import { html } from '../lib/html.js';

export const CSRF_FIELD_NAME = '_csrf';

/**
 * The hidden input every state-changing form must contain.
 *
 * Emit this as the FIRST field in any form that also has a file input. A
 * streaming multipart parser sees parts in wire order, so a token that arrives
 * after the file cannot be checked until the entire upload has been buffered,
 * which would let an unauthorized request spend our disk and bandwidth first.
 *
 * @param {string} token
 */
export function csrfField(token) {
  return html`<input type="hidden" name="${CSRF_FIELD_NAME}" value="${token}">`;
}

/**
 * Constant-time comparison of two tokens.
 *
 * timingSafeEqual throws when lengths differ, so length is checked first. That
 * leak is not meaningful: both tokens are fixed-length values we generated.
 *
 * @param {unknown} a
 * @param {unknown} b
 */
export function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Methods that must never change state, and so need no token. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** @param {string} method */
export function isSafeMethod(method) {
  return SAFE_METHODS.has(String(method).toUpperCase());
}

/**
 * Verify the request's Origin against the origin we are actually serving.
 *
 * Returns:
 *   'ok'      Origin present and matches
 *   'absent'  no Origin header at all
 *   'mismatch' Origin present and does not match
 *
 * 'absent' is reported separately rather than folded into a pass/fail so the
 * caller can decide policy. A small share of real traffic omits Origin, and the
 * synchronizer token is the primary defense, so absence is tolerated while a
 * mismatch is refused.
 *
 * @param {Request} request
 * @param {string[]} allowedOrigins
 * @returns {'ok'|'absent'|'mismatch'}
 */
export function checkOrigin(request, allowedOrigins) {
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') return 'absent';

  // Compare parsed origins, not raw strings, so a trailing slash or a default
  // port written explicitly does not cause a spurious mismatch.
  let candidate;
  try {
    candidate = new URL(origin).origin;
  } catch {
    return 'mismatch';
  }

  for (const allowed of allowedOrigins) {
    try {
      if (new URL(allowed).origin === candidate) return 'ok';
    } catch {
      // An unparseable configured origin is ignored rather than trusted.
    }
  }
  return 'mismatch';
}

/**
 * Full CSRF check for a state-changing request.
 *
 * @param {{
 *   request: Request,
 *   method: string,
 *   submittedToken: unknown,
 *   sessionToken: ?string,
 *   allowedOrigins: string[],
 * }} input
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function verifyCsrf({
  request,
  method,
  submittedToken,
  sessionToken,
  allowedOrigins,
}) {
  if (isSafeMethod(method)) return { ok: true };

  const originVerdict = checkOrigin(request, allowedOrigins);
  if (originVerdict === 'mismatch') {
    return { ok: false, reason: 'origin_mismatch' };
  }

  if (!sessionToken) {
    return { ok: false, reason: 'no_session' };
  }
  if (!tokensMatch(submittedToken, sessionToken)) {
    return { ok: false, reason: 'token_mismatch' };
  }
  return { ok: true };
}
