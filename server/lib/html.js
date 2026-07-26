/**
 * A tiny auto-escaping HTML templating layer.
 *
 * The rule: interpolated values are escaped unless they are explicitly wrapped
 * in `raw()` or are themselves the result of an `html` template. That makes
 * escaping the default and unsafe output a deliberate, greppable act, which is
 * the property we want out of a hand-rolled templating layer.
 *
 * Usage:
 *   html`<p>Hello ${userName}</p>`                  // userName is escaped
 *   html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`  // arrays flatten
 *   html`<div>${raw(trustedMarkup)}</div>`          // opt out, deliberately
 *
 * Views return a Markup object; call String() (or .toString()) to get the text.
 */

const RAW = Symbol('raw-html');

/**
 * Marked-safe markup. Not a plain string, so a value can never be
 * accidentally treated as trusted just because it came from another function.
 */
class Markup {
  /** @param {string} value */
  constructor(value) {
    this.value = value;
    this[RAW] = true;
  }

  toString() {
    return this.value;
  }
}

/** @param {unknown} value */
function isMarkup(value) {
  return value instanceof Markup;
}

/**
 * Escape the five characters that matter in HTML text and quoted attributes.
 * Both quote styles are escaped so a single helper is safe in either context.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Declare a string already safe to emit. Only for markup this codebase built,
 * never for anything derived from user input.
 * @param {string} value
 */
export function raw(value) {
  return new Markup(String(value));
}

/**
 * Coerce one interpolated value to escaped markup text.
 * @param {unknown} value
 * @returns {string}
 */
function stringify(value) {
  if (value === null || value === undefined || value === false) return '';
  if (isMarkup(value)) return value.value;
  if (Array.isArray(value)) return value.map(stringify).join('');
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return escapeHtml(value);
}

/**
 * Tagged template that escapes every interpolation.
 * @param {TemplateStringsArray} strings
 * @param {...unknown} values
 * @returns {Markup}
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    out += stringify(values[i]) + strings[i + 1];
  }
  return new Markup(out);
}

/**
 * Build an attribute list from an object, skipping null/undefined/false and
 * rendering `true` as a bare boolean attribute.
 *
 *   attrs({ id: 'x', disabled: true, hidden: false })  ->  ` id="x" disabled`
 *
 * @param {Record<string, unknown>} map
 * @returns {Markup}
 */
export function attrs(map) {
  const parts = [];
  for (const [name, value] of Object.entries(map)) {
    if (value === null || value === undefined || value === false) continue;
    if (!/^[a-zA-Z][a-zA-Z0-9:._-]*$/.test(name)) {
      throw new Error(`Unsafe attribute name: ${name}`);
    }
    if (value === true) {
      parts.push(name);
    } else {
      parts.push(`${name}="${escapeHtml(value)}"`);
    }
  }
  return new Markup(parts.length ? ` ${parts.join(' ')}` : '');
}

/**
 * Join a conditional set of class names.
 *   cx('btn', isPrimary && 'btn--primary')  ->  'btn btn--primary'
 * @param {...unknown} values
 * @returns {string}
 */
export function cx(...values) {
  return values.filter((v) => typeof v === 'string' && v.length > 0).join(' ');
}

/**
 * Serialize a value for embedding in a <script type="application/json"> block.
 * Escapes the sequences that would otherwise let content break out of the
 * element or be misread by an HTML parser.
 * @param {unknown} value
 * @returns {Markup}
 */
export function jsonScript(value) {
  const json = JSON.stringify(value ?? null)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    // U+2028/U+2029 are legal in JSON strings but are line terminators to a
    // JavaScript parser, so they are escaped by codepoint, not literally.
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return new Markup(json);
}

export { Markup };
