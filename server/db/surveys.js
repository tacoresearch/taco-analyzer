/**
 * Survey persistence and the dashboard aggregates.
 *
 * Rubric answers live in `responses` as (metric_key, value) rows rather than
 * columns, which is what lets a second rubric be added without a migration. The
 * cost is that reading a survey means reassembling those rows, which is what
 * this module is for: nothing outside it should have to know the row layout.
 */

import crypto from 'node:crypto';
import { db } from './index.js';
import { nowIso } from '../lib/format.js';
import {
  DEFAULT_RUBRIC_KEY,
  getRubric,
  pricePerItemCents,
  scoreItem,
} from '../rubrics/index.js';

/**
 * The scored metric keys, as named SQL parameters.
 *
 * Derived from the rubric definition rather than typed out, so renaming or adding
 * a taste metric cannot leave a stale list here quietly averaging the wrong set.
 * Passed as bound parameters rather than interpolated: metric keys are
 * developer-controlled today, but a rubric loaded from anywhere else must never
 * become an injection path.
 */
const TASTE_METRIC_KEYS = getRubric(DEFAULT_RUBRIC_KEY)
  .sections.filter((section) => section.scored)
  .flatMap((section) => section.metrics.map((metric) => metric.key));

const TASTE_METRIC_PLACEHOLDERS = TASTE_METRIC_KEYS.map(
  (_, index) => `@taste${index}`,
).join(', ');

const TASTE_METRIC_PARAMS = Object.fromEntries(
  TASTE_METRIC_KEYS.map((key, index) => [`taste${index}`, key]),
);

/**
 * A short, URL-safe, non-sequential identifier.
 *
 * Surveys are addressed by this rather than by their integer id so the URL space
 * is not a list an authenticated user can walk to enumerate other people's
 * submissions. 12 base32 characters is 60 bits, far beyond guessing range for a
 * dataset this size. Authorization is still enforced on every route: this is
 * defence in depth, not the access control.
 */
function generatePublicId() {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32
  const bytes = crypto.randomBytes(12);
  return [...bytes].map((byte) => alphabet[byte % 32]).join('');
}

/**
 * Insert a complete survey.
 *
 * Everything happens in one transaction: a survey with some of its answers
 * missing is worse than no survey at all, because it looks like real data.
 *
 * @param {{
 *   userId: number,
 *   rubric: import('../rubrics/index.js').Rubric,
 *   visit: Record<string, any>,
 *   visitMetrics: Record<string, number>,
 *   items: Array<{fields: Record<string, any>, metrics: Record<string, number>}>,
 *   notes: string,
 *   status?: 'draft'|'submitted',
 * }} input
 * @returns {{id: number, publicId: string}}
 */
export function createSurvey({
  userId,
  rubric,
  visit,
  visitMetrics,
  items,
  notes,
  status = 'submitted',
}) {
  const database = db();
  const now = nowIso();
  const publicId = generatePublicId();

  const run = database.transaction(() => {
    const survey = database
      .prepare(
        `INSERT INTO surveys
           (public_id, user_id, rubric_key, rubric_version, status,
            business_name, state, town, visited_on, notes,
            created_at, updated_at, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        publicId,
        userId,
        rubric.key,
        rubric.version,
        status,
        visit.business_name,
        visit.state,
        visit.town,
        visit.visited_on,
        notes || null,
        now,
        now,
        status === 'submitted' ? now : null,
      );

    const insertResponse = database.prepare(
      `INSERT INTO responses
         (survey_id, survey_item_id, rubric_key, metric_key, value_num, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    // Visit-scoped answers: the observer variables, stored with a NULL item.
    for (const [metricKey, value] of Object.entries(visitMetrics)) {
      insertResponse.run(survey.id, null, rubric.key, metricKey, value, now);
    }

    const insertItem = database.prepare(
      `INSERT INTO survey_items
         (survey_id, rubric_key, rubric_version, sort_order,
          item_name, price_cents, qty, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    );

    items.forEach((item, index) => {
      const inserted = insertItem.get(
        survey.id,
        rubric.key,
        rubric.version,
        index,
        item.fields.item_name ?? null,
        item.fields.price_cents ?? null,
        item.fields.qty ?? null,
        now,
      );
      for (const [metricKey, value] of Object.entries(item.metrics)) {
        insertResponse.run(survey.id, inserted.id, rubric.key, metricKey, value, now);
      }
    });

    return { id: survey.id, publicId };
  });

  return run();
}

/**
 * Load a survey with its items, answers, and photos.
 *
 * @param {string} publicId
 * @param {import('../rubrics/index.js').Rubric} rubric
 * @returns {object|null}
 */
export function getSurvey(publicId, rubric) {
  const survey = db()
    .prepare(
      `SELECT s.*, u.display_name AS author_name, u.email AS author_email
         FROM surveys s
         JOIN users u ON u.id = s.user_id
        WHERE s.public_id = ?`,
    )
    .get(publicId);

  if (!survey) return null;

  const responses = db()
    .prepare(
      `SELECT survey_item_id, metric_key, value_num, value_text
         FROM responses
        WHERE survey_id = ?`,
    )
    .all(survey.id);

  /** @type {Record<string, number>} */
  const visitMetrics = {};
  /** @type {Map<number, Record<string, number>>} */
  const itemMetrics = new Map();

  for (const row of responses) {
    const value = row.value_num;
    if (row.survey_item_id === null) {
      visitMetrics[row.metric_key] = value;
    } else {
      if (!itemMetrics.has(row.survey_item_id)) itemMetrics.set(row.survey_item_id, {});
      itemMetrics.get(row.survey_item_id)[row.metric_key] = value;
    }
  }

  const photos = db()
    .prepare(
      `SELECT public_id, storage_name, mime_type, byte_size, original_name,
              caption, created_at, survey_item_id
         FROM photos
        WHERE survey_id = ?
        ORDER BY created_at`,
    )
    .all(survey.id);

  const items = db()
    .prepare(
      `SELECT id, item_name, price_cents, qty, sort_order, rubric_key
         FROM survey_items
        WHERE survey_id = ?
        ORDER BY sort_order`,
    )
    .all(survey.id)
    .map((item) => {
      const metrics = itemMetrics.get(item.id) ?? {};
      const scored = scoreItem(rubric, metrics);
      return {
        ...item,
        metrics,
        tasteScore: scored.score,
        context: scored.context,
        pricePerItemCents: pricePerItemCents(item.price_cents, item.qty),
        photos: photos.filter((photo) => photo.survey_item_id === item.id),
      };
    });

  return {
    id: survey.id,
    publicId: survey.public_id,
    userId: survey.user_id,
    authorName: survey.author_name,
    authorEmail: survey.author_email,
    rubricKey: survey.rubric_key,
    rubricVersion: survey.rubric_version,
    status: survey.status,
    businessName: survey.business_name,
    state: survey.state,
    town: survey.town,
    visitedOn: survey.visited_on,
    notes: survey.notes,
    createdAt: survey.created_at,
    submittedAt: survey.submitted_at,
    visitMetrics,
    items,
    photos,
  };
}

/**
 * Paginated survey list.
 *
 * `userId` scopes the list to one collector. Collectors see only their own
 * submissions; admins see everything. That filter is applied here rather than
 * left to the caller so a route cannot leak the whole table by forgetting it.
 *
 * @param {{userId?: ?number, limit?: number, offset?: number}} options
 */
export function listSurveys({ userId = null, limit = 25, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(1, limit), 100);
  const safeOffset = Math.max(0, offset);

  const where = userId === null ? '' : 'WHERE s.user_id = @userId';

  const rows = db()
    .prepare(
      `SELECT s.public_id, s.business_name, s.state, s.town, s.visited_on,
              s.status, s.submitted_at, s.created_at,
              u.display_name AS author_name,
              (SELECT COUNT(*) FROM survey_items i WHERE i.survey_id = s.id) AS item_count,
              (SELECT COUNT(*) FROM photos p WHERE p.survey_id = s.id) AS photo_count,
              (SELECT i.item_name FROM survey_items i
                WHERE i.survey_id = s.id ORDER BY i.sort_order LIMIT 1) AS first_item_name,
              (SELECT ROUND(AVG(r.value_num), 2)
                 FROM responses r
                WHERE r.survey_id = s.id
                  AND r.survey_item_id IS NOT NULL
                  AND r.metric_key IN (${TASTE_METRIC_PLACEHOLDERS})) AS taste_score
         FROM surveys s
         JOIN users u ON u.id = s.user_id
         ${where}
        ORDER BY COALESCE(s.submitted_at, s.created_at) DESC
        LIMIT @limit OFFSET @offset`,
    )
    .all({ userId, limit: safeLimit, offset: safeOffset, ...TASTE_METRIC_PARAMS });

  const total =
    db()
      .prepare(
        `SELECT COUNT(*) AS n FROM surveys s ${userId === null ? '' : 'WHERE s.user_id = @userId'}`,
      )
      .get({ userId })?.n ?? 0;

  return { rows, total, limit: safeLimit, offset: safeOffset };
}

/**
 * Dashboard aggregates.
 *
 * Scoped to one user when `userId` is given, global for admins. Everything the
 * dashboard shows is derived here in one place so the numbers on the page cannot
 * disagree with each other.
 *
 * @param {{userId?: ?number}} options
 */
export function dashboardStats({ userId = null } = {}) {
  const scope = userId === null ? '' : 'AND s.user_id = @userId';
  const params = { userId, ...TASTE_METRIC_PARAMS };

  const totals = db()
    .prepare(
      `SELECT
         COUNT(*) AS total_surveys,
         COUNT(DISTINCT s.business_name || '|' || s.state || '|' || s.town) AS distinct_venues,
         COUNT(DISTINCT s.state) AS distinct_states,
         MIN(s.visited_on) AS first_visit,
         MAX(s.visited_on) AS latest_visit
       FROM surveys s
       WHERE s.status = 'submitted' ${scope}`,
    )
    .get(params);

  const itemTotals = db()
    .prepare(
      `SELECT COUNT(*) AS total_items,
              SUM(i.qty) AS total_tacos,
              ROUND(AVG(CAST(i.price_cents AS REAL) / NULLIF(i.qty, 0)), 1) AS avg_price_per_taco
         FROM survey_items i
         JOIN surveys s ON s.id = i.survey_id
        WHERE s.status = 'submitted' ${scope}`,
    )
    .get(params);

  const scoreRow = db()
    .prepare(
      `SELECT ROUND(AVG(r.value_num), 2) AS avg_taste
         FROM responses r
         JOIN surveys s ON s.id = r.survey_id
        WHERE s.status = 'submitted'
          AND r.survey_item_id IS NOT NULL
          AND r.metric_key IN (${TASTE_METRIC_PLACEHOLDERS})
          ${scope}`,
    )
    .get(params);

  // Venues visited more than once are where the consistency modifier in the
  // rubric becomes computable, so the dashboard surfaces the count now even
  // though the modifier itself is not implemented yet.
  const revisits = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT s.business_name, s.state, s.town, COUNT(*) AS visits
           FROM surveys s
          WHERE s.status = 'submitted' ${scope}
          GROUP BY s.business_name, s.state, s.town
         HAVING visits > 1
       )`,
    )
    .get(params);

  const photoCount = db()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM photos p
         JOIN surveys s ON s.id = p.survey_id
        WHERE s.status = 'submitted' ${scope}`,
    )
    .get(params);

  const byState = db()
    .prepare(
      `SELECT s.state, COUNT(*) AS surveys
         FROM surveys s
        WHERE s.status = 'submitted' ${scope}
        GROUP BY s.state
        ORDER BY surveys DESC, s.state
        LIMIT 10`,
    )
    .all(params);

  return {
    totalSurveys: totals?.total_surveys ?? 0,
    distinctVenues: totals?.distinct_venues ?? 0,
    distinctStates: totals?.distinct_states ?? 0,
    firstVisit: totals?.first_visit ?? null,
    latestVisit: totals?.latest_visit ?? null,
    totalItems: itemTotals?.total_items ?? 0,
    totalTacos: itemTotals?.total_tacos ?? 0,
    avgPricePerTacoCents: itemTotals?.avg_price_per_taco ?? null,
    avgTasteScore: scoreRow?.avg_taste ?? null,
    revisitedVenues: revisits?.n ?? 0,
    photoCount: photoCount?.n ?? 0,
    byState,
  };
}

/**
 * Attach a stored photo to a survey.
 *
 * `metadata` carries what was read out of the image's Exif block before it was
 * stripped from the file itself: coordinates, capture time, and camera. Recording
 * it here is the whole reason extraction happens during stripping, since
 * stripping cannot be undone. See docs/security-decisions.md.
 *
 * @param {{
 *   surveyId: number, surveyItemId: ?number, uploadedBy: number,
 *   storageName: string, mimeType: string, byteSize: number, sha256: string,
 *   originalName: ?string, caption: ?string,
 *   metadata?: {
 *     gpsLatitude?: ?number, gpsLongitude?: ?number, gpsAltitudeMetres?: ?number,
 *     hadGps?: boolean, capturedAt?: ?string, capturedAtRaw?: ?string,
 *     cameraMake?: ?string, cameraModel?: ?string,
 *   },
 * }} input
 */
export function addPhoto(input) {
  const publicId = generatePublicId();
  const meta = input.metadata ?? {};

  db()
    .prepare(
      `INSERT INTO photos
         (public_id, survey_id, survey_item_id, storage_name, mime_type,
          byte_size, sha256, original_name, caption, uploaded_by, created_at,
          gps_latitude, gps_longitude, gps_altitude_m, had_gps,
          captured_at, captured_at_raw, camera_make, camera_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      publicId,
      input.surveyId,
      input.surveyItemId ?? null,
      input.storageName,
      input.mimeType,
      input.byteSize,
      input.sha256,
      input.originalName ?? null,
      input.caption ?? null,
      input.uploadedBy,
      nowIso(),
      Number.isFinite(meta.gpsLatitude) ? meta.gpsLatitude : null,
      Number.isFinite(meta.gpsLongitude) ? meta.gpsLongitude : null,
      Number.isFinite(meta.gpsAltitudeMetres) ? meta.gpsAltitudeMetres : null,
      meta.hadGps ? 1 : 0,
      meta.capturedAt ?? null,
      meta.capturedAtRaw ?? null,
      meta.cameraMake ?? null,
      meta.cameraModel ?? null,
    );
  return { publicId };
}

/**
 * Look up a photo for serving. Returns the owning survey's user so the route can
 * authorize before streaming any bytes.
 * @param {string} publicId
 */
export function getPhotoForServing(publicId) {
  return db()
    .prepare(
      `SELECT p.storage_name, p.mime_type, p.byte_size, p.original_name,
              p.created_at, s.user_id AS owner_id, s.public_id AS survey_public_id
         FROM photos p
         JOIN surveys s ON s.id = p.survey_id
        WHERE p.public_id = ?`,
    )
    .get(publicId);
}

/**
 * Recent submissions for the dashboard's activity list.
 * @param {{userId?: ?number, limit?: number}} options
 */
export function recentSurveys({ userId = null, limit = 8 } = {}) {
  return db()
    .prepare(
      `SELECT s.public_id, s.business_name, s.state, s.town, s.visited_on,
              s.submitted_at, u.display_name AS author_name,
              (SELECT i.item_name FROM survey_items i
                WHERE i.survey_id = s.id ORDER BY i.sort_order LIMIT 1) AS first_item_name
         FROM surveys s
         JOIN users u ON u.id = s.user_id
        WHERE s.status = 'submitted' ${userId === null ? '' : 'AND s.user_id = @userId'}
        ORDER BY s.submitted_at DESC
        LIMIT @limit`,
    )
    .all({ userId, limit: Math.min(Math.max(1, limit), 50) });
}
