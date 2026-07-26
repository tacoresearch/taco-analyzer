/**
 * One submitted survey, read only.
 *
 * The shape of `survey` is whatever `getSurvey()` in server/db/surveys.js
 * returns: camelCase at the top level (`businessName`, `visitedOn`,
 * `visitMetrics`, `items`), snake_case on the item and photo rows that come
 * straight out of SQLite (`item_name`, `price_cents`, `survey_item_id`), plus the
 * derived `tasteScore`, `context` and `pricePerItemCents`.
 *
 * The page keeps the rubric's layering visible: the taste score stands alone,
 * temperature and value are shown outside it under their own heading, and the
 * observer variables are labelled as data about the reviewer. Anyone reading a
 * record months later should not have to remember which numbers were in the score.
 *
 * There is no metric list in this file. Sections and metrics are read from the
 * rubric, so a survey saved under a future rubric renders with no edit here.
 */

import { html } from '../lib/html.js';
import { formatDate, formatDateTime, formatMoney, formatScore } from '../lib/format.js';
import { stateName } from '../lib/states.js';
import { sectionsForScope } from '../rubrics/index.js';
import { flashMessage, metaList, pageHeader, renderPage, scoreBadge } from './layout.js';

/**
 * Metric answers for one section as a `.meta-list`.
 *
 * @param {import('../rubrics/index.js').Section} section
 * @param {Record<string, number>} answers
 */
function metricList(section, answers) {
  return metaList(
    section.metrics.map((metric) => ({
      label: metric.label,
      // An unanswered metric is shown as such rather than dropped: a gap in the
      // record is information.
      value:
        typeof answers?.[metric.key] === 'number'
          ? `${formatScore(answers[metric.key])} of ${section.scale.max}`
          : 'Not answered',
      nums: true,
    })),
  );
}

/**
 * One photo, linked to its own full-size view.
 *
 * `width` and `height` are always set so the page does not jump as images load,
 * and `alt` describes what the picture is of, since a photo of a taco carries
 * information the surrounding text does not repeat.
 *
 * @param {{public_id: string, caption?: ?string}} photo row from getSurvey()
 * @param {string} alt
 */
function photoBlock(photo, alt) {
  return html`
        <figure class="stack stack--tight">
          <a class="photo-thumb-link" href="/photos/${photo.public_id}">
            <img class="photo-thumb" src="/photos/${photo.public_id}" width="320" height="240" alt="${alt}">
          </a>
          ${
            photo.caption
              ? html`<figcaption class="text-small text-muted">${photo.caption}</figcaption>`
              : ''
          }
        </figure>`;
}

/**
 * @param {{
 *   user: {displayName?: string, role?: string},
 *   csrfToken: string,
 *   survey: any,
 *   rubric: import('../rubrics/index.js').Rubric,
 *   justCreated?: boolean,
 * }} input
 */
export function surveyDetailPage({ user, csrfToken, survey, rubric, justCreated = false }) {
  const itemSections = sectionsForScope(rubric, 'item');
  const scoredSections = itemSections.filter((section) => section.scored);
  const unscoredSections = itemSections.filter((section) => !section.scored);
  const visitSections = sectionsForScope(rubric, 'visit');

  // Photos attached to the survey rather than to a particular item. Item photos
  // are rendered inside their item, so filtering here avoids showing them twice.
  const visitPhotos = (survey.photos ?? []).filter((photo) => photo.survey_item_id === null);

  const flash = justCreated
    ? flashMessage({
        kind: 'success',
        title: 'Survey saved',
        body: `${survey.businessName} is on the record. Here is what was stored.`,
      })
    : null;

  const main = html`
      ${pageHeader({
        title: survey.businessName,
        subtitle: `${survey.town}, ${stateName(survey.state)}. Visited ${formatDate(
          survey.visitedOn,
        )}. Recorded by ${survey.authorName}.`,
        actions: html`<a class="btn btn--secondary" href="/surveys">All surveys</a>`,
      })}

      <h2>The visit</h2>
      ${metaList([
        { label: 'Business', value: survey.businessName },
        { label: 'Town or city', value: survey.town },
        { label: 'State', value: stateName(survey.state) },
        { label: 'Date of visit', value: formatDate(survey.visitedOn) },
        { label: 'Recorded by', value: survey.authorName },
        { label: 'Submitted', value: formatDateTime(survey.submittedAt ?? survey.createdAt) },
        { label: 'Status', value: survey.status === 'submitted' ? 'Submitted' : 'Draft' },
        { label: 'Rubric', value: `${rubric.label} (version ${survey.rubricVersion})` },
        { label: 'Survey id', value: survey.publicId, mono: true },
      ])}

      <h2>${survey.items?.length === 1 ? `The ${rubric.itemNoun}` : rubric.itemNounPlural}</h2>
      ${(survey.items ?? []).map(
        (item) => html`
      <article class="card">
        <header class="card__header">
          <h3 class="card__title">${item.item_name}</h3>
          ${scoreBadge(item.tasteScore)}
        </header>
        <div class="card__body">
          ${metaList([
            { label: 'Menu price', value: formatMoney(item.price_cents), nums: true },
            { label: `${rubric.itemNounPlural} at that price`, value: item.qty, nums: true },
            {
              label: `Price per ${rubric.itemNoun}`,
              value: formatMoney(item.pricePerItemCents),
              nums: true,
            },
            {
              label: 'Taste score',
              value:
                item.tasteScore === null || item.tasteScore === undefined
                  ? 'Incomplete'
                  : `${formatScore(item.tasteScore)} of 5`,
              nums: true,
            },
          ])}

          ${scoredSections.map(
            (section) => html`
          <h4>${section.label}</h4>
          <p class="text-small text-muted">${section.blurb}</p>
          ${metricList(section, item.metrics)}`,
          )}

          ${unscoredSections.map(
            (section) => html`
          <h4>${section.label}, outside the taste score</h4>
          <p class="text-small text-muted">${section.blurb}</p>
          ${metricList(section, item.metrics)}`,
          )}

          ${
            (item.photos ?? []).length > 0
              ? html`
          <div class="cluster">
            ${item.photos.map((photo) =>
              photoBlock(photo, `${item.item_name} at ${survey.businessName}`),
            )}
          </div>`
              : ''
          }
        </div>
      </article>`,
      )}

      ${visitSections.map(
        (section) => html`
      <h2>${section.label}</h2>
      <p class="text-muted">${section.blurb}</p>
      ${metricList(section, survey.visitMetrics)}`,
      )}

      <h2>Photos</h2>
      ${
        visitPhotos.length === 0
          ? html`<p class="text-muted">No photo was attached to this visit.</p>`
          : html`<div class="cluster">
        ${visitPhotos.map((photo) =>
          photoBlock(photo, `The visit to ${survey.businessName} in ${survey.town}`),
        )}
      </div>`
      }

      <h2>Notes</h2>
      ${
        survey.notes
          ? // The stylesheet does not preserve newlines, and it must not be
            // worked around with an inline style, so each line the author typed
            // becomes its own paragraph. Empty lines are dropped.
            html`<div class="stack stack--tight">${String(survey.notes)
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
              .map((line) => html`<p>${line}</p>`)}</div>`
          : html`<p class="text-muted">No notes were left on this visit.</p>`
      }`;

  return renderPage({
    title: survey.businessName,
    user,
    csrfToken,
    activeNav: 'surveys',
    flash,
    main,
  });
}
