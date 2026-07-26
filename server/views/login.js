/**
 * Sign-in page.
 *
 * Two rules shape this file:
 *
 *  1. The credential-failure message never varies by cause. The route hands us
 *     one sentence for every wrong-email, wrong-password, and no-such-account
 *     case, and this view renders whatever it is given without deciding anything
 *     for itself. A view that tried to be more helpful here would hand out an
 *     account-enumeration oracle.
 *  2. `error` and `notice` are server-authored sentences. Callers must not pass
 *     request-derived text through them. They are escaped either way, so the
 *     worst case is an ugly page rather than injected markup.
 */

import { attrs, html } from '../lib/html.js';
import { csrfField } from '../security/csrf.js';
import { flashMessage, pageHeader, renderPage } from './layout.js';

/**
 * @param {{
 *   csrfToken: string,
 *   email?: string,
 *   error?: ?string,
 *   notice?: ?string,
 *   next?: ?string,
 * }} input
 */
export function loginPage({ csrfToken, email = '', error = null, notice = null, next = null }) {
  const flash = [
    // Errors interrupt (role="alert"); a notice is announced politely.
    error ? flashMessage({ kind: 'error', title: 'Not signed in', body: error }) : null,
    notice ? flashMessage({ kind: 'info', body: notice }) : null,
  ].filter(Boolean);

  const main = html`
      ${pageHeader({
        title: 'Sign in',
        subtitle: 'Taco Analyzer is a private research tool. You need an account to go further.',
      })}

      <article class="card">
        <div class="card__body">
          <form class="form" method="post" action="/login">
            ${csrfField(csrfToken)}
            <input type="hidden" name="next"${attrs({ value: next || '' })}>

            <div class="field">
              <label class="field__label" for="email">Email address</label>
              <input
                type="email"
                id="email"
                name="email"
                inputmode="email"
                autocomplete="username"
                autocapitalize="none"
                autocorrect="off"
                spellcheck="false"
                maxlength="254"
                required${attrs({ value: email || '' })}>
            </div>

            <div class="field">
              <label class="field__label" for="password">Password</label>
              <input
                type="password"
                id="password"
                name="password"
                autocomplete="current-password"
                autocapitalize="none"
                spellcheck="false"
                required>
              <div class="cluster">
                <!--
                  Offered because NIST SP 800-63B asks that a password can be
                  shown while it is typed: hiding it makes long passphrases,
                  which is what we want people to use, hard to type correctly.
                  There is no maxlength on this input on purpose, so a manager
                  filling a very long password is never silently truncated.
                -->
                <button
                  type="button"
                  class="btn btn--secondary btn--small"
                  data-password-toggle="password"
                  aria-controls="password"
                  aria-pressed="false">Show password</button>
              </div>
            </div>

            <div class="form-actions">
              <button type="submit" class="btn btn--primary btn--block">Sign in</button>
            </div>
          </form>
        </div>
        <footer class="card__footer">
          <p class="text-small text-muted">
            Accounts are made by an administrator, so there is nothing to sign up for.
            If you need one, or you have lost your password, ask whoever runs this
            instance to issue you a new one.
          </p>
        </footer>
      </article>`;

  return renderPage({
    title: 'Sign in',
    // No user, so renderPage draws no navigation at all.
    user: null,
    main,
    flash,
  });
}
