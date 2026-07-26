/**
 * Rubric registry and the helpers that read a rubric definition.
 *
 * Everything that needs to know the shape of a survey — the form renderer, the
 * validator, the scorer, the dashboard — goes through here rather than reaching
 * into a rubric module directly. That is what keeps a second rubric (business,
 * non-taco items) additive.
 *
 * @typedef {{min: number, max: number, step: number}} Scale
 * @typedef {{key: string, label: string, anchors: Record<number, string>}} Metric
 * @typedef {{key: string, scope: 'visit'|'item', scored: boolean, label: string,
 *            blurb: string, scale: Scale, metrics: Metric[]}} Section
 * @typedef {{key: string, column: string, label: string, type: string,
 *            required: boolean, hint: ?string, maxLength?: number,
 *            min?: number, max?: number, autocomplete?: string}} Field
 * @typedef {{key: string, version: number, label: string, itemNoun: string,
 *            itemNounPlural: string, blurb: string, visitFields: Field[],
 *            itemFields: Field[], sections: Section[], notesField: Field}} Rubric
 */

import tacoV1 from './taco_v1.js';

/** @type {Map<string, Rubric>} */
const REGISTRY = new Map([[tacoV1.key, tacoV1]]);

/** The rubric a new survey uses when none is specified. */
export const DEFAULT_RUBRIC_KEY = tacoV1.key;

/**
 * @param {string} key
 * @returns {Rubric}
 * @throws {Error} if the key is not registered — callers should validate first.
 */
export function getRubric(key) {
  const rubric = REGISTRY.get(key);
  if (!rubric) throw new Error(`Unknown rubric: ${key}`);
  return rubric;
}

/** @param {string} key */
export function hasRubric(key) {
  return REGISTRY.has(key);
}

/** @returns {Rubric[]} */
export function listRubrics() {
  return [...REGISTRY.values()];
}

/**
 * Sections answered at the given scope.
 * @param {Rubric} rubric
 * @param {'visit'|'item'} scope
 * @returns {Section[]}
 */
export function sectionsForScope(rubric, scope) {
  return rubric.sections.filter((s) => s.scope === scope);
}

/**
 * Every metric in the rubric, flattened, each tagged with its owning section.
 * @param {Rubric} rubric
 * @returns {Array<Metric & {section: Section}>}
 */
export function allMetrics(rubric) {
  return rubric.sections.flatMap((section) =>
    section.metrics.map((metric) => ({ ...metric, section })),
  );
}

/**
 * Look up a metric by key. Returns null rather than throwing so validators can
 * treat an unknown key as a rejected input instead of a crash.
 * @param {Rubric} rubric
 * @param {string} metricKey
 * @returns {(Metric & {section: Section})|null}
 */
export function findMetric(rubric, metricKey) {
  for (const section of rubric.sections) {
    const metric = section.metrics.find((m) => m.key === metricKey);
    if (metric) return { ...metric, section };
  }
  return null;
}

/**
 * The discrete values a scale permits, low to high. A 1-5 scale with half
 * points yields the nine levels the rubric calls for.
 * @param {Scale} scale
 * @returns {number[]}
 */
export function scaleValues(scale) {
  const values = [];
  const steps = Math.round((scale.max - scale.min) / scale.step);
  for (let i = 0; i <= steps; i += 1) {
    // Rounded to two places so 0.5 steps do not accumulate float drift.
    values.push(Math.round((scale.min + i * scale.step) * 100) / 100);
  }
  return values;
}

/**
 * True if `value` is one of the discrete levels the scale allows.
 * @param {Scale} scale
 * @param {unknown} value
 */
export function isValidScaleValue(scale, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return scaleValues(scale).some((allowed) => Math.abs(allowed - value) < 1e-9);
}

/**
 * Score one item from its answers.
 *
 * `scoreOf` returns the average of the metrics in every section marked
 * `scored`, which for taco_v1 is the six-metric taste average. Unscored
 * sections come back individually under `context` so they can be displayed
 * beside the headline number without ever being folded into it.
 *
 * Returns nulls rather than throwing on incomplete data, so partially filled
 * drafts can still be rendered.
 *
 * @param {Rubric} rubric
 * @param {Record<string, number>} answers metric key -> numeric value
 * @returns {{score: number|null, scoredCount: number, expectedCount: number,
 *            context: Record<string, number|null>}}
 */
export function scoreItem(rubric, answers) {
  const scoredMetrics = rubric.sections
    .filter((s) => s.scored && s.scope === 'item')
    .flatMap((s) => s.metrics);

  const present = scoredMetrics
    .map((m) => answers[m.key])
    .filter((v) => typeof v === 'number' && Number.isFinite(v));

  const score =
    present.length === scoredMetrics.length && scoredMetrics.length > 0
      ? Math.round((present.reduce((a, b) => a + b, 0) / present.length) * 100) / 100
      : null;

  /** @type {Record<string, number|null>} */
  const context = {};
  for (const section of rubric.sections) {
    if (section.scored || section.scope !== 'item') continue;
    for (const metric of section.metrics) {
      const value = answers[metric.key];
      context[metric.key] =
        typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
  }

  return {
    score,
    scoredCount: present.length,
    expectedCount: scoredMetrics.length,
    context,
  };
}

/**
 * Price per taco, in cents, or null when the inputs cannot support it.
 * Kept here because it is a property of how a rubric prices its item, and the
 * dashboard and item pages should not each reimplement the arithmetic.
 * @param {?number} priceCents
 * @param {?number} qty
 * @returns {number|null}
 */
export function pricePerItemCents(priceCents, qty) {
  if (!Number.isFinite(priceCents) || !Number.isFinite(qty) || qty <= 0) return null;
  return Math.round(priceCents / qty);
}
