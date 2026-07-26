/**
 * Sign in, sign out, and password change.
 */

import {
  clearPreAuthCookie,
  clientIp,
  ensurePreAuthCsrfToken,
  readPreAuthCookie,
  safeRedirectPath,
  setSessionCookie,
  signOut,
} from '../auth/middleware.js';
import { discardPreAuthToken } from '../auth/preauth.js';
import { createSession, destroyUserSessions, rotateSession } from '../auth/sessions.js';
import { authenticate, findUserByEmail, setChosenPassword } from '../auth/users.js';
import { MIN_PASSWORD_LENGTH, verifyPassword } from '../auth/passwords.js';
import { delay } from '../security/ratelimit.js';
import { loginPage } from '../views/login.js';
import { changePasswordPage } from '../views/password.js';
import { formatDateTime } from '../lib/format.js';

/**
 * The single message shown for every credential failure.
 *
 * It must not vary by cause. Saying "no account with that email" hands an
 * attacker a free account-enumeration oracle, which is also why
 * `authenticate()` spends the same KDF time whether or not the account exists.
 */
const GENERIC_LOGIN_ERROR = 'Login failed. Check your email address and password.';

/**
 * @param {import('hono').Hono} app
 */
export function registerAuthRoutes(app) {
  app.get('/login', (c) => {
    const user = c.get('user');
    if (user) {
      return c.redirect(user.mustChangePassword ? '/account/password' : '/', 303);
    }

    const next = safeRedirectPath(c.req.query('next'), '');
    const notice =
      c.req.query('signedout') === '1'
        ? 'You have been signed out.'
        : c.req.query('expired') === '1'
          ? 'Your session ended because it was idle. Please sign in again.'
          : null;

    return c.html(
      String(
        loginPage({
          csrfToken: ensurePreAuthCsrfToken(c),
          email: '',
          error: null,
          notice,
          next,
        }),
      ),
    );
  });

  app.post('/login', async (c) => {
    // csrfGuard already parsed and cached the body, so it is not read twice.
    const body = c.get('parsedBody') ?? (await c.req.parseBody());
    const email = typeof body.email === 'string' ? body.email : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const next = safeRedirectPath(body.next, '');

    const result = await authenticate({
      email,
      password,
      ip: clientIp(c),
      userAgent: c.req.header('user-agent') ?? null,
    });

    if (!result.ok) {
      // Only the states a user genuinely cannot resolve by retrying get their own
      // message, and those are only reachable once the password was already
      // verified correct, so they reveal nothing to someone guessing.
      let error = GENERIC_LOGIN_ERROR;
      let status = 401;
      if (result.reason === 'ip_throttled') {
        error =
          'Too many failed sign-in attempts from this network. ' +
          'Wait a few minutes and try again.';
        status = 429;
        c.header('Retry-After', String(result.retryAfterSeconds ?? 900));
      } else if (result.reason === 'locked') {
        error =
          'This account is temporarily locked after too many failed attempts. ' +
          `Try again after ${formatDateTime(result.lockedUntil)}, or ask an ` +
          'administrator to unlock it.';
        status = 429;
      } else if (result.reason === 'expired') {
        error =
          'That one-time password has expired. Ask an administrator to issue a new one.';
        status = 403;
      } else if (result.reason === 'disabled') {
        error = 'This account has been deactivated. Ask an administrator about it.';
        status = 403;
      }

      return c.html(
        String(
          loginPage({
            csrfToken: ensurePreAuthCsrfToken(c),
            // Keep the email so a genuine user does not retype it, but never
            // keep the password.
            email: typeof email === 'string' ? email.slice(0, 254) : '',
            error,
            notice: null,
            next,
          }),
        ),
        status,
      );
    }

    // Session fixation prevention: a brand new identifier on every
    // authentication, with any previous session for this browser destroyed in
    // the same transaction.
    const previousToken = c.get('sessionToken');
    const session = rotateSession(previousToken, result.user.id, {
      ip: clientIp(c),
      userAgent: c.req.header('user-agent') ?? null,
    });
    setSessionCookie(c, session.token);

    // The pre-auth token has done its job.
    discardPreAuthToken(readPreAuthCookie(c));
    clearPreAuthCookie(c);

    if (result.mustChangePassword) {
      return c.redirect('/account/password', 303);
    }
    return c.redirect(next || '/', 303);
  });

  app.post('/logout', (c) => {
    signOut(c);
    return c.redirect('/login?signedout=1', 303);
  });

  app.get('/account/password', (c) => {
    const user = c.get('user');
    if (!user) return c.redirect('/login', 303);

    return c.html(
      String(
        changePasswordPage({
          csrfToken: c.get('csrfToken'),
          user,
          problems: [],
          mustChange: user.mustChangePassword,
          minLength: MIN_PASSWORD_LENGTH,
        }),
      ),
    );
  });

  app.post('/account/password', async (c) => {
    const user = c.get('user');
    if (!user) return c.redirect('/login', 303);

    const body = c.get('parsedBody') ?? (await c.req.parseBody());
    const currentPassword =
      typeof body.current_password === 'string' ? body.current_password : '';
    const newPassword = typeof body.new_password === 'string' ? body.new_password : '';
    const confirmPassword =
      typeof body.confirm_password === 'string' ? body.confirm_password : '';

    /** @param {string[]} problems */
    const rerender = (problems, status = 400) =>
      c.html(
        String(
          changePasswordPage({
            csrfToken: c.get('csrfToken'),
            user,
            problems,
            mustChange: user.mustChangePassword,
            minLength: MIN_PASSWORD_LENGTH,
          }),
        ),
        status,
      );

    // Re-authenticate before changing the credential, so a borrowed unlocked
    // browser cannot be used to take the account over.
    const row = findUserByEmail(user.email);
    if (!row) return c.redirect('/login', 303);

    const check = await verifyPassword(currentPassword, row.password_hash);
    if (!check.ok) {
      // A small delay so this form cannot be used as a fast password oracle
      // against an already-signed-in session.
      await delay(500);
      return rerender(['Your current password is not correct.'], 401);
    }

    if (newPassword !== confirmPassword) {
      return rerender(['The two new passwords do not match.']);
    }
    if (newPassword === currentPassword) {
      return rerender(['Your new password must be different from the current one.']);
    }

    const result = await setChosenPassword(row.id, newPassword, {
      email: row.email,
      displayName: row.display_name,
    });
    if (!result.ok) {
      return rerender(result.problems);
    }

    // A password change ends every session on the account, not just this one.
    // If the old password was compromised, some other browser may be holding a
    // live session, and rotating only the current token would leave it working.
    destroyUserSessions(row.id);
    const session = createSession(row.id, {
      ip: clientIp(c),
      userAgent: c.req.header('user-agent') ?? null,
    });
    setSessionCookie(c, session.token);

    return c.redirect('/?password_changed=1', 303);
  });
}
