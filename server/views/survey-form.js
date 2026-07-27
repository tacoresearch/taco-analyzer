/**
 * The survey form. The most important page in the app.
 *
 * Everything on it is generated from the rubric definition
 * (server/rubrics/taco_v1.js) through the helpers in server/rubrics/index.js.
 * There is no list of taco metrics in this file, and there must never be one: a
 * second rubric has to render correctly without an edit here.
 *
 * Field names follow the contract in the header of server/lib/validate.js:
 *
 *   business_name, state, town, visited_on, notes   visit columns
 *   metric.<metricKey>                              visit-scoped answer
 *   item.<i>.<fieldKey>                             item columns
 *   item.<i>.metric.<metricKey>                     item-scoped answer
 *
 * DOM ids are those names with dots turned into dashes (see `fieldDomId`), so an
 * `.error-summary` link and its control cannot drift apart.
 *
 * Two ordering decisions are load-bearing rather than cosmetic:
 *
 *  1. The CSRF token is the FIRST field in the form, before the file input. A
 *     streaming multipart parser sees parts in wire order, so a token that
 *     arrives after the photo cannot be checked until the whole upload has been
 *     buffered. (The current Hono handler buffers anyway; emitting the token
 *     first means swapping in a streaming parser needs no template change.)
 *  2. `novalidate` is set so the server's messages are the only ones a user sees,
 *     instead of a browser bubble competing with `.error-summary`. `required`,
 *     `inputmode`, `min`, `max` and `step` are still set, because those are what
 *     assistive tech announces and what picks the right on-screen keyboard.
 */

import { attrs, cx, html } from '../lib/html.js';
import { formatDate, todayIsoDate } from '../lib/format.js';
import { STATES } from '../lib/states.js';
import { ACCEPTED_MIME_TYPES } from '../lib/photos.js';
import { scaleValues, sectionsForScope } from '../rubrics/index.js';
import { csrfField } from '../security/csrf.js';
import {
  describedBy,
  errorSummary,
  fieldDomId,
  fieldError,
  pageHeader,
  renderPage,
} from './layout.js';

/**
 * Photo ceiling in bytes. Mirrors the MAX_UPLOAD_BYTES default in
 * server/config.js; a deployment that raises it can pass `maxPhotoBytes`.
 */
const DEFAULT_MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Human names for the mime types the server actually accepts. */
const FORMAT_LABELS = Object.freeze({
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
});

/** @param {string} value */
function capitalize(value) {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

/**
 * "1, 3 and 5" from [1, 3, 5]. Used for the anchor disclosure summary, so the
 * wording follows the rubric instead of assuming which levels are documented.
 * @param {Array<number|string>} items
 */
function joinWords(items) {
  if (items.length <= 1) return String(items[0] ?? '');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** @param {number} bytes */
function megabytes(bytes) {
  return Math.round(bytes / (1024 * 1024));
}

/* ------------------------------------------------------------------ *
 * Form field names, derived from the rubric
 * ------------------------------------------------------------------ */

/** @param {import('../rubrics/index.js').Field} field */
const visitFieldName = (field) => field.key;

/**
 * @param {number} index
 * @param {import('../rubrics/index.js').Field} field
 */
const itemFieldName = (index, field) => `item.${index}.${field.key}`;

/** @param {import('../rubrics/index.js').Metric} metric */
const visitMetricName = (metric) => `metric.${metric.key}`;

/**
 * @param {number} index
 * @param {import('../rubrics/index.js').Metric} metric
 */
const itemMetricName = (index, metric) => `item.${index}.metric.${metric.key}`;

/**
 * Every radio-group name on the form, in document order. This is what the
 * progress meter counts, and the server is the right place to count it because
 * the server is what knows the rubric.
 *
 * @param {import('../rubrics/index.js').Rubric} rubric
 * @param {number} itemCount
 * @returns {string[]}
 */
function metricFieldNames(rubric, itemCount) {
  const names = [];
  for (const section of sectionsForScope(rubric, 'visit')) {
    for (const metric of section.metrics) names.push(visitMetricName(metric));
  }
  for (let index = 0; index < itemCount; index += 1) {
    for (const section of sectionsForScope(rubric, 'item')) {
      for (const metric of section.metrics) names.push(itemMetricName(index, metric));
    }
  }
  return names;
}

/**
 * Field name to human label, for the error summary. Without this the summary
 * would fall back to raw keys like `item.0.price_cents` for any message that did
 * not already name its field.
 *
 * @param {import('../rubrics/index.js').Rubric} rubric
 * @param {number} itemCount
 * @returns {Record<string, string>}
 */
function buildFieldLabels(rubric, itemCount) {
  /** @type {Record<string, string>} */
  const labels = {};

  for (const field of rubric.visitFields) labels[visitFieldName(field)] = field.label;
  for (const section of sectionsForScope(rubric, 'visit')) {
    for (const metric of section.metrics) labels[visitMetricName(metric)] = metric.label;
  }

  for (let index = 0; index < itemCount; index += 1) {
    // Only worth qualifying when there is more than one item to confuse.
    const prefix = itemCount > 1 ? `${capitalize(rubric.itemNoun)} ${index + 1}: ` : '';
    for (const field of rubric.itemFields) {
      labels[itemFieldName(index, field)] = `${prefix}${field.label}`;
    }
    for (const section of sectionsForScope(rubric, 'item')) {
      for (const metric of section.metrics) {
        labels[itemMetricName(index, metric)] = `${prefix}${metric.label}`;
      }
    }
  }

  if (rubric.notesField) labels[rubric.notesField.key] = rubric.notesField.label;
  labels.photo = 'Photo';

  return labels;
}

/* ------------------------------------------------------------------ *
 * Field rendering
 * ------------------------------------------------------------------ */

/**
 * Hint text for a field. Money gets the currency appended, because
 * docs/ui-classes.md requires the currency to live in the hint: the `$` prefix
 * is decorative and `aria-hidden`, so it is not read out.
 *
 * @param {import('../rubrics/index.js').Field} field
 */
function hintFor(field) {
  const base = field.hint ?? '';
  if (field.type === 'money') {
    return `${base} Amounts are in US dollars, like 3.50.`.trim();
  }
  return base;
}

/**
 * One `.field` block. DOM order is fixed by the contract: label, hint, control,
 * error. That is also the order `aria-describedby` reads them in.
 *
 * `errorLabel` is the same string the error summary uses for this field, so the
 * two messages cannot disagree.
 *
 * @param {{
 *   field: import('../rubrics/index.js').Field,
 *   name: string,
 *   value?: string,
 *   error?: ?string,
 *   errorLabel?: ?string,
 * }} input
 */
function fieldBlock({ field, name, value = '', error = null, errorLabel = null }) {
  const id = fieldDomId(name);
  const hint = hintFor(field);
  const hintId = hint ? `${id}-hint` : null;
  const errorId = error ? `${id}-error` : null;

  /** Attributes every control shares. */
  const shared = {
    id,
    name,
    required: field.required === true,
    'aria-invalid': error ? 'true' : false,
    'aria-describedby': describedBy(hintId, errorId),
  };
  const invalid = error ? 'is-invalid' : null;

  let control;
  switch (field.type) {
    case 'state':
      control = html`<select${attrs({ ...shared, class: cx(invalid) || false })}>
                <option value="">Choose a state</option>
                ${STATES.map(
                  (state) => html`<option value="${state.code}"${attrs({
                    selected: state.code === value,
                  })}>${state.name}</option>`,
                )}
              </select>`;
      break;

    case 'date':
      control = html`<input type="date"${attrs({
        ...shared,
        class: cx(invalid) || false,
        // The validator refuses a future visit, so the picker should too.
        max: todayIsoDate(),
        value: value || todayIsoDate(),
      })}>`;
      break;

    case 'money':
      // type="text" with inputmode="decimal", not type="number": the server
      // parser accepts "12.50", "$12.50" and "1,250.00", and type="number"
      // discards a value the browser dislikes before it is ever submitted.
      control = html`<div class="field__control">
                <div class="input-group">
                  <span class="input-prefix" aria-hidden="true">$</span>
                  <input type="text" inputmode="decimal"${attrs({
                    ...shared,
                    class: cx('input--money', invalid),
                    value,
                  })}>
                </div>
              </div>`;
      break;

    case 'integer':
      control = html`<input type="number" inputmode="numeric" step="1"${attrs({
        ...shared,
        class: cx('input--qty', invalid),
        min: field.min,
        max: field.max,
        value,
      })}>`;
      break;

    case 'textarea':
      control = html`<textarea rows="4"${attrs({
        ...shared,
        class: cx(invalid) || false,
        maxlength: field.maxLength,
      })}>${value}</textarea>`;
      break;

    case 'text':
    default:
      control = html`<input type="text"${attrs({
        ...shared,
        class: cx(invalid) || false,
        maxlength: field.maxLength,
        autocomplete: field.autocomplete,
        value,
      })}>`;
      break;
  }

  return html`
            <div class="field">
              <label class="field__label" for="${id}">${field.label}${
                field.required
                  ? ''
                  : html` <span class="optional-marker">Optional</span>`
              }</label>
              ${hint ? html`<p class="field__hint" id="${hintId}">${hint}</p>` : ''}
              ${control}
              ${fieldError(error, errorId ?? '', errorLabel)}
            </div>`;
}

/* ------------------------------------------------------------------ *
 * The .scale control
 * ------------------------------------------------------------------ */

/**
 * The collapsed anchor disclosure. Collapsed on purpose: the anchor text is long
 * and is only needed when a score is genuinely borderline.
 *
 * @param {import('../rubrics/index.js').Metric} metric
 */
function scaleAnchors(metric) {
  const levels = Object.keys(metric.anchors ?? {})
    .map(Number)
    .filter((level) => Number.isFinite(level))
    .sort((a, b) => a - b);
  if (levels.length === 0) return html``;

  // Three documented levels read better named ("What 1, 3 and 5 mean"); a fully
  // documented scale would make that list unwieldy.
  const summary =
    levels.length <= 3 ? `What ${joinWords(levels)} mean` : 'What each level means';

  return html`
              <details class="scale__anchors">
                <summary class="scale__anchors-summary">${summary}</summary>
                <dl class="scale__anchor-list">
                  ${levels.map(
                    (level) => html`
                  <div class="scale__anchor">
                    <dt>${level}</dt>
                    <dd>${metric.anchors[level]}</dd>
                  </div>`,
                  )}
                </dl>
              </details>`;
}

/**
 * One rubric metric as a `.scale` fieldset.
 *
 * Structural rules from docs/ui-classes.md that are not optional here:
 *  - the wrapper is a `<fieldset>` and the question is its `<legend>`;
 *  - every `<input>` is the immediate previous sibling of its `<label>`, because
 *    the focus ring is drawn by `.scale__input:focus-visible + .scale__label`;
 *  - all options share one `name` and each carries `required`;
 *  - whole numbers are `--whole` and half steps are `--half`, which is what the
 *    grid template expects. The stylesheet ships column templates for the nine
 *    step and five step cases; a rubric with some other count would need one.
 *
 * Nothing is preselected. A default would be written to the database as if a
 * human had chosen it.
 *
 * @param {{
 *   section: import('../rubrics/index.js').Section,
 *   metric: import('../rubrics/index.js').Metric,
 *   name: string,
 *   value?: string,
 *   error?: ?string,
 *   errorLabel?: ?string,
 * }} input
 */
function scaleFieldset({ section, metric, name, value = '', error = null, errorLabel = null }) {
  const id = fieldDomId(name);
  const levels = scaleValues(section.scale);
  const errorId = error ? `${id}-error` : null;
  const chosen = String(value ?? '');

  return html`
            <fieldset class="${cx(
              'scale',
              levels.length === 5 && 'scale--five',
              error && 'is-invalid',
            )}" id="${id}"${attrs({
              'aria-describedby': errorId || false,
              // The anchor text, for app.js to show live as the user chooses a
              // level. Serialized here rather than fetched so it works offline
              // and needs no second request. attrs() escapes the quotes.
              'data-anchors': JSON.stringify(metric.anchors ?? {}),
            })}>
              <legend class="scale__legend">${metric.label}</legend>
              ${scaleAnchors(metric)}
              <!--
                Filled by app.js with the description of whatever level is
                selected. Starts hidden and empty: with JavaScript blocked the
                <details> above remains the way to read the anchors, so nothing
                here is load-bearing.
              -->
              <p class="scale__meaning" data-scale-meaning hidden aria-live="polite"></p>
              <div class="scale__options">
                ${levels.map((level) => {
                  // The dot in "4.5" is legal in an id but awkward in a selector
                  // and in a URL fragment, so it becomes an underscore.
                  const optionId = `${id}-${String(level).replace('.', '_')}`;
                  return html`
                <div class="${cx(
                  'scale__option',
                  Number.isInteger(level) ? 'scale__option--whole' : 'scale__option--half',
                )}">
                  <input class="scale__input" type="radio" id="${optionId}" name="${name}" value="${level}" required${attrs(
                    { checked: chosen !== '' && Number(chosen) === level },
                  )}>
                  <label class="scale__label" for="${optionId}"><span class="scale__number">${level}</span></label>
                </div>`;
                })}
              </div>
              <p class="scale__ends" aria-hidden="true">
                <span>${section.scale.min} low</span>
                <span>${section.scale.max} high</span>
              </p>
              ${fieldError(error, errorId ?? '', errorLabel)}
            </fieldset>`;
}

/* ------------------------------------------------------------------ *
 * The photo field
 * ------------------------------------------------------------------ */

/**
 * @param {{maxBytes: number, itemNoun: string, error?: ?string}} input
 */
function photoField({ maxBytes, itemNoun, error = null }) {
  const formats = joinWords(
    ACCEPTED_MIME_TYPES.map(
      (type) => FORMAT_LABELS[type] ?? type.replace('image/', '').toUpperCase(),
    ),
  );
  const errorId = error ? 'photo-error' : null;

  return html`
            <div class="field photo-field" data-photo-field data-max-bytes="${maxBytes}" data-accept="${ACCEPTED_MIME_TYPES.join(
              ',',
            )}">
              <label class="field__label" for="photo">
                Photo of the ${itemNoun}
                <span class="optional-marker">Optional</span>
              </label>
              <p class="field__hint" id="photo-hint">
                ${formats}, up to ${megabytes(maxBytes)} MB. One photo per survey. Your
                camera or your gallery, whichever is easier.
              </p>
              <p class="field__hint" id="photo-privacy">
                Worth knowing before you upload: if the photo carries a GPS location, it
                is read out and saved as part of the survey data, and then every trace of
                metadata (location, camera serial number, timestamps) is stripped from
                the image file that gets stored. The picture we keep and serve back has
                none of it left.
              </p>
              <input
                class="photo-field__input"
                type="file"
                id="photo"
                name="photo"
                accept="${ACCEPTED_MIME_TYPES.join(',')}"
                capture="environment"${attrs({
                  'aria-invalid': error ? 'true' : false,
                  'aria-describedby': describedBy('photo-hint', 'photo-privacy', errorId),
                })}>
              ${
                // Kept next to the control rather than after the app.js-owned
                // preview and status regions, so the message is adjacent to the
                // thing that failed.
                fieldError(error, errorId ?? '', 'Photo')
              }

              <div class="photo-field__preview" data-photo-preview>
                <img class="photo-field__image" alt="" data-photo-image>
                <p class="photo-field__filename" data-photo-filename></p>
              </div>

              <p class="photo-field__message" role="status" data-photo-message></p>
            </div>`;
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

/**
 * @param {{
 *   csrfToken: string,
 *   user: {displayName?: string, role?: string},
 *   rubric: import('../rubrics/index.js').Rubric,
 *   values?: Record<string, string>,
 *   errors?: ?import('../lib/validate.js').ValidationErrors,
 *   itemCount?: number,
 *   maxPhotoBytes?: number,
 * }} input
 */
export function surveyFormPage({
  csrfToken,
  user,
  rubric,
  values = {},
  errors = null,
  itemCount = 1,
  maxPhotoBytes = DEFAULT_MAX_PHOTO_BYTES,
}) {
  const count = Math.max(1, Number(itemCount) || 1);
  const failed = Boolean(errors && errors.count > 0);
  const fieldLabels = buildFieldLabels(rubric, count);

  /** @param {string} name */
  const valueOf = (name) => {
    const value = values?.[name];
    return typeof value === 'string' ? value : '';
  };
  /** @param {string} name */
  const errorOf = (name) => (errors ? errors.get(name) : null);

  const questionNames = metricFieldNames(rubric, count);
  const answered = questionNames.filter((name) => valueOf(name) !== '').length;

  const visitSections = sectionsForScope(rubric, 'visit');
  const itemSections = sectionsForScope(rubric, 'item');
  const itemNoun = rubric.itemNoun;

  const main = html`
      ${pageHeader({
        title: `Score a ${itemNoun}`,
        subtitle: rubric.label,
        actions: html`<a class="btn btn--quiet" href="/surveys">Cancel</a>`,
      })}

      ${errorSummary(errors, fieldLabels)}

      <form class="${cx('form', failed && 'form--validated')}" method="post" action="/surveys" enctype="multipart/form-data" novalidate>
        ${csrfField(csrfToken)}

        <p class="form__intro text-muted">
          Every question is required unless it is marked
          <span class="optional-marker">Optional</span>. ${rubric.blurb}
        </p>

        <div class="progress-meter" data-progress-meter data-total="${questionNames.length}">
          <p class="progress-meter__text" data-progress-text aria-live="polite">${answered} of ${
            questionNames.length
          } questions answered</p>
          <div class="progress-meter__track" aria-hidden="true">
            <div class="progress-meter__bar" data-progress-bar></div>
          </div>
        </div>

        <fieldset class="form-section">
          <legend class="form-section__legend">The visit</legend>
          <p class="form-section__blurb">Where and when. One set of answers per trip.</p>
          ${rubric.visitFields.map((field) => {
            const name = visitFieldName(field);
            return fieldBlock({
              field,
              name,
              value: valueOf(name),
              error: errorOf(name),
              errorLabel: fieldLabels[name],
            });
          })}
        </fieldset>

        ${visitSections.map(
          (section) => html`
        <fieldset class="form-section">
          <legend class="form-section__legend">${section.label}</legend>
          <p class="form-section__blurb">${section.blurb}</p>
          ${section.metrics.map((metric) => {
            const name = visitMetricName(metric);
            return scaleFieldset({
              section,
              metric,
              name,
              value: valueOf(name),
              error: errorOf(name),
              errorLabel: fieldLabels[name],
            });
          })}
        </fieldset>`,
        )}

        ${Array.from({ length: count }, (_, index) => {
          // Only number the sections when there is more than one item, so the
          // common single-taco case reads as plain English.
          const suffix = count > 1 ? ` (${itemNoun} ${index + 1})` : '';
          return html`
        <fieldset class="form-section">
          <legend class="form-section__legend">${
            count > 1 ? `${capitalize(itemNoun)} ${index + 1}` : `The ${itemNoun}`
          }</legend>
          <p class="form-section__blurb">What you ordered, and what it cost.</p>
          ${rubric.itemFields.map((field) => {
            const name = itemFieldName(index, field);
            return fieldBlock({
              field,
              name,
              value: valueOf(name),
              error: errorOf(name),
              errorLabel: fieldLabels[name],
            });
          })}
        </fieldset>

        ${itemSections.map(
          (section) => html`
        <fieldset class="form-section">
          <legend class="form-section__legend">${section.label}${suffix}</legend>
          <p class="form-section__blurb">${section.blurb}</p>
          ${section.metrics.map((metric) => {
            const name = itemMetricName(index, metric);
            return scaleFieldset({
              section,
              metric,
              name,
              value: valueOf(name),
              error: errorOf(name),
              errorLabel: fieldLabels[name],
            });
          })}
        </fieldset>`,
        )}`;
        })}

        <fieldset class="form-section">
          <legend class="form-section__legend">Photo and notes</legend>
          <p class="form-section__blurb">
            Both optional, both useful later. A photo settles arguments about portion
            size, and notes catch whatever the rubric has no box for.
          </p>
          ${photoField({ maxBytes: maxPhotoBytes, itemNoun, error: errorOf('photo') })}
          ${
            rubric.notesField
              ? fieldBlock({
                  field: rubric.notesField,
                  name: rubric.notesField.key,
                  value: valueOf(rubric.notesField.key),
                  error: errorOf(rubric.notesField.key),
                  errorLabel: fieldLabels[rubric.notesField.key],
                })
              : ''
          }
        </fieldset>

        <div class="form-actions form-actions--sticky">
          <button type="submit" class="btn btn--primary btn--block">Save survey</button>
          <p class="form-actions__note">
            Nothing is saved until you press Save. Visit date defaults to today
            (${formatDate(todayIsoDate())}); change it if you are writing up an
            earlier trip.
          </p>
        </div>
      </form>`;

  return renderPage({
    title: `Score a ${itemNoun}`,
    user,
    csrfToken,
    main,
    activeNav: 'new',
  });
}
