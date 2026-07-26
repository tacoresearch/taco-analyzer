/**
 * Request-level auth: cookie handling, session attachment, and the guards that
 * routes compose to state their access requirements.
 */

import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { loadSession, destroySession } from './sessions.js';
import {
  PRE_AUTH_COOKIE,
  PRE_AUTH_COOKIE_SECURE,
  issuePreAuthToken,
  preAuthCsrfToken,
} from './preauth.js';
import { verifyCsrf, CSRF_FIELD_NAME } from '../security/csrf.js';
import { clearSiteDataHeader } from '../security/headers.js';

/**
 * The pre-auth cookie name for the current transport. Mirrors the session
 * cookie's naming rule: the `__Host-` prefix requires `Secure`, which a
 * non-secure origin cannot set at all.
 * @param {import('hono').Context} c
 */
function preAuthCookieName(c) {
  return c.get('config').cookieSecure ? PRE_AUTH_COOKIE_SECURE : PRE_AUTH_COOKIE;
}

/** @param {import('hono').Context} c */
export function readPreAuthCookie(c) {
  return getCookie(c, preAuthCookieName(c)) ?? getCookie(c, PRE_AUTH_COOKIE) ?? null;
}

/**
 * Ensure the visitor has a pre-auth CSRF token, and return it for embedding in a
 * form. Reuses an existing valid one so opening the login page in two tabs does
 * not invalidate the first.
 * @param {import('hono').Context} c
 * @returns {string} the CSRF token to put in the form
 */
export function ensurePreAuthCsrfToken(c) {
  const existing = readPreAuthCookie(c);
  const existingToken = existing ? preAuthCsrfToken(existing) : null;
  if (existingToken) return existingToken;

  const { cookieValue, csrfToken } = issuePreAuthToken();
  const config = c.get('config');
  setCookie(c, preAuthCookieName(c), cookieValue, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Strict',
    path: '/',
  });
  return csrfToken;
}

/** @param {import('hono').Context} c */
export function clearPreAuthCookie(c) {
  const config = c.get('config');
  deleteCookie(c, preAuthCookieName(c), {
    path: '/',
    secure: config.cookieSecure,
    sameSite: 'Strict',
  });
}

/**
 * Set the session cookie.
 *
 * `SameSite=Strict` is right for this app: it has no cross-site entry point and
 * no redirect-back flow to receive, so there is no reason to accept the cookie
 * on a cross-site navigation.
 *
 * `Domain` is deliberately never set, which scopes the cookie to this exact host
 * rather than sharing it with every sibling subdomain.
 *
 * @param {import('hono').Context} c
 * @param {string} token
 */
export function setSessionCookie(c, token) {
  const config = c.get('config');
  setCookie(c, config.cookieName, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Strict',
    path: '/',
    // No Max-Age or Expires: a session cookie, with the real lifetime enforced
    // server side where the client cannot extend it.
  });
}

/**
 * @param {import('hono').Context} c
 */
export function clearSessionCookie(c) {
  const config = c.get('config');
  deleteCookie(c, config.cookieName, {
    path: '/',
    secure: config.cookieSecure,
    sameSite: 'Strict',
  });
}

/**
 * Read the session token.
 *
 * Both cookie names are tried because the name changes with the transport
 * (`__Host-id` over HTTPS, `id` over plain HTTP). Reading both means a config
 * flip does not strand a user with an unreadable cookie, while the *write* side
 * only ever issues the correct name for the current transport.
 *
 * @param {import('hono').Context} c
 */
function readSessionToken(c) {
  const config = c.get('config');
  return getCookie(c, config.cookieName) ?? getCookie(c, 'id') ?? null;
}

/**
 * The client's address, for per-IP login throttling.
 *
 * X-Forwarded-For is only consulted when TRUST_PROXY is on, and then only the
 * LAST entry, which is the one the nearest trusted proxy appended. Believing the
 * first entry would let a client forge its own address by sending the header
 * itself and evade throttling entirely.
 *
 * @param {import('hono').Context} c
 * @returns {?string}
 */
export function clientIp(c) {
  const config = c.get('config');

  if (config.trustProxy) {
    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded) {
      const parts = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
      const nearest = parts[parts.length - 1];
      if (nearest) return nearest.slice(0, 100);
    }
    const real = c.req.header('x-real-ip');
    if (real) return real.trim().slice(0, 100);
  }

  // @hono/node-server exposes the raw socket here.
  const remote = c.env?.incoming?.socket?.remoteAddress;
  return remote ? String(remote).slice(0, 100) : null;
}

/**
 * Attach the session and user to the context, if there is one.
 * Always runs; never rejects. Guards below decide what to do about it.
 * @returns {import('hono').MiddlewareHandler}
 */
export function attachSession() {
  return async (c, next) => {
    const token = readSessionToken(c);
    const loaded = token ? loadSession(token) : null;

    if (loaded) {
      c.set('sessionToken', token);
      c.set('session', loaded.session);
      c.set('user', loaded.user);
      c.set('csrfToken', loaded.session.csrfToken);
    } else {
      if (token) {
        // The cookie referenced a session that is gone or expired. Clear it so
        // the browser stops sending it.
        clearSessionCookie(c);
      }
      c.set('sessionToken', null);
      c.set('session', null);
      c.set('user', null);
      c.set('csrfToken', null);
    }

    await next();
  };
}

/**
 * Require a signed-in user.
 *
 * On an HTML GET the user is sent to the login page with a `next` parameter so
 * they land back where they were aiming. That parameter is validated as a
 * same-site path on the way back out, so it cannot become an open redirect.
 *
 * @returns {import('hono').MiddlewareHandler}
 */
export function requireAuth() {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) {
      if (c.req.method === 'GET') {
        const target = c.req.path + (new URL(c.req.url).search || '');
        const next_ = encodeURIComponent(target);
        return c.redirect(`/login?next=${next_}`, 303);
      }
      return c.text('Sign in required.', 401);
    }
    await next();
  };
}

/**
 * Require an administrator.
 *
 * Returns 404 rather than 403 for a signed-in non-admin, so the admin area's
 * existence is not confirmed to accounts that cannot use it.
 *
 * @returns {import('hono').MiddlewareHandler}
 */
export function requireAdmin() {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) return c.redirect('/login', 303);
    if (user.role !== 'admin') {
      return c.notFound();
    }
    await next();
  };
}

/**
 * Funnel a user with a pending forced password change to the change form.
 *
 * Mounted app-wide so a new account cannot reach any other route while still
 * holding an admin-issued credential. Logout and the change form itself are
 * exempt, or the user would be trapped.
 *
 * @param {string[]} exemptPaths
 * @returns {import('hono').MiddlewareHandler}
 */
export function requirePasswordChanged(exemptPaths = []) {
  const exempt = new Set([
    '/logout',
    '/account/password',
    '/healthz',
    ...exemptPaths,
  ]);
  return async (c, next) => {
    const user = c.get('user');
    if (user?.mustChangePassword && !exempt.has(c.req.path)) {
      if (c.req.method === 'GET') {
        return c.redirect('/account/password', 303);
      }
      return c.text('You must choose a new password before continuing.', 403);
    }
    await next();
  };
}

/**
 * Verify CSRF on every state-changing request.
 *
 * Reads the token from an already-parsed body when a route parsed one, so a
 * multipart upload is not read twice. Routes that handle their own multipart
 * stream verify the token themselves as soon as that field is parsed and set
 * `csrfVerified`.
 *
 * @returns {import('hono').MiddlewareHandler}
 */
export function csrfGuard() {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return next();
    }

    const config = c.get('config');
    const session = c.get('session');

    const contentType = c.req.header('content-type') ?? '';

    // A multipart route verifies the token itself while streaming, because
    // buffering the whole upload before authorizing it is exactly what we are
    // trying to avoid. Such routes must set csrfVerified.
    if (contentType.includes('multipart/form-data')) {
      c.set('csrfDeferred', true);
      await next();
      if (!c.get('csrfVerified')) {
        // A multipart route that forgot to verify is a programming error, and
        // failing closed is the only safe response.
        throw new Error(
          `Route ${method} ${c.req.path} accepted multipart input without ` +
            'verifying the CSRF token.',
        );
      }
      return undefined;
    }

    let submitted = null;
    try {
      const body = await c.req.parseBody();
      submitted = body?.[CSRF_FIELD_NAME] ?? null;
      // Cache it so the route does not have to parse the body a second time.
      c.set('parsedBody', body);
    } catch {
      submitted = null;
    }

    // The expected token normally lives on the session row. For a form shown
    // before sign-in (the login form) it lives in the pre-auth store instead.
    // Falling back here rather than exempting those routes keeps every
    // state-changing request on one code path that fails closed.
    const expectedToken =
      session?.csrfToken ?? preAuthCsrfToken(readPreAuthCookie(c));

    const verdict = verifyCsrf({
      request: c.req.raw,
      method,
      submittedToken: submitted,
      sessionToken: expectedToken,
      allowedOrigins: config.allowedOrigins,
    });

    if (!verdict.ok) {
      // A stale form on a session that has since expired is the common cause, so
      // the message points at the likely fix rather than accusing the user.
      const status = verdict.reason === 'no_session' ? 401 : 403;
      return c.text(
        'This form could not be submitted because its security token was ' +
          'missing or out of date. Reload the page and try again.',
        status,
      );
    }

    return next();
  };
}

/**
 * Sign a user out: drop the server-side session, clear the cookie, and ask the
 * browser to discard its own cached copies of the session's data.
 * @param {import('hono').Context} c
 */
export function signOut(c) {
  const token = c.get('sessionToken');
  if (token) destroySession(token);
  clearSessionCookie(c);
  for (const [name, value] of Object.entries(clearSiteDataHeader())) {
    c.header(name, value);
  }
}

/**
 * Validate a `next` redirect target.
 *
 * Only a same-site absolute path is allowed. Anything scheme-relative
 * (`//evil.test`), absolute (`https://evil.test`), or backslash-obfuscated is
 * rejected, which is what keeps the login flow from becoming an open redirect.
 *
 * @param {unknown} candidate
 * @param {string} fallback
 * @returns {string}
 */
export function safeRedirectPath(candidate, fallback = '/') {
  if (typeof candidate !== 'string' || candidate.length === 0) return fallback;
  if (candidate.length > 512) return fallback;
  // Must begin with a single slash, and must not begin with two (which a browser
  // reads as scheme-relative and therefore off-site).
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return fallback;
  // Backslashes are normalized to forward slashes by some browsers, so `/\evil`
  // can escape the origin.
  if (candidate.includes('\\')) return fallback;
  if (/[--]/.test(candidate)) return fallback;
  return candidate;
}
