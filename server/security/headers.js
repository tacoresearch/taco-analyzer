/**
 * Security response headers, set explicitly rather than by accepting a
 * middleware's defaults.
 *
 * The explicitness is deliberate. Two common middleware defaults are actively
 * wrong for this app:
 *
 *  - `Referrer-Policy: no-referrer` can null out the Origin header on non-CORS
 *    requests, which would break the CSRF Origin check.
 *  - HSTS on by default is a self-inflicted outage during the plain-HTTP phase:
 *    any browser that once reached the app over HTTPS caches the pin and then
 *    refuses the LAN HTTP URL, with no user-facing override.
 *
 * See docs/security-decisions.md.
 */

/**
 * Content-Security-Policy.
 *
 * `default-src 'none'` rather than `'self'` so that a directive we forgot to
 * name fails closed instead of quietly allowing a resource type.
 *
 * No nonces are needed because every script and stylesheet is an external file.
 * That is what makes a bare `script-src 'self'` sufficient. If an inline script
 * is ever introduced, the fix is a nonce, never `'unsafe-inline'`.
 */
const CSP_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  // blob: is required by the photo field, which previews a chosen file with
  // URL.createObjectURL before it is uploaded.
  "img-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  // Does not inherit from default-src, so it has to be stated.
  "frame-ancestors 'none'",
  // Stops injected markup from posting a form (and its CSRF token) elsewhere.
  "form-action 'self'",
  // Blocks an injected <base href> from rewriting every relative URL.
  "base-uri 'none'",
  "object-src 'none'",
];

/**
 * Build the header set.
 *
 * @param {{https: boolean, hstsMaxAgeSeconds?: number}} options
 * @returns {Record<string, string>}
 */
export function securityHeaders({ https, hstsMaxAgeSeconds = 63072000 }) {
  /** @type {Record<string, string>} */
  const headers = {
    'Content-Security-Policy': CSP_DIRECTIVES.join('; '),

    // Never 'no-referrer': see the module comment.
    'Referrer-Policy': 'strict-origin-when-cross-origin',

    // Without this, a browser may sniff an uploaded image as HTML and execute
    // it on our own origin, turning any upload into stored XSS.
    'X-Content-Type-Options': 'nosniff',

    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-site',

    // The app has no need for any of these. Note this does not affect
    // <input type="file" capture>, which is a file picker rather than the
    // camera API, so mobile photo capture still works.
    'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=(), usb=()',

    // Redundant with frame-ancestors in current browsers, kept for older ones.
    'X-Frame-Options': 'DENY',

    // Explicitly disable the legacy XSS auditor, which was itself an
    // information-leak vector. OWASP recommends sending 0 rather than omitting.
    'X-XSS-Protection': '0',
  };

  // Only meaningful, and only safe, once TLS is actually in front of the app.
  // No `preload`: that is effectively irreversible and needs a deliberate,
  // separate decision once the public hostname has been stable on HTTPS.
  if (https) {
    headers['Strict-Transport-Security'] =
      `max-age=${hstsMaxAgeSeconds}; includeSubDomains`;
  }

  return headers;
}

/**
 * Headers for an authenticated HTML page. Keeps pages with session-specific
 * content out of every cache, including the browser's back/forward store.
 * @returns {Record<string, string>}
 */
export function noStoreHeaders() {
  return {
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
  };
}

/**
 * Sent on logout so the browser drops its own copies of session state, not just
 * the cookie.
 */
export function clearSiteDataHeader() {
  return { 'Clear-Site-Data': '"cache", "cookies", "storage"' };
}
