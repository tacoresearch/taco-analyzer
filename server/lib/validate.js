/**
 * Server-side validation.
 *
 * Ground rules for this file:
 *
 *  1. The client is never trusted. HTML `required` and `min`/`max` attributes
 *     are conveniences for the user, not constraints on the request. Every
 *     field is revalidated here, and the rubric definition (not the submitted
 *     form) decides which fields and metrics are expected.
 *
 *  2. Unexpected input is rejected, not ignored. A metric key that is not in
 *     the rubric is an error rather than something we silently drop, so a
 *     tampered or stale form surfaces instead of writing partial data.
 *
 *  3. Validators return errors, they do not throw. A failed submit must be able
 *     to re-render the form with every message at once and the user's own
 *     values still in the inputs.
 *
 * Form field naming contract (flat keys, so a plain HTML form posts them with
 * no client-side JavaScript involved):
 *
 *   business_name, state, town, visited_on, notes   visit-level columns
 *   metric.<metricKey>                              visit-scoped rubric answer
 *   item.<i>.<fieldKey>                             item-level column
 *   item.<i>.metric.<metricKey>                     item-scoped rubric answer
 */

import { parseMoneyToCents, todayIsoDate } from './format.js';
import { isValidStateCode } from './states.js';
import { isValidScaleValue, sectionsForScope } from '../rubrics/index.js';

/** Longest single text input we will accept, as a backstop above per-field caps. */
const ABSOLUTE_MAX_TEXT = 8000;

/** Earliest plausible visit date. Guards against typo'd years like 0202. */
const EARLIEST_VISIT_DATE = '2000-01-01';

/**
 * Collects field-keyed error messages in submission order.
 * Used rather than a bare object so the error summary can list errors in the
 * order the fields appear on the page.
 */
export class ValidationErrors {
  constructor() {
    /** @type {Array<{field: string, message: string}>} */
    this.list = [];
    /** @type {Map<string, string>} */
    this.byField = new Map();
  }

  /**
   * Record an error. The first error on a field wins, so a specific message is
   * not overwritten by a later generic one.
   * @param {string} field
   * @param {string} message
   */
  add(field, message) {
    if (this.byField.has(field)) return;
    this.byField.set(field, message);
    this.list.push({ field, message });
  }

  /** @param {string} field */
  get(field) {
    return this.byField.get(field) ?? null;
  }

  /** @param {string} field */
  has(field) {
    return this.byField.has(field);
  }

  get ok() {
    return this.list.length === 0;
  }

  get count() {
    return this.list.length;
  }
}

/**
 * Reject C0/C1 control characters other than tab and newline. These have no
 * legitimate place in a business name or a note and are a common smuggling
 * vector through logs and terminals.
 * @param {string} value
 */
function hasControlChars(value) {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value);
}

/**
 * Normalize a submitted text value: coerce to string, strip a UTF-8 BOM,
 * normalize Unicode, convert CRLF to LF, and trim outer whitespace.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeText(raw) {
  if (raw === null || raw === undefined) return '';
  let value = String(raw);
  if (value.length > ABSOLUTE_MAX_TEXT) value = value.slice(0, ABSOLUTE_MAX_TEXT);
  return value
    .replace(/^\ufeff/, '')
    .normalize('NFC')
    .replaceAll('\r\n', '\n')
    .trim();
}

/**
 * Validate one text field against a rubric field definition.
 * @param {ValidationErrors} errors
 * @param {string} fieldName form key, used for error targeting
 * @param {unknown} raw
 * @param {{label: string, required: boolean, maxLength?: number}} spec
 * @returns {string|null} the cleaned value, or null when unusable
 */
export function validateText(errors, fieldName, raw, spec) {
  const value = normalizeText(raw);
  if (!value) {
    if (spec.required) errors.add(fieldName, `${spec.label} is required.`);
    return spec.required ? null : '';
  }
  if (hasControlChars(value)) {
    errors.add(fieldName, `${spec.label} contains characters that are not allowed.`);
    return null;
  }
  const max = spec.maxLength ?? 500;
  if (value.length > max) {
    errors.add(
      fieldName,
      `${spec.label} is too long (${value.length} characters; the limit is ${max}).`,
    );
    return null;
  }
  return value;
}

/**
 * Validate a whole-number field.
 * @param {ValidationErrors} errors
 * @param {string} fieldName
 * @param {unknown} raw
 * @param {{label: string, required: boolean, min?: number, max?: number}} spec
 * @returns {number|null}
 */
export function validateInteger(errors, fieldName, raw, spec) {
  const value = normalizeText(raw);
  if (!value) {
    if (spec.required) errors.add(fieldName, `${spec.label} is required.`);
    return null;
  }
  // Reject '1.5', '1e3', '0x10', and ' 1 2' rather than letting Number()
  // quietly accept or truncate them.
  if (!/^-?\d+$/.test(value)) {
    errors.add(fieldName, `${spec.label} must be a whole number.`);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    errors.add(fieldName, `${spec.label} is out of range.`);
    return null;
  }
  if (spec.min !== undefined && parsed < spec.min) {
    errors.add(fieldName, `${spec.label} must be at least ${spec.min}.`);
    return null;
  }
  if (spec.max !== undefined && parsed > spec.max) {
    errors.add(fieldName, `${spec.label} must be no more than ${spec.max}.`);
    return null;
  }
  return parsed;
}

/**
 * Validate a price, returning integer cents.
 * @param {ValidationErrors} errors
 * @param {string} fieldName
 * @param {unknown} raw
 * @param {{label: string, required: boolean, min?: number, max?: number}} spec
 * @returns {number|null}
 */
export function validateMoney(errors, fieldName, raw, spec) {
  const value = normalizeText(raw);
  if (!value) {
    if (spec.required) errors.add(fieldName, `${spec.label} is required.`);
    return null;
  }
  const cents = parseMoneyToCents(value);
  if (cents === null) {
    errors.add(
      fieldName,
      `${spec.label} must be an amount like 3.50 (dollars and cents, no other characters).`,
    );
    return null;
  }
  const min = spec.min ?? 0;
  if (cents < min) {
    errors.add(fieldName, `${spec.label} cannot be negative.`);
    return null;
  }
  if (spec.max !== undefined && cents > spec.max) {
    errors.add(fieldName, `${spec.label} looks too large. Check for a typo.`);
    return null;
  }
  return cents;
}

/**
 * Validate a 'YYYY-MM-DD' calendar date. Verifies the date actually exists
 * (rejecting 2026-02-30) and that it is neither in the future nor absurdly old.
 * @param {ValidationErrors} errors
 * @param {string} fieldName
 * @param {unknown} raw
 * @param {{label: string, required: boolean}} spec
 * @returns {string|null}
 */
export function validateDate(errors, fieldName, raw, spec) {
  const value = normalizeText(raw);
  if (!value) {
    if (spec.required) errors.add(fieldName, `${spec.label} is required.`);
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    errors.add(fieldName, `${spec.label} must be a date in YYYY-MM-DD form.`);
    return null;
  }
  const [, y, m, d] = match.map(Number);
  // Round-trip through UTC: if the parts survive, the calendar date is real.
  const asDate = new Date(Date.UTC(y, m - 1, d));
  if (
    asDate.getUTCFullYear() !== y ||
    asDate.getUTCMonth() !== m - 1 ||
    asDate.getUTCDate() !== d
  ) {
    errors.add(fieldName, `${spec.label} is not a real date.`);
    return null;
  }
  // Compare as strings, which is valid for this format and sidesteps timezones.
  if (value > todayIsoDate()) {
    errors.add(fieldName, `${spec.label} cannot be in the future.`);
    return null;
  }
  if (value < EARLIEST_VISIT_DATE) {
    errors.add(fieldName, `${spec.label} is too far in the past. Check the year.`);
    return null;
  }
  return value;
}

/**
 * Validate a US state code.
 * @param {ValidationErrors} errors
 * @param {string} fieldName
 * @param {unknown} raw
 * @param {{label: string, required: boolean}} spec
 * @returns {string|null}
 */
export function validateState(errors, fieldName, raw, spec) {
  const value = normalizeText(raw).toUpperCase();
  if (!value) {
    if (spec.required) errors.add(fieldName, `${spec.label} is required.`);
    return null;
  }
  if (!isValidStateCode(value)) {
    errors.add(fieldName, `${spec.label} must be chosen from the list.`);
    return null;
  }
  return value;
}

/**
 * Validate one rubric metric answer against its section's scale.
 * @param {ValidationErrors} errors
 * @param {string} fieldName
 * @param {unknown} raw
 * @param {{key: string, label: string}} metric
 * @param {{min: number, max: number, step: number}} scale
 * @returns {number|null}
 */
export function validateMetric(errors, fieldName, raw, metric, scale) {
  const value = normalizeText(raw);
  if (!value) {
    errors.add(fieldName, `${metric.label} needs a rating.`);
    return null;
  }
  const parsed = Number(value);
  if (!isValidScaleValue(scale, parsed)) {
    // A user driving the real form cannot produce this; it means a tampered
    // request or a stale cached page, so the message stays generic.
    errors.add(
      fieldName,
      `${metric.label} must be a rating from ${scale.min} to ${scale.max}.`,
    );
    return null;
  }
  return parsed;
}

/**
 * Dispatch to the right validator for a rubric field definition.
 * @param {ValidationErrors} errors
 * @param {string} fieldName
 * @param {unknown} raw
 * @param {import('../rubrics/index.js').Field} field
 */
function validateByFieldType(errors, fieldName, raw, field) {
  switch (field.type) {
    case 'text':
    case 'textarea':
      return validateText(errors, fieldName, raw, field);
    case 'state':
      return validateState(errors, fieldName, raw, field);
    case 'date':
      return validateDate(errors, fieldName, raw, field);
    case 'money':
      return validateMoney(errors, fieldName, raw, field);
    case 'integer':
      return validateInteger(errors, fieldName, raw, field);
    default:
      // A rubric declaring a type we have no validator for must fail loudly
      // rather than accept the value unchecked.
      throw new Error(`No validator for field type: ${field.type}`);
  }
}

/**
 * Validate a full survey submission against a rubric.
 *
 * @param {import('../rubrics/index.js').Rubric} rubric
 * @param {Record<string, string>} form flat form values, already string-coerced
 * @param {{itemCount?: number}} [options]
 * @returns {{
 *   ok: boolean,
 *   errors: ValidationErrors,
 *   visit: Record<string, string|number|null>,
 *   visitMetrics: Record<string, number>,
 *   items: Array<{fields: Record<string, string|number|null>, metrics: Record<string, number>}>,
 *   notes: string,
 * }}
 */
export function validateSurveySubmission(rubric, form, options = {}) {
  const errors = new ValidationErrors();
  const itemCount = Math.max(1, Math.min(options.itemCount ?? 1, 20));

  /** @type {Record<string, string|number|null>} */
  const visit = {};
  for (const field of rubric.visitFields) {
    visit[field.key] = validateByFieldType(errors, field.key, form[field.key], field);
  }

  /** @type {Record<string, number>} */
  const visitMetrics = {};
  for (const section of sectionsForScope(rubric, 'visit')) {
    for (const metric of section.metrics) {
      const fieldName = `metric.${metric.key}`;
      const value = validateMetric(
        errors,
        fieldName,
        form[fieldName],
        metric,
        section.scale,
      );
      if (value !== null) visitMetrics[metric.key] = value;
    }
  }

  const items = [];
  for (let i = 0; i < itemCount; i += 1) {
    /** @type {Record<string, string|number|null>} */
    const fields = {};
    for (const field of rubric.itemFields) {
      const fieldName = `item.${i}.${field.key}`;
      fields[field.key] = validateByFieldType(errors, fieldName, form[fieldName], field);
    }

    /** @type {Record<string, number>} */
    const metrics = {};
    for (const section of sectionsForScope(rubric, 'item')) {
      for (const metric of section.metrics) {
        const fieldName = `item.${i}.metric.${metric.key}`;
        const value = validateMetric(
          errors,
          fieldName,
          form[fieldName],
          metric,
          section.scale,
        );
        if (value !== null) metrics[metric.key] = value;
      }
    }
    items.push({ fields, metrics });
  }

  const notes = rubric.notesField
    ? (validateText(errors, rubric.notesField.key, form[rubric.notesField.key], rubric.notesField) ?? '')
    : '';

  return { ok: errors.ok, errors, visit, visitMetrics, items, notes };
}

/**
 * Validate an email address for the admin user-creation form.
 *
 * Deliberately conservative rather than RFC-complete: this app provisions its
 * own accounts, so a slightly strict rule that an admin can work around beats a
 * permissive one that admits addresses we cannot reason about. Length limits
 * follow RFC 5321 (64-octet local part, 254-octet total).
 *
 * @param {ValidationErrors} errors
 * @param {string} fieldName
 * @param {unknown} raw
 * @returns {string|null} the normalized, lowercased address
 */
export function validateEmail(errors, fieldName, raw) {
  const value = normalizeText(raw).toLowerCase();
  if (!value) {
    errors.add(fieldName, 'Email address is required.');
    return null;
  }
  if (value.length > 254) {
    errors.add(fieldName, 'Email address is too long.');
    return null;
  }
  const match = /^([^\s@"'\\]+)@([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)$/.exec(value);
  if (!match) {
    errors.add(fieldName, 'Enter a valid email address.');
    return null;
  }
  if (match[1].length > 64) {
    errors.add(fieldName, 'Email address is too long before the @ sign.');
    return null;
  }
  return value;
}

/**
 * Validate a role selection from the admin form.
 * @param {ValidationErrors} errors
 * @param {string} fieldName
 * @param {unknown} raw
 * @returns {'admin'|'collector'|null}
 */
export function validateRole(errors, fieldName, raw) {
  const value = normalizeText(raw);
  if (value === 'admin' || value === 'collector') return value;
  errors.add(fieldName, 'Choose a role.');
  return null;
}
