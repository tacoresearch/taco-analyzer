/**
 * The page shell, the site chrome, and the feedback primitives every other view
 * builds on.
 *
 * Everything here goes through the `html` tagged template from ../lib/html.js,
 * so every interpolation is escaped. Nothing in server/views ever calls `raw()`
 * on a value that came from a user, a request, or the database.
 *
 * Structural requirements come from docs/ui-classes.md, which is a contract:
 * class names, element types, and ARIA attributes are not free choices here.
 */

import { attrs, cx, html } from '../lib/html.js';
import { formatScore, pluralize } from '../lib/format.js';
import { csrfField } from '../security/csrf.js';

/** Appended to every <title> and used in the footer. */
const SITE_NAME = 'Taco Analyzer';

/**
 * Main navigation, in render order. `key` is what a page passes as `activeNav`.
 * Kept as data so exactly one link can be given aria-current without every page
 * hand-writing the nav.
 */
const NAV_ITEMS = Object.freeze([
  { key: 'dashboard', href: '/', label: 'Dashboard' },
  { key: 'new', href: '/surveys/new', label: 'New survey' },
  { key: 'surveys', href: '/surveys', label: 'Surveys' },
  { key: 'users', href: '/admin/users', label: 'Users', adminOnly: true },
]);

/**
 * Flash and error styling per kind. `role="alert"` is reserved for errors, which
 * interrupt; success and info are announced politely.
 */
const FLASH_KINDS = Object.freeze({
  success: { modifier: 'flash--success', role: 'status', fallbackLabel: 'Done' },
  error: { modifier: 'flash--error', role: 'alert', fallbackLabel: 'Problem' },
  info: { modifier: 'flash--info', role: 'status', fallbackLabel: 'Note' },
  warn: { modifier: 'flash--warn', role: 'status', fallbackLabel: 'Heads up' },
});

/**
 * The DOM id for a form field name.
 *
 * Form field names follow the contract in server/lib/validate.js and contain
 * dots (`item.0.metric.tortilla`). A dot is legal in an id but is a nuisance in
 * a CSS selector and in a URL fragment, so it becomes a dash. Every view uses
 * this one function, which is what guarantees an `.error-summary` link and the
 * control it points at can never drift apart.
 *
 * @param {string} fieldName
 * @returns {string}
 */
export function fieldDomId(fieldName) {
  return String(fieldName).replaceAll('.', '-');
}

/**
 * Join ids for `aria-describedby`, dropping the ones that are absent.
 * Order matters: the hint is read before the error, matching the DOM order the
 * `.field` block requires.
 *
 * @param {...(string|null|undefined|false)} ids
 * @returns {string|false} false so `attrs()` omits the attribute entirely
 */
export function describedBy(...ids) {
  const present = ids.filter((id) => typeof id === 'string' && id.length > 0);
  return present.length > 0 ? present.join(' ') : false;
}

/**
 * The wording for one error, used identically in the summary and inline.
 *
 * docs/ui-classes.md requires the `.error-summary` link and the matching
 * `.field-error` to read the same, so both go through here with the same label.
 *
 * The validators in lib/validate.js already lead with the field's own label
 * ("Menu price must be an amount like 3.50"), which is why the label is not
 * simply prefixed: that would read "Menu price: Menu price must be...". A label
 * may also carry a qualifier ahead of a colon ("Taco 2: Menu price") to
 * disambiguate repeated fields on a multi-item form, and that part IS still
 * prefixed, because the validator cannot know about it.
 *
 * @param {string} message
 * @param {?string} [label]
 * @returns {string}
 */
export function errorText(message, label = null) {
  const text = String(message ?? '');
  if (!label) return text;

  const full = String(label);
  const bare = full.split(': ').pop() ?? full;
  if (text.toLowerCase().includes(bare.toLowerCase())) {
    const qualifier = full.slice(0, full.length - bare.length);
    return qualifier ? `${qualifier}${text}` : text;
  }
  return `${full}: ${text}`;
}

/**
 * A `.field-error` paragraph, or nothing when the field is fine.
 *
 * @param {?string} message
 * @param {string} errorId
 * @param {?string} [label]
 */
export function fieldError(message, errorId, label = null) {
  if (!message) return html``;
  return html`<p class="field-error" id="${errorId}">${errorText(message, label)}</p>`;
}

/**
 * A score as a `.score-badge`.
 *
 * The numeral and the tier word are both always rendered, so the tier survives
 * greyscale, colour blindness, and forced-colours mode. The out-of-5 context is
 * visually hidden beside the badge rather than being implied by the layout.
 *
 * @param {?number} value
 * @param {{outOf?: number, hideOutOf?: boolean}} [options]
 */
export function scoreBadge(value, options = {}) {
  const { outOf = 5, hideOutOf = false } = options;
  if (!Number.isFinite(value)) {
    return html`<span class="text-muted">Not scored</span>`;
  }
  // Thresholds match the tier words in docs/ui-classes.md (4.5 strong, 3.2 mid,
  // 1.8 weak) on a 1-to-5 scale, expressed as fractions so a future scale with a
  // different maximum still tiers sensibly.
  const fraction = value / outOf;
  const tier =
    fraction >= 0.8 ? { modifier: 'score-badge--strong', word: 'Strong' }
      : fraction >= 0.5 ? { modifier: 'score-badge--mid', word: 'Mid' }
        : { modifier: 'score-badge--weak', word: 'Weak' };

  return html`<span class="${cx('score-badge', tier.modifier)}"><span
      class="score-badge__value text-nums">${formatScore(value)}</span><span
      class="score-badge__tier">${tier.word}</span></span>${
    hideOutOf ? '' : html`<span class="visually-hidden"> out of ${outOf}</span>`
  }`;
}

/**
 * A `.meta-list` from label/value pairs. Rows whose value is null or undefined
 * are dropped rather than printed as an empty definition.
 *
 * @param {Array<{label: string, value: unknown, mono?: boolean, nums?: boolean}>} rows
 */
export function metaList(rows) {
  const present = rows.filter((row) => row && row.value !== null && row.value !== undefined && row.value !== '');
  if (present.length === 0) return html``;
  return html`
      <dl class="meta-list">
        ${present.map(
          (row) => html`
        <div class="meta-list__row">
          <dt class="meta-list__label">${row.label}</dt>
          <dd class="${cx('meta-list__value', row.mono && 'text-mono', row.nums && 'text-nums')}">${row.value}</dd>
        </div>`,
        )}
      </dl>`;
}

/**
 * A banner at the top of `.page`.
 *
 * `.flash__label` is mandatory: it is what carries the meaning in greyscale and
 * it is the first thing a screen reader reads. Do not put a colon in `title`;
 * the stylesheet adds one.
 *
 * @param {{kind?: 'success'|'error'|'info'|'warn', title?: string, body?: string}} input
 */
export function flashMessage({ kind = 'info', title = '', body = '' }) {
  const spec = FLASH_KINDS[kind] ?? FLASH_KINDS.info;
  return html`
      <p class="${cx('flash', spec.modifier)}" role="${spec.role}">
        <span class="flash__icon" aria-hidden="true"></span>
        <span class="flash__body">
          <strong class="flash__label">${title || spec.fallbackLabel}</strong>
          <span class="flash__message">${body}</span>
        </span>
      </p>`;
}

/**
 * The validation summary shown above a form after a failed submit.
 *
 * Links point at the control's own id, or at the `.scale` fieldset's id for a
 * rubric metric; app.js turns both into a real focus move. Only one of these may
 * exist per page.
 *
 * @param {?import('../lib/validate.js').ValidationErrors} errors
 * @param {Record<string, string>} [fieldLabels] field name -> human label
 */
export function errorSummary(errors, fieldLabels = {}) {
  if (!errors || errors.count === 0) return html``;
  const noun = pluralize(errors.count, 'problem');
  const verb = errors.count === 1 ? 'needs' : 'need';

  return html`
      <div class="error-summary" role="alert" tabindex="-1" data-error-summary>
        <h2 class="error-summary__title">${noun} ${verb} fixing</h2>
        <ul class="error-summary__list">
          ${errors.list.map(
            ({ field, message }) => html`
          <li class="error-summary__item">
            <a class="error-summary__link" href="#${fieldDomId(field)}">${errorText(message, fieldLabels[field])}</a>
          </li>`,
          )}
        </ul>
      </div>`;
}

/**
 * The single `<h1>` for a page, with an optional subtitle and action buttons.
 *
 * @param {{title: string, subtitle?: ?string, actions?: unknown}} input
 */
export function pageHeader({ title, subtitle = null, actions = null }) {
  return html`
      <div class="stack stack--tight">
        <div class="cluster cluster--between">
          <h1>${title}</h1>
          ${actions ? html`<div class="cluster">${actions}</div>` : ''}
        </div>
        ${subtitle ? html`<p class="text-muted">${subtitle}</p>` : ''}
      </div>`;
}

/**
 * The sign-out control.
 *
 * A POST form, never a link. A GET sign-out can be fired by a link prefetch, a
 * crawler, or an `<img src>` on any page the user visits, which would log people
 * out at random and give an attacker a cheap denial of service.
 *
 * @param {?string} csrfToken
 */
function signOutForm(csrfToken) {
  if (!csrfToken) return html``;
  return html`<form method="post" action="/logout">
          ${csrfField(csrfToken)}
          <button type="submit" class="btn btn--secondary btn--small">Sign out</button>
        </form>`;
}

/**
 * @param {{role?: string}} user
 * @param {?string} activeNav
 */
function mainNav(user, activeNav) {
  const items = NAV_ITEMS.filter((item) => !item.adminOnly || user.role === 'admin');
  return html`
      <nav class="site-nav" aria-label="Main">
        ${items.map(
          (item) => html`<a class="site-nav__link" href="${item.href}"${attrs({
            'aria-current': item.key === activeNav ? 'page' : false,
          })}>${item.label}</a>`,
        )}
      </nav>`;
}

/**
 * Who is signed in, plus the way out. A second nav is fine as long as it is
 * labelled, which is why `.site-nav` requires an aria-label.
 *
 * @param {{displayName?: string}} user
 * @param {?string} csrfToken
 */
function accountNav(user, csrfToken) {
  return html`
      <nav class="site-nav" aria-label="Account">
        <span class="text-small text-muted">${user.displayName ?? ''}</span>
        ${signOutForm(csrfToken)}
      </nav>`;
}

/**
 * Accept either a ready-made flash (Markup from flashMessage) or a descriptor,
 * so a route can pass whichever it has. A descriptor is recognised by its
 * `kind`; anything else is emitted as-is.
 *
 * @param {unknown} flash
 */
function renderFlash(flash) {
  if (!flash) return '';
  if (Array.isArray(flash)) return flash.map(renderFlash);
  if (typeof flash === 'object' && typeof (/** @type {any} */ (flash).kind) === 'string') {
    return flashMessage(/** @type {any} */ (flash));
  }
  return flash;
}

/**
 * Render a complete HTML document.
 *
 * Notes on the deliberate omissions:
 *
 *  - No `data-theme` on `<html>`. app.js sets it from localStorage on boot, and
 *    the stylesheet already follows the OS with dark as its fallback. Rendering
 *    a guess here is what would cause a flash of the wrong theme.
 *  - No inline script and no inline style anywhere. The CSP is
 *    `script-src 'self'; style-src 'self'`, which would refuse both.
 *  - The flash sits at the top of `.page`, inside `<main>`, because that is where
 *    docs/ui-classes.md places it.
 *
 * @param {{
 *   title: string,
 *   user?: ?{displayName?: string, role?: string},
 *   csrfToken?: ?string,
 *   main: unknown,
 *   flash?: unknown,
 *   wide?: boolean,
 *   bodyClass?: ?string,
 *   activeNav?: ?string,
 * }} input
 */
export function renderPage({
  title,
  user = null,
  csrfToken = null,
  main,
  flash = null,
  wide = false,
  bodyClass = null,
  activeNav = null,
}) {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark light">
    <title>${title} - ${SITE_NAME}</title>
    <link rel="icon" href="/favicon.svg">
    <link rel="stylesheet" href="/styles.css">
    <script src="/app.js" defer></script>
  </head>
  <body${attrs({ class: bodyClass || false })}>
    <div class="top-stripe"></div>
    <a class="skip-link" href="#main">Skip to main content</a>

    <header class="site-header">
      <a class="wordmark" href="/">
        <span class="wordmark__taco">Taco</span>
        <span class="wordmark__analyzer">Analyzer</span>
      </a>
      ${user ? mainNav(user, activeNav) : ''}
      ${user ? accountNav(user, csrfToken) : ''}
      <button type="button" class="theme-toggle" data-theme-toggle aria-pressed="true">
        <span class="theme-toggle__icon" aria-hidden="true"></span>
        <span class="theme-toggle__label">Dark mode</span>
      </button>
    </header>

    <main id="main" class="${cx('page', wide && 'page--wide')}" tabindex="-1">
      ${renderFlash(flash)}
      ${main}
    </main>

    <footer class="site-footer">
      <p>${SITE_NAME}. Scores are recorded per visit, per item.</p>
    </footer>
  </body>
</html>
`;
}
