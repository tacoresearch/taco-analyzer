/**
 * Display formatting. Kept in one place so a price or a date never renders two
 * different ways on two different pages.
 *
 * All functions tolerate null/undefined and return a placeholder rather than
 * throwing, because half-filled drafts are a normal state to render.
 */

const EM_DASH_FREE_PLACEHOLDER = '--';

/**
 * Integer cents to a dollar string.
 *   formatMoney(1250) -> '$12.50'
 * @param {?number} cents
 * @returns {string}
 */
export function formatMoney(cents) {
  if (!Number.isFinite(cents)) return EM_DASH_FREE_PLACEHOLDER;
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const remainder = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}$${dollars.toLocaleString('en-US')}.${remainder}`;
}

/**
 * Parse a user-typed price into integer cents.
 * Accepts '12.50', '$12.50', '12', '1,250.00'. Rejects anything else.
 * @param {unknown} input
 * @returns {number|null} cents, or null if unparseable
 */
export function parseMoneyToCents(input) {
  if (typeof input === 'number') {
    return Number.isFinite(input) ? Math.round(input * 100) : null;
  }
  if (typeof input !== 'string') return null;
  const cleaned = input.trim().replace(/^\$/, '').replaceAll(',', '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  // Parse the two sides separately: (12.10 * 100) is 1209.9999... in binary
  // floating point, and rounding that is a bug waiting to be reported.
  const [whole, frac = ''] = cleaned.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isFinite(cents) ? cents : null;
}

/**
 * A rubric score for display. Shows a half point only when there is one.
 *   formatScore(4)   -> '4'
 *   formatScore(4.5) -> '4.5'
 * @param {?number} value
 * @returns {string}
 */
export function formatScore(value) {
  if (!Number.isFinite(value)) return EM_DASH_FREE_PLACEHOLDER;
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/**
 * 'YYYY-MM-DD' to a short readable date, without pulling in a date library and
 * without letting the host timezone shift the day (the string is parsed as
 * calendar parts, not as an instant).
 * @param {?string} isoDate
 * @returns {string}
 */
export function formatDate(isoDate) {
  if (typeof isoDate !== 'string') return EM_DASH_FREE_PLACEHOLDER;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return EM_DASH_FREE_PLACEHOLDER;
  const [, year, month, day] = match;
  const monthNames = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const monthName = monthNames[Number(month) - 1];
  if (!monthName) return EM_DASH_FREE_PLACEHOLDER;
  return `${monthName} ${Number(day)}, ${year}`;
}

/**
 * A full UTC timestamp to a readable local-ish string. Rendered server side, so
 * this is the server's clock; precise enough for "when was this submitted".
 * @param {?string} isoTimestamp
 * @returns {string}
 */
export function formatDateTime(isoTimestamp) {
  if (typeof isoTimestamp !== 'string') return EM_DASH_FREE_PLACEHOLDER;
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) return EM_DASH_FREE_PLACEHOLDER;
  const date = formatDate(isoTimestamp.slice(0, 10));
  const time = parsed.toISOString().slice(11, 16);
  return `${date} at ${time} UTC`;
}

/** Current instant as the ISO-8601 UTC string the schema stores. */
export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Today as 'YYYY-MM-DD' in UTC, for defaulting the visit date. */
export function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Pluralize a count with its noun.
 *   pluralize(1, 'survey') -> '1 survey'
 *   pluralize(3, 'survey') -> '3 surveys'
 * @param {number} count
 * @param {string} singular
 * @param {string} [plural]
 */
export function pluralize(count, singular, plural) {
  const word = count === 1 ? singular : (plural ?? `${singular}s`);
  return `${count.toLocaleString('en-US')} ${word}`;
}

export { EM_DASH_FREE_PLACEHOLDER as PLACEHOLDER };
