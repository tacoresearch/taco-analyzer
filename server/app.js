/**
 * Application wiring.
 *
 * Middleware order is load-bearing and is documented inline below. The short
 * version: config, then security headers, then session, then CSRF, then the
 * forced-password-change gate, then routes. Getting this order wrong is how an
 * app ends up checking CSRF against a session it has not loaded yet, or
 * serving a page to a user who is supposed to be gated.
 */

import { Hono } from 'hono';
import { attachSession, csrfGuard, requirePasswordChanged } from './auth/middleware.js';
import { noStoreHeaders, securityHeaders } from './security/headers.js';
import { errorPage } from './views/error.js';
import { registerAssetRoutes } from './routes/assets.routes.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerDashboardRoutes } from './routes/dashboard.routes.js';
import { registerSurveyRoutes } from './routes/survey.routes.js';
import { registerPhotoRoutes } from './routes/photo.routes.js';
import { registerAdminRoutes } from './routes/admin.routes.js';

/**
 * @param {{config: ReturnType<import('./config.js').loadConfig>}} deps
 * @returns {Hono}
 */
export function createApp({ config }) {
  const app = new Hono();

  // 1. Config on every context, before anything reads it.
  app.use('*', async (c, next) => {
    c.set('config', config);
    await next();
  });

  // 2. Security headers on every response, including errors and 404s. Set here
  //    rather than per-route so a new route cannot accidentally ship without
  //    them. HSTS is included only when TLS is actually in front of the app.
  const headers = securityHeaders({ https: config.cookieSecure });
  app.use('*', async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(headers)) {
      c.header(name, value, { append: false });
    }
    // Never advertise the stack.
    c.res.headers.delete('X-Powered-By');
  });

  // 3. Static assets, before session handling: they need neither a session nor a
  //    CSRF check, and they should not extend anyone's session idle timer.
  registerAssetRoutes(app);

  // Liveness probe. Deliberately above auth so a monitor does not need
  // credentials, and deliberately says nothing about internal state.
  app.get('/healthz', (c) => c.text('ok\n', 200, { 'Cache-Control': 'no-store' }));

  // 4. Attach the session. Never rejects; the guards decide what to do.
  app.use('*', attachSession());

  // 5. CSRF on every state-changing request, after the session exists (the
  //    expected token lives on the session row).
  app.use('*', csrfGuard());

  // 6. The forced-password-change gate. After the session so it knows who the
  //    user is, before the routes so no route can be reached while a user still
  //    holds an admin-issued one-time credential.
  app.use('*', requirePasswordChanged());

  // 7. Authenticated HTML must not be cached. Applied to everything except the
  //    assets already handled above.
  app.use('*', async (c, next) => {
    await next();
    const contentType = c.res.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) {
      for (const [name, value] of Object.entries(noStoreHeaders())) {
        c.header(name, value, { append: false });
      }
    }
  });

  registerAuthRoutes(app);
  registerDashboardRoutes(app);
  registerSurveyRoutes(app);
  registerPhotoRoutes(app);
  registerAdminRoutes(app);

  app.notFound((c) =>
    c.html(
      String(
        errorPage({
          status: 404,
          title: 'Not found',
          message: 'That page does not exist, or you do not have access to it.',
          user: c.get('user'),
        }),
      ),
      404,
    ),
  );

  app.onError((error, c) => {
    // Log the real error server side; show the user nothing about internals.
    // Stack traces and messages routinely contain paths, SQL, and parameter
    // values, none of which belong in a browser.
    process.stderr.write(
      `[error] ${c.req.method} ${c.req.path}: ${error?.stack ?? error}\n`,
    );
    return c.html(
      String(
        errorPage({
          status: 500,
          title: 'Something went wrong',
          message:
            'The server hit an unexpected problem. Nothing you did caused it. ' +
            'Try again, and if it keeps happening the details are in the server log.',
          user: c.get('user'),
        }),
      ),
      500,
    );
  });

  return app;
}
