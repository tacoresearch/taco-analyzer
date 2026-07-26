/**
 * The dashboard: survey counts plus the details that will feed later analysis.
 */

import { requireAuth } from '../auth/middleware.js';
import { dashboardStats, recentSurveys } from '../db/surveys.js';
import { dashboardPage } from '../views/dashboard.js';
import { flashMessage } from '../views/layout.js';

/**
 * @param {import('hono').Hono} app
 */
export function registerDashboardRoutes(app) {
  app.get('/', requireAuth(), (c) => {
    const user = c.get('user');

    // Collectors see their own numbers; admins see everything. Scoping here
    // rather than in the view means a template change cannot leak other
    // people's data.
    const scope = user.role === 'admin' ? { userId: null } : { userId: user.id };

    const stats = dashboardStats(scope);
    const recent = recentSurveys({ ...scope, limit: 8 });

    // Flash messages come from explicit query flags rather than from any
    // user-supplied text, so there is nothing here that could carry markup.
    let flash = null;
    if (c.req.query('password_changed') === '1') {
      flash = flashMessage({
        kind: 'success',
        title: 'Password changed',
        body: 'Your new password is saved. Any other sessions were signed out.',
      });
    } else if (c.req.query('submitted') === '1') {
      flash = flashMessage({
        kind: 'success',
        title: 'Survey saved',
        body: 'Thanks. That taco is now on the record.',
      });
    }

    return c.html(
      String(
        dashboardPage({
          user,
          csrfToken: c.get('csrfToken'),
          stats,
          recent,
          flash,
        }),
      ),
    );
  });
}
