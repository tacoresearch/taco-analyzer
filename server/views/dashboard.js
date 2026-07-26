/**
 * The dashboard.
 *
 * Deliberate editorial choices, because a number on a dashboard is an argument:
 *
 *  - Total surveys is the hero. It is the only number that says whether the
 *    project is alive.
 *  - The taste average is labelled as the pure taste average and says so out
 *    loud, with the reminder that temperature and value are tracked beside it
 *    rather than folded into it. That layering is the whole point of the rubric,
 *    and a dashboard that blurred it would quietly undo the design.
 *  - Re-visited venues is shown even though the consistency modifier is not
 *    computed yet, because it is the count that will make it computable.
 *  - Zero surveys gets an invitation, not a wall of zeros.
 */

import { html } from '../lib/html.js';
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatScore,
  pluralize,
} from '../lib/format.js';
import { stateName } from '../lib/states.js';
import { pageHeader, renderPage } from './layout.js';

/**
 * A count for display. SQLite hands back NULL for a SUM over no rows, and the
 * aggregate query has already turned that into 0, so this is a second belt: a
 * dashboard must not render "null" or crash on one missing aggregate.
 *
 * @param {unknown} value
 */
function count(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toLocaleString('en-US') : '0';
}

/**
 * One `.stat-card`. The value comes before the label in the DOM (it is the thing
 * being read) while the label is still the heading.
 *
 * @param {{value: unknown, label: string, detail?: ?string}} input
 */
function statCard({ value, label, detail = null }) {
  return html`
        <div class="stat-card">
          <p class="stat-card__value text-nums">${value}</p>
          <h2 class="stat-card__label">${label}</h2>
          ${detail ? html`<p class="stat-card__detail">${detail}</p>` : ''}
        </div>`;
}

/**
 * @param {{
 *   public_id: string,
 *   business_name: string,
 *   state: string,
 *   town: string,
 *   visited_on: string,
 *   submitted_at: ?string,
 *   author_name: string,
 *   first_item_name: ?string,
 * }} row
 */
function recentCard(row) {
  return html`
        <article class="card">
          <header class="card__header">
            <h3 class="card__title"><a href="/surveys/${row.public_id}">${row.business_name}</a></h3>
            <span class="badge">${row.state}</span>
          </header>
          <div class="card__body">
            <p>
              ${row.first_item_name ?? 'No item recorded'}. ${row.town}, ${stateName(row.state)}.
              Visited ${formatDate(row.visited_on)}.
            </p>
            <p class="text-small text-muted">
              Recorded by ${row.author_name}, ${formatDateTime(row.submitted_at)}.
            </p>
          </div>
        </article>`;
}

/**
 * @param {{
 *   user: {displayName?: string, role?: string},
 *   csrfToken: string,
 *   stats: {
 *     totalSurveys: number, distinctVenues: number, distinctStates: number,
 *     totalItems: number, totalTacos: number, avgPricePerTacoCents: ?number,
 *     avgTasteScore: ?number, revisitedVenues: number, photoCount: number,
 *     firstVisit: ?string, latestVisit: ?string,
 *     byState: Array<{state: string, surveys: number}>,
 *   },
 *   recent: Array<object>,
 *   flash?: unknown,
 * }} input
 */
export function dashboardPage({ user, csrfToken, stats, recent = [], flash = null }) {
  const isAdmin = user?.role === 'admin';
  const newSurveyButton = html`<a class="btn btn--primary" href="/surveys/new">Start a new survey</a>`;

  const header = pageHeader({
    title: 'Dashboard',
    subtitle: isAdmin
      ? 'Every survey everyone has recorded.'
      : 'Your surveys, your numbers.',
    actions: newSurveyButton,
  });

  if (!stats || stats.totalSurveys === 0) {
    // Nothing to average yet, so say so and point at the one useful action.
    return renderPage({
      title: 'Dashboard',
      user,
      csrfToken,
      activeNav: 'dashboard',
      wide: true,
      flash,
      main: html`
      ${header}
      <div class="empty-state">
        <h2 class="empty-state__title">No tacos on the record yet</h2>
        <p class="empty-state__body">
          This is where the averages, the price per taco and the state-by-state
          breakdown show up. All of it needs a first survey. Find a taco, eat it
          attentively, then fill in the form.
        </p>
        <div class="empty-state__actions">
          ${newSurveyButton}
        </div>
      </div>`,
    });
  }

  const window_ =
    stats.firstVisit && stats.latestVisit
      ? `Visits from ${formatDate(stats.firstVisit)} to ${formatDate(stats.latestVisit)}.`
      : null;

  const main = html`
      ${header}

      <div class="stat-grid">
        ${statCard({
          value: count(stats.totalSurveys),
          label: 'Surveys recorded',
          detail: `Across ${pluralize(Number(stats.distinctVenues ?? 0), 'venue')} in ${pluralize(
            Number(stats.distinctStates ?? 0),
            'state',
          )}`,
        })}
        ${statCard({
          value: formatScore(stats.avgTasteScore),
          label: 'Mean taste score',
          detail: 'Out of 5. The taste metrics only, nothing else',
        })}
        ${statCard({
          value: count(stats.totalTacos),
          label: 'Tacos scored',
          detail: `${pluralize(Number(stats.totalItems ?? 0), 'menu item')} recorded`,
        })}
        ${statCard({
          value: formatMoney(stats.avgPricePerTacoCents),
          label: 'Average price per taco',
          detail: 'Menu price divided by the tacos it buys',
        })}
        ${statCard({
          value: count(stats.revisitedVenues),
          label: 'Venues revisited',
          detail: 'Where a consistency check becomes possible',
        })}
        ${statCard({
          value: count(stats.photoCount),
          label: 'Photos on file',
          detail: 'Location data stripped from every one',
        })}
      </div>

      <div class="stack stack--tight">
        <p class="text-small text-muted">
          The mean taste score is exactly that: the average of the taste metrics and
          nothing else. Serving temperature and value are recorded on every taco and
          reported on its own page, deliberately outside the taste score, so a well-made
          taco served lukewarm still reports how good the recipe was.
        </p>
        <p class="text-small text-muted">
          The rubric describes a consistency modifier that applies when a venue is
          scored more than once. It is not computed yet;
          ${pluralize(Number(stats.revisitedVenues ?? 0), 'venue')}
          ${Number(stats.revisitedVenues ?? 0) === 1 ? 'has' : 'have'} enough visits for
          it so far.
        </p>
        ${window_ ? html`<p class="text-small text-muted">${window_}</p>` : ''}
      </div>

      <h2>Recent activity</h2>
      ${
        recent.length === 0
          ? html`<p class="text-muted">Nothing submitted yet.</p>`
          : html`<div class="stack">${recent.map(recentCard)}</div>`
      }

      <h2>Where the tacos are</h2>
      <table class="data-table" role="table">
        <caption class="data-table__caption">
          Surveys by state, most first. Top ten.
        </caption>
        <thead role="rowgroup">
          <tr role="row">
            <th role="columnheader" scope="col">State</th>
            <th role="columnheader" scope="col" class="data-table__num">Surveys</th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          ${(stats.byState ?? []).map(
            (row) => html`
          <tr role="row">
            <td role="cell" data-label="State">${stateName(row.state)}</td>
            <td role="cell" data-label="Surveys" class="data-table__num text-nums">${row.surveys}</td>
          </tr>`,
          )}
        </tbody>
      </table>`;

  return renderPage({
    title: 'Dashboard',
    user,
    csrfToken,
    activeNav: 'dashboard',
    wide: true,
    flash,
    main,
  });
}
