/**
 * Password change, in both of its shapes.
 *
 * `mustChange` is the forced interstitial a user lands on straight after signing
 * in with an administrator-issued one-time password. The same form serves the
 * voluntary change, because the fields and the policy are identical and two
 * near-copies would drift apart.
 *
 * The policy is stated in full BEFORE the fields. Telling someone their password
 * is too short only after they have composed one, twice, is a small cruelty that
 * also teaches them to pick something weaker next time.
 */

import { attrs, html } from '../lib/html.js';
import { MIN_PASSWORD_LENGTH } from '../auth/passwords.js';
import { csrfField } from '../security/csrf.js';
import { describedBy, flashMessage, pageHeader, renderPage } from './layout.js';

/**
 * Which field a policy problem belongs to.
 *
 * Everything `checkPasswordPolicy` returns is about the new password; the one
 * exception the route adds is a wrong current password. Routing that item to the
 * right control matters, because an `.error-summary` link that lands on the wrong
 * field is worse than no link.
 *
 * @param {string} problem
 * @returns {'current_password'|'new_password'}
 */
function targetForProblem(problem) {
  return /current password/i.test(problem) ? 'current_password' : 'new_password';
}

/**
 * A show-password button for one field. app.js reads `[data-password-toggle]`;
 * with the script blocked the button simply does nothing and the field still
 * works, so nothing here is load-bearing.
 *
 * @param {string} inputId
 */
function passwordToggle(inputId) {
  return html`
              <div class="cluster">
                <button
                  type="button"
                  class="btn btn--secondary btn--small"
                  data-password-toggle="${inputId}"
                  aria-controls="${inputId}"
                  aria-pressed="false">Show password</button>
              </div>`;
}

/**
 * One password field.
 *
 * @param {{
 *   id: string,
 *   label: string,
 *   autocomplete: string,
 *   hint?: ?string,
 *   error?: ?string,
 *   minLength?: ?number,
 *   toggle?: boolean,
 * }} input
 */
function passwordField({ id, label, autocomplete, hint = null, error = null, minLength = null, toggle = false }) {
  const hintId = hint ? `${id}-hint` : null;
  const errorId = error ? `${id}-error` : null;

  return html`
            <div class="field">
              <label class="field__label" for="${id}">${label}</label>
              ${hint ? html`<p class="field__hint" id="${hintId}">${hint}</p>` : ''}
              <input
                type="password"
                id="${id}"
                name="${id}"
                autocomplete="${autocomplete}"
                autocapitalize="none"
                spellcheck="false"
                required${attrs({
                  class: error ? 'is-invalid' : false,
                  minlength: minLength ?? false,
                  'aria-invalid': error ? 'true' : false,
                  'aria-describedby': describedBy(hintId, errorId),
                })}>
              ${toggle ? passwordToggle(id) : ''}
              ${error ? html`<p class="field-error" id="${errorId}">${error}</p>` : ''}
            </div>`;
}

/**
 * @param {{
 *   csrfToken: string,
 *   user: {displayName?: string, email?: string, role?: string},
 *   problems?: string[],
 *   mustChange?: boolean,
 *   minLength?: number,
 * }} input
 */
export function changePasswordPage({
  csrfToken,
  user,
  problems = [],
  mustChange = false,
  minLength = MIN_PASSWORD_LENGTH,
}) {
  const list = Array.isArray(problems) ? problems.filter((p) => typeof p === 'string' && p) : [];

  // Group by control so the summary links land correctly and the inline message
  // under each field says the same thing the summary said.
  /** @type {Record<string, string[]>} */
  const byField = { current_password: [], new_password: [] };
  for (const problem of list) byField[targetForProblem(problem)].push(problem);

  const summary =
    list.length === 0
      ? html``
      : html`
      <div class="error-summary" role="alert" tabindex="-1" data-error-summary>
        <h2 class="error-summary__title">${
          list.length === 1 ? '1 problem needs fixing' : `${list.length} problems need fixing`
        }</h2>
        <ul class="error-summary__list">
          ${list.map(
            (problem) => html`
          <li class="error-summary__item">
            <a class="error-summary__link" href="#${targetForProblem(problem)}">${problem}</a>
          </li>`,
          )}
        </ul>
      </div>`;

  const policy = html`
      <article class="card">
        <header class="card__header">
          <h2 class="card__title">What counts as a good password here</h2>
        </header>
        <div class="card__body">
          <ul class="stack stack--tight">
            <li>At least ${minLength} characters. Length is what actually matters.</li>
            <li>A short phrase of a few words works well, and is easier to remember than a jumble.</li>
            <li>No required capitals, digits, or symbols. Use them if you like; nothing here demands them.</li>
            <li>Pasting from a password manager is fine and encouraged.</li>
            <li>Avoid your own name, your email address, and the name of this site.</li>
          </ul>
        </div>
      </article>`;

  const gateExplanation = flashMessage({
    kind: 'info',
    title: 'One more step',
    body:
      'The password you just used was issued by an administrator, and it is a ' +
      'one-time credential: it was written down or read aloud to hand it over, ' +
      'and it expires. Replace it with one only you know, and the rest of the app ' +
      'opens up.',
  });

  const main = html`
      ${pageHeader({
        title: mustChange ? 'Set your own password' : 'Change your password',
        subtitle: mustChange
          ? null
          : `Signed in as ${user?.displayName ?? ''}. Changing your password signs out every other session.`,
      })}
      ${mustChange ? gateExplanation : ''}
      ${summary}
      ${policy}

      <form class="form" method="post" action="/account/password" novalidate>
        ${csrfField(csrfToken)}
        ${passwordField({
          id: 'current_password',
          label: 'Current password',
          autocomplete: 'current-password',
          hint: mustChange
            ? 'The one-time password the administrator gave you.'
            : 'The password you signed in with.',
          error: byField.current_password.join(' ') || null,
        })}
        ${passwordField({
          id: 'new_password',
          label: 'New password',
          autocomplete: 'new-password',
          hint: `At least ${minLength} characters.`,
          error: byField.new_password.join(' ') || null,
          minLength,
          toggle: true,
        })}
        ${passwordField({
          id: 'confirm_password',
          label: 'New password again',
          autocomplete: 'new-password',
          hint: 'Typed twice so a slip does not lock you out.',
          minLength,
          toggle: true,
        })}

        <div class="form-actions">
          <button type="submit" class="btn btn--primary btn--block">Save new password</button>
          <p class="form-actions__note">
            Your old password stops working as soon as this is saved.
          </p>
        </div>
      </form>

      ${
        mustChange
          ? html`
      <form class="cluster" method="post" action="/logout">
        ${csrfField(csrfToken)}
        <button type="submit" class="btn btn--secondary btn--small">Sign out instead</button>
      </form>`
          : ''
      }`;

  return renderPage({
    title: mustChange ? 'Set your own password' : 'Change your password',
    // While the gate is up there is no navigation: every other page would just
    // bounce back here, so offering links would be a lie. Sign out is offered in
    // the page body instead, as a POST form.
    user: mustChange ? null : user,
    csrfToken,
    main,
    activeNav: null,
  });
}
