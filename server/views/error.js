/**
 * The error page. Deliberately the dullest file here.
 *
 * Two rules:
 *
 *  1. Nothing request-derived is ever rendered. No path, no query string, no
 *     header, no exception message. Those routinely contain file paths, SQL, and
 *     parameter values, and echoing any of it back turns an error page into both
 *     an information leak and a reflected-content vector. `title` and `message`
 *     must be strings this codebase wrote.
 *  2. It cannot depend on anything that might itself be broken. No stats, no
 *     database read, no rubric lookup: just the shell, a sentence, and a way out.
 */

import { html } from '../lib/html.js';
import { pageHeader, renderPage } from './layout.js';

/** Fallback copy, so a caller that passes only a status still gets a real page. */
const DEFAULTS = Object.freeze({
  400: {
    title: 'That request did not make sense',
    message: 'Something about the request was malformed. Try again from the page you started on.',
  },
  403: {
    title: 'Not allowed',
    message: 'Your account does not have access to that.',
  },
  404: {
    title: 'Not found',
    message: 'That page does not exist, or you do not have access to it.',
  },
  413: {
    title: 'That was too large',
    message: 'The upload exceeded the size limit. Try a smaller photo.',
  },
  429: {
    title: 'Too many requests',
    message: 'Wait a minute, then try again.',
  },
  500: {
    title: 'Something went wrong',
    message: 'The server hit an unexpected problem. Nothing you did caused it.',
  },
});

/**
 * @param {{
 *   status?: number,
 *   title?: ?string,
 *   message?: ?string,
 *   user?: ?{displayName?: string, role?: string},
 * }} input
 */
export function errorPage({ status = 500, title = null, message = null, user = null }) {
  const fallback = DEFAULTS[status] ?? DEFAULTS[500];
  const heading = title || fallback.title;
  const body = message || fallback.message;

  const main = html`
      ${pageHeader({ title: heading, subtitle: `Error ${Number(status) || 500}` })}
      <p>${body}</p>
      <div class="cluster">
        ${
          user
            ? html`<a class="btn btn--secondary" href="/">Back to the dashboard</a>`
            : html`<a class="btn btn--secondary" href="/login">Go to sign in</a>`
        }
      </div>`;

  return renderPage({
    title: heading,
    // No CSRF token reaches this page, so the nav renders without a sign-out
    // button rather than with a GET one.
    user,
    main,
  });
}
