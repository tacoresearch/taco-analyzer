/**
 * User administration.
 *
 * Every action here is a POST form carrying a CSRF token. None of them is a link,
 * because a link that changes state can be fired by a prefetch, a crawler, or an
 * `<img src>` on some unrelated page, and "deactivate a colleague" is not
 * something that should be one accidental GET away.
 *
 * The one-time password is shown exactly once, in a mono face, because it is
 * handed over verbally or on paper. It is never recoverable afterwards: the
 * server keeps only a hash, so a lost password means issuing a new one.
 *
 * Route paths used by the forms below (POST in every case):
 *   /admin/users                      create an account
 *   /admin/users/:id/reset-password   issue a fresh one-time password
 *   /admin/users/:id/deactivate       end sessions and disable
 *   /admin/users/:id/activate         re-enable
 *   /admin/users/:id/role             change role
 */

import { attrs, html } from '../lib/html.js';
import { formatDateTime } from '../lib/format.js';
import { csrfField } from '../security/csrf.js';
import { flashMessage, metaList, pageHeader, renderPage } from './layout.js';

/** The roles an admin can assign. Mirrors validateRole() in lib/validate.js. */
const ROLES = Object.freeze([
  { value: 'collector', label: 'Collector' },
  { value: 'admin', label: 'Administrator' },
]);

/** @param {string} role */
function roleLabel(role) {
  return ROLES.find((option) => option.value === role)?.label ?? role;
}

/**
 * The status badges for one account. Text in every case, so nothing depends on
 * colour or on a glyph the system font might not have.
 *
 * @param {any} row
 */
function statusBadges(row) {
  const locked = Boolean(row.lockedUntil) && Date.parse(row.lockedUntil) > Date.now();
  return html`<span class="cluster">
              <span class="${row.isActive ? 'badge badge--accent' : 'badge'}">${
                row.isActive ? 'Active' : 'Deactivated'
              }</span>
              ${locked ? html`<span class="badge">Locked until ${formatDateTime(row.lockedUntil)}</span>` : ''}
              ${row.mustChangePassword ? html`<span class="badge">One-time password pending</span>` : ''}
            </span>`;
}

/**
 * The actions cell for one account.
 *
 * An admin cannot deactivate themselves or change their own role from here. The
 * server has to enforce that too (this is a view, not a guard), but offering a
 * button that locks you out of your own instance is a trap worth not setting.
 *
 * @param {{row: any, csrfToken: string, isSelf: boolean}} input
 */
function rowActions({ row, csrfToken, isSelf }) {
  if (isSelf) {
    return html`
            <div class="data-table__actions">
              <span class="text-small text-muted">This is you.</span>
              <a class="btn btn--secondary btn--small" href="/account/password">Change your password</a>
            </div>`;
  }

  const roleSelectId = `role-${row.id}`;

  return html`
            <div class="data-table__actions">
              <form method="post" action="/admin/users/${row.id}/reset-password">
                ${csrfField(csrfToken)}
                <button
                  type="submit"
                  class="btn btn--secondary btn--small"
                  data-confirm="Issue a new one-time password for ${row.displayName}? Their current password stops working and every session ends.">Reset password</button>
              </form>

              ${
                row.isActive
                  ? html`<form method="post" action="/admin/users/${row.id}/deactivate">
                ${csrfField(csrfToken)}
                <button
                  type="submit"
                  class="btn btn--danger btn--small"
                  data-confirm="Deactivate ${row.displayName}? They are signed out immediately and cannot sign back in.">Deactivate</button>
              </form>`
                  : html`<form method="post" action="/admin/users/${row.id}/activate">
                ${csrfField(csrfToken)}
                <button type="submit" class="btn btn--secondary btn--small">Reactivate</button>
              </form>`
              }

              <form class="cluster" method="post" action="/admin/users/${row.id}/role">
                ${csrfField(csrfToken)}
                <label class="visually-hidden" for="${roleSelectId}">Role for ${row.displayName}</label>
                <select id="${roleSelectId}" name="role">
                  ${ROLES.map(
                    (option) => html`<option value="${option.value}"${attrs({
                      selected: option.value === row.role,
                    })}>${option.label}</option>`,
                  )}
                </select>
                <button
                  type="submit"
                  class="btn btn--secondary btn--small"
                  data-confirm="Change the role for ${row.displayName}? Their current sessions end.">Change role</button>
              </form>
            </div>`;
}

/**
 * The one-time credential panel, shown once, immediately after an account is
 * created or reset.
 *
 * @param {{email: string, initialPassword: string, expiresAt: string}} credential
 */
function credentialPanel(credential) {
  return html`
      <article class="card">
        <header class="card__header">
          <h2 class="card__title">Hand this over now</h2>
          <span class="badge badge--accent">Shown once</span>
        </header>
        <div class="card__body">
          ${flashMessage({
            kind: 'warn',
            title: 'Not shown again',
            body:
              'The server keeps only a hash of this password, so it cannot be looked ' +
              'up later. If it is lost before it is used, issue a new one.',
          })}
          ${metaList([
            { label: 'Account', value: credential.email, mono: true },
            { label: 'One-time password', value: credential.initialPassword, mono: true },
            { label: 'Expires', value: formatDateTime(credential.expiresAt) },
          ])}
          <p class="text-small text-muted">
            Read it out in groups of five. It contains no digit zero, no digit one, no
            letter I and no letter O, so there is nothing in it that can be misheard for
            one of those. It works for 24 hours, and the user has to replace it with a
            password of their own the first time they sign in.
          </p>
        </div>
      </article>`;
}

/**
 * @param {{
 *   user: {id?: number, displayName?: string, role?: string},
 *   csrfToken: string,
 *   users?: Array<any>,
 *   newCredential?: ?{email: string, initialPassword: string, expiresAt: string},
 *   flash?: unknown,
 * }} input
 */
export function adminUsersPage({ user, csrfToken, users = [], newCredential = null, flash = null }) {
  const main = html`
      ${pageHeader({
        title: 'Users',
        subtitle:
          'Accounts are created here, with a server-generated one-time password. ' +
          'There is no self-signup and no password reset by email.',
      })}

      ${newCredential ? credentialPanel(newCredential) : ''}

      <table class="data-table" role="table">
        <caption class="data-table__caption">Everyone with an account on this instance.</caption>
        <thead role="rowgroup">
          <tr role="row">
            <th role="columnheader" scope="col">Name</th>
            <th role="columnheader" scope="col">Email</th>
            <th role="columnheader" scope="col">Role</th>
            <th role="columnheader" scope="col">Status</th>
            <th role="columnheader" scope="col" class="data-table__num">Surveys</th>
            <th role="columnheader" scope="col">Last sign-in</th>
            <th role="columnheader" scope="col"><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          ${users.map(
            (row) => html`
          <tr role="row">
            <td role="cell" data-label="Name">${row.displayName}</td>
            <td role="cell" data-label="Email">${row.email}</td>
            <td role="cell" data-label="Role">${roleLabel(row.role)}</td>
            <td role="cell" data-label="Status">${statusBadges(row)}</td>
            <td role="cell" data-label="Surveys" class="data-table__num text-nums">${row.surveyCount ?? 0}</td>
            <td role="cell" data-label="Last sign-in">${
              row.lastLoginAt ? formatDateTime(row.lastLoginAt) : 'Never'
            }</td>
            <td role="cell" data-label="">${rowActions({
              row,
              csrfToken,
              isSelf: row.id === user?.id,
            })}</td>
          </tr>`,
          )}
        </tbody>
      </table>

      <h2>Create an account</h2>
      <form class="form" method="post" action="/admin/users" novalidate>
        ${csrfField(csrfToken)}

        <fieldset class="form-section">
          <legend class="form-section__legend">New collector or administrator</legend>
          <p class="form-section__blurb">
            The password is generated by the server, not chosen by you, so no house
            pattern can build up across accounts. It appears on this page once, right
            after you submit.
          </p>

          <div class="field">
            <label class="field__label" for="new-email">Email address</label>
            <p class="field__hint" id="new-email-hint">Used as the sign-in name. It is not emailed anywhere.</p>
            <input
              type="email"
              id="new-email"
              name="email"
              inputmode="email"
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
              maxlength="254"
              required
              aria-describedby="new-email-hint">
          </div>

          <div class="field">
            <label class="field__label" for="new-display-name">Display name</label>
            <p class="field__hint" id="new-display-name-hint">Shown as the author on every survey they record.</p>
            <input
              type="text"
              id="new-display-name"
              name="display_name"
              maxlength="120"
              autocomplete="off"
              required
              aria-describedby="new-display-name-hint">
          </div>

          <div class="field">
            <label class="field__label" for="new-role">Role</label>
            <p class="field__hint" id="new-role-hint">
              A collector sees only their own surveys. An administrator sees everything
              and can manage accounts.
            </p>
            <select id="new-role" name="role" required aria-describedby="new-role-hint">
              ${ROLES.map(
                (option) => html`<option value="${option.value}"${attrs({
                  selected: option.value === 'collector',
                })}>${option.label}</option>`,
              )}
            </select>
          </div>
        </fieldset>

        <div class="form-actions">
          <button type="submit" class="btn btn--primary">Create account</button>
          <p class="form-actions__note">
            You will see the one-time password on the next screen, once.
          </p>
        </div>
      </form>`;

  return renderPage({
    title: 'Users',
    user,
    csrfToken,
    activeNav: 'users',
    wide: true,
    flash,
    main,
  });
}
