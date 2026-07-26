/**
 * The survey list.
 *
 * The table is the stacked-card layout below 768px and a real table above it, so
 * every ARIA role is written out explicitly and every `<td>` carries a
 * `data-label`. That is not belt and braces: changing `display` on table elements
 * makes Chromium and WebKit drop the native table semantics, so without the roles
 * a phone user gets an unlabelled list of values.
 *
 * The author column only appears when the list is scoped to everyone. For a
 * collector looking at their own submissions it would be the same name on every
 * row.
 */

import { attrs, html } from '../lib/html.js';
import { formatDate, formatDateTime, pluralize } from '../lib/format.js';
import { stateName } from '../lib/states.js';
import { pageHeader, renderPage, scoreBadge } from './layout.js';

/**
 * Page numbers to render, with `null` standing in for an ellipsis. Always keeps
 * the first page, the last page, and the current page's neighbours, so the
 * control stays one line wide on a phone however many pages there are.
 *
 * @param {number} current
 * @param {number} pageCount
 * @returns {Array<number|null>}
 */
function pageWindow(current, pageCount) {
  const wanted = [1, pageCount, current - 1, current, current + 1];
  const pages = [...new Set(wanted)]
    .filter((page) => page >= 1 && page <= pageCount)
    .sort((a, b) => a - b);

  /** @type {Array<number|null>} */
  const out = [];
  let previous = 0;
  for (const page of pages) {
    if (previous !== 0 && page - previous > 1) out.push(null);
    out.push(page);
    previous = page;
  }
  return out;
}

/**
 * @param {{total: number, limit: number, offset: number}} input
 */
function pagination({ total, limit, offset }) {
  const size = Math.max(1, limit);
  const pageCount = Math.max(1, Math.ceil(total / size));
  if (pageCount <= 1) return html``;

  const current = Math.min(pageCount, Math.floor(offset / size) + 1);

  /** @param {number} page */
  const href = (page) => `?page=${page}`;

  return html`
      <nav class="pagination" aria-label="Survey pages">
        <ul class="pagination__list">
          <li>${
            current > 1
              ? html`<a class="pagination__link" href="${href(current - 1)}">Previous</a>`
              : // A disabled link is a dead focus stop, so this is plain text.
                html`<span class="pagination__link--disabled" aria-hidden="true">Previous</span>`
          }</li>
          ${pageWindow(current, pageCount).map((page) =>
            page === null
              ? html`<li><span class="pagination__ellipsis" aria-hidden="true">...</span></li>`
              : html`<li><a class="pagination__link" href="${href(page)}"${attrs({
                  'aria-current': page === current ? 'page' : false,
                })}><span class="visually-hidden">Page </span>${page}</a></li>`,
          )}
          <li>${
            current < pageCount
              ? html`<a class="pagination__link" href="${href(current + 1)}">Next</a>`
              : html`<span class="pagination__link--disabled" aria-hidden="true">Next</span>`
          }</li>
        </ul>
      </nav>`;
}

/**
 * @param {{
 *   user: {displayName?: string, role?: string},
 *   csrfToken: string,
 *   rows: Array<{
 *     public_id: string, business_name: string, state: string, town: string,
 *     visited_on: string, status: string, submitted_at: ?string,
 *     author_name: string, item_count: number, photo_count: number,
 *     first_item_name: ?string, taste_score: ?number,
 *   }>,
 *   total: number,
 *   limit: number,
 *   offset: number,
 *   scopeIsAll?: boolean,
 * }} input
 */
export function surveyListPage({
  user,
  csrfToken,
  rows = [],
  total = 0,
  limit = 25,
  offset = 0,
  scopeIsAll = false,
}) {
  const header = pageHeader({
    title: 'Surveys',
    subtitle: scopeIsAll
      ? `${pluralize(total, 'survey')} from everyone.`
      : `${pluralize(total, 'survey')} you have recorded.`,
    actions: html`<a class="btn btn--primary" href="/surveys/new">New survey</a>`,
  });

  if (rows.length === 0) {
    return renderPage({
      title: 'Surveys',
      user,
      csrfToken,
      activeNav: 'surveys',
      wide: true,
      main: html`
      ${header}
      <div class="empty-state">
        <h2 class="empty-state__title">${
          total === 0 ? 'Nothing here yet' : 'Nothing on this page'
        }</h2>
        <p class="empty-state__body">${
          total === 0
            ? 'Every survey you save shows up in this list, newest first, with its taste score and what it cost.'
            : 'That page is past the end of the list. Go back to the first page.'
        }</p>
        <div class="empty-state__actions">
          ${
            total === 0
              ? html`<a class="btn btn--primary" href="/surveys/new">Start a survey</a>`
              : html`<a class="btn btn--secondary" href="/surveys">Back to page 1</a>`
          }
        </div>
      </div>`,
    });
  }

  const first = offset + 1;
  const last = offset + rows.length;

  const main = html`
      ${header}

      <table class="data-table" role="table">
        <caption class="data-table__caption">
          Showing ${first} to ${last} of ${pluralize(total, 'survey')}, newest first.
        </caption>
        <thead role="rowgroup">
          <tr role="row">
            <th role="columnheader" scope="col">Business</th>
            <th role="columnheader" scope="col">Item</th>
            <th role="columnheader" scope="col">Where</th>
            <th role="columnheader" scope="col">Visited</th>
            <th role="columnheader" scope="col">Taste</th>
            <th role="columnheader" scope="col" class="data-table__num">Tacos</th>
            <th role="columnheader" scope="col" class="data-table__num">Photos</th>
            <th role="columnheader" scope="col">Status</th>
            <th role="columnheader" scope="col">Submitted</th>
            ${scopeIsAll ? html`<th role="columnheader" scope="col">Author</th>` : ''}
          </tr>
        </thead>
        <tbody role="rowgroup">
          ${rows.map(
            (row) => html`
          <tr role="row">
            <td role="cell" data-label="Business"><a href="/surveys/${row.public_id}">${row.business_name}</a></td>
            <td role="cell" data-label="Item">${row.first_item_name ?? 'Not recorded'}</td>
            <td role="cell" data-label="Where">${row.town}, ${stateName(row.state)}</td>
            <td role="cell" data-label="Visited">${formatDate(row.visited_on)}</td>
            <td role="cell" data-label="Taste">${scoreBadge(row.taste_score)}</td>
            <td role="cell" data-label="Tacos" class="data-table__num text-nums">${row.item_count}</td>
            <td role="cell" data-label="Photos" class="data-table__num text-nums">${row.photo_count}</td>
            <td role="cell" data-label="Status"><span class="badge">${
              row.status === 'submitted' ? 'Submitted' : 'Draft'
            }</span></td>
            <td role="cell" data-label="Submitted">${formatDateTime(row.submitted_at)}</td>
            ${scopeIsAll ? html`<td role="cell" data-label="Author">${row.author_name}</td>` : ''}
          </tr>`,
          )}
        </tbody>
      </table>

      ${pagination({ total, limit, offset })}`;

  return renderPage({
    title: 'Surveys',
    user,
    csrfToken,
    activeNav: 'surveys',
    wide: true,
    main,
  });
}
