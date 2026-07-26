/**
 * The administrative area: provisioning accounts and managing them.
 *
 * Every route here is behind requireAdmin(), which returns 404 rather than 403 to
 * a signed-in non-admin so the area's existence is not confirmed to accounts that
 * cannot use it.
 */

import { requireAdmin } from '../auth/middleware.js';
import {
  countAdmins,
  createUser,
  findUserById,
  listUsers,
  resetPassword,
  setUserActive,
  setUserRole,
} from '../auth/users.js';
import { ValidationErrors, validateEmail, validateRole, validateText } from '../lib/validate.js';
import { adminUsersPage } from '../views/admin.js';
import { flashMessage } from '../views/layout.js';

/**
 * @param {import('hono').Hono} app
 */
export function registerAdminRoutes(app) {
  /**
   * @param {import('hono').Context} c
   * @param {{newCredential?: object|null, flash?: object|null, status?: number,
   *          errors?: ValidationErrors}} [options]
   */
  const renderUsers = (c, options = {}) =>
    c.html(
      String(
        adminUsersPage({
          user: c.get('user'),
          csrfToken: c.get('csrfToken'),
          users: listUsers(),
          newCredential: options.newCredential ?? null,
          flash: options.flash ?? null,
          errors: options.errors ?? new ValidationErrors(),
        }),
      ),
      options.status ?? 200,
    );

  app.get('/admin/users', requireAdmin(), (c) => renderUsers(c));

  app.post('/admin/users', requireAdmin(), async (c) => {
    const body = c.get('parsedBody') ?? (await c.req.parseBody());
    const errors = new ValidationErrors();

    const email = validateEmail(errors, 'email', body.email);
    const displayName = validateText(errors, 'display_name', body.display_name, {
      label: 'Name',
      required: true,
      maxLength: 120,
    });
    const role = validateRole(errors, 'role', body.role);

    if (!errors.ok) {
      return renderUsers(c, { errors, status: 422 });
    }

    try {
      const { user: created, initialPassword, expiresAt } = await createUser({
        email,
        displayName,
        role,
        createdBy: c.get('user').id,
      });

      // Shown exactly once. Never stored in recoverable form, never re-displayed.
      return renderUsers(c, {
        newCredential: {
          email: created.email,
          displayName: created.displayName,
          initialPassword,
          expiresAt,
        },
      });
    } catch (error) {
      if (error.code === 'EMAIL_TAKEN') {
        errors.add('email', error.message);
        return renderUsers(c, { errors, status: 409 });
      }
      throw error;
    }
  });

  app.post('/admin/users/:id/reset-password', requireAdmin(), async (c) => {
    const target = findUserById(Number(c.req.param('id')));
    if (!target) return c.notFound();

    const { initialPassword, expiresAt } = await resetPassword(target.id);

    return renderUsers(c, {
      newCredential: {
        email: target.email,
        displayName: target.displayName,
        initialPassword,
        expiresAt,
        isReset: true,
      },
    });
  });

  /**
   * Activate or deactivate an account.
   *
   * Two distinct paths rather than one path with a body flag, so the intent is
   * visible in the request line and a truncated or malformed body cannot turn a
   * deactivation into a no-op reactivation.
   *
   * @param {import('hono').Context} c
   * @param {boolean} makeActive
   */
  const setActive = (c, makeActive) => {
    const target = findUserById(Number(c.req.param('id')));
    if (!target) return c.notFound();

    // Guard against an admin locking everyone out of the admin area, including
    // themselves. Recovering from that needs shell access to the container.
    if (!makeActive && target.role === 'admin' && countAdmins() <= 1) {
      return renderUsers(c, {
        status: 409,
        flash: flashMessage({
          kind: 'error',
          title: 'Cannot deactivate the last administrator',
          body:
            'Promote another account to administrator first, or nobody will be ' +
            'able to manage users.',
        }),
      });
    }

    setUserActive(target.id, makeActive);

    return renderUsers(c, {
      flash: flashMessage({
        kind: 'success',
        title: makeActive ? 'Account reactivated' : 'Account deactivated',
        body: makeActive
          ? `${target.displayName} can sign in again.`
          : `${target.displayName} has been signed out and cannot sign in.`,
      }),
    });
  };

  app.post('/admin/users/:id/deactivate', requireAdmin(), (c) => setActive(c, false));
  app.post('/admin/users/:id/activate', requireAdmin(), (c) => setActive(c, true));

  app.post('/admin/users/:id/role', requireAdmin(), async (c) => {
    const body = c.get('parsedBody') ?? (await c.req.parseBody());
    const target = findUserById(Number(c.req.param('id')));
    if (!target) return c.notFound();

    const errors = new ValidationErrors();
    const role = validateRole(errors, 'role', body.role);
    if (!errors.ok) return renderUsers(c, { errors, status: 422 });

    if (role !== 'admin' && target.role === 'admin' && countAdmins() <= 1) {
      return renderUsers(c, {
        status: 409,
        flash: flashMessage({
          kind: 'error',
          title: 'Cannot demote the last administrator',
          body: 'Promote another account first.',
        }),
      });
    }

    // setUserRole ends the target's sessions, so a new privilege level is never
    // exercised on a session established under the old one.
    setUserRole(target.id, role);

    return renderUsers(c, {
      flash: flashMessage({
        kind: 'success',
        title: 'Role updated',
        body:
          `${target.displayName} is now ${role === 'admin' ? 'an administrator' : 'a collector'}. ` +
          'They have been signed out and will need to sign in again.',
      }),
    });
  });
}
