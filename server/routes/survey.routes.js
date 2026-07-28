/**
 * Survey creation, listing, and the read view.
 */

import { requireAuth } from '../auth/middleware.js';
import { verifyCsrf, CSRF_FIELD_NAME } from '../security/csrf.js';
import { DEFAULT_RUBRIC_KEY, getRubric } from '../rubrics/index.js';
import { validateSurveySubmission, ValidationErrors } from '../lib/validate.js';
import { addPhoto, createSurvey, getSurvey, listSurveys } from '../db/surveys.js';
import {
  consumePendingPhoto,
  createPendingPhoto,
  discardPendingPhoto,
  getPendingPhoto,
  pendingToPhotoInput,
  removeUpload,
} from '../db/pending-photos.js';
import { PhotoError, storePhoto } from '../lib/photos.js';
import { surveyFormPage } from '../views/survey-form.js';
import { surveyListPage } from '../views/survey-list.js';
import { surveyDetailPage } from '../views/survey-detail.js';
import { todayIsoDate } from '../lib/format.js';

/** Only one item per survey in v1. The schema already allows more. */
const ITEM_COUNT = 1;

/** Hidden field carrying a photo across a submission that failed validation. */
const PHOTO_TOKEN_FIELD = 'photo_token';

/**
 * Flatten a parsed body into the string map the validator expects.
 *
 * File entries are dropped: they are handled separately, and a File object
 * reaching a text validator would stringify into nonsense.
 *
 * @param {Record<string, unknown>} body
 * @returns {Record<string, string>}
 */
function toFormValues(body) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') values[key] = value;
  }
  return values;
}

/**
 * @param {import('hono').Hono} app
 */
export function registerSurveyRoutes(app) {
  app.get('/surveys/new', requireAuth(), (c) => {
    const rubric = getRubric(DEFAULT_RUBRIC_KEY);
    return c.html(
      String(
        surveyFormPage({
          csrfToken: c.get('csrfToken'),
          user: c.get('user'),
          rubric,
          // Prefill only the visit date, which is almost always today. Nothing
          // else gets a default, because a defaulted rubric answer would be
          // indistinguishable from a real one in the data.
          values: { visited_on: todayIsoDate() },
          errors: new ValidationErrors(),
          itemCount: ITEM_COUNT,
        }),
      ),
    );
  });

  app.post('/surveys', requireAuth(), async (c) => {
    const config = c.get('config');
    const user = c.get('user');
    const rubric = getRubric(DEFAULT_RUBRIC_KEY);

    /*
     * Size check before parsing anything.
     *
     * Content-Length is client-supplied and so is only a hint, but rejecting an
     * obviously oversized upload here costs nothing and avoids buffering it. The
     * authoritative limit is enforced against the actual bytes further down.
     *
     * Honest limitation, also recorded in docs/security-decisions.md: the ideal
     * is to verify the CSRF token from the first part of a streaming multipart
     * parse and abort before reading the file. Hono reads a multipart body via
     * Request.formData(), which buffers it, so the token is checked after the
     * body is in memory rather than mid-stream. What keeps this acceptable is
     * that requireAuth() runs first, so only a signed-in user can reach the
     * parse at all, and the cap below bounds what any one request can consume.
     * The form still emits the token before the file input so that switching to
     * a streaming parser later needs no template changes.
     */
    const declaredLength = Number(c.req.header('content-length') ?? '0');
    const bodyCeiling = config.maxUploadBytes + 256 * 1024; // room for the text fields
    if (Number.isFinite(declaredLength) && declaredLength > bodyCeiling) {
      return c.text(
        'That submission is too large. Photos are limited to ' +
          `${Math.floor(config.maxUploadBytes / (1024 * 1024))} MB.`,
        413,
      );
    }

    let body;
    try {
      body = await c.req.parseBody();
    } catch {
      return c.text('That submission could not be read. Please try again.', 400);
    }

    // csrfGuard deferred the check for multipart bodies and requires this route
    // to perform it. Failing to set csrfVerified makes the guard throw, so this
    // cannot be silently skipped.
    const verdict = verifyCsrf({
      request: c.req.raw,
      method: 'POST',
      submittedToken: body?.[CSRF_FIELD_NAME] ?? null,
      sessionToken: c.get('session')?.csrfToken ?? null,
      allowedOrigins: config.allowedOrigins,
    });
    if (!verdict.ok) {
      return c.text(
        'This form could not be submitted because its security token was missing ' +
          'or out of date. Reload the page and try again.',
        403,
      );
    }
    c.set('csrfVerified', true);

    const values = toFormValues(body);
    const result = validateSurveySubmission(rubric, values, { itemCount: ITEM_COUNT });

    // Validate the photo, if any, BEFORE writing the survey. A survey saved with
    // a rejected photo would leave the user unsure whether to resubmit.
    const uploaded = body.photo;
    /** @type {Awaited<ReturnType<typeof storePhoto>>|null} */
    let storedPhoto = null;

    const hasFile =
      uploaded &&
      typeof uploaded === 'object' &&
      'arrayBuffer' in uploaded &&
      typeof uploaded.name === 'string' &&
      uploaded.size > 0;

    // A photo carried over from a previous attempt that failed validation. The
    // browser cannot refill a file input, so without this the user silently
    // loses the photo the moment they mistype anything else on the form.
    let carried = getPendingPhoto(values[PHOTO_TOKEN_FIELD], user.id);

    if (hasFile) {
      try {
        const bytes = Buffer.from(await uploaded.arrayBuffer());
        storedPhoto = await storePhoto({
          bytes,
          originalName: uploaded.name,
          uploadDir: config.uploadDir,
          tempDir: config.tempDir,
          maxBytes: config.maxUploadBytes,
        });
        // A newly chosen file replaces the carried one, so the old file goes now
        // rather than waiting for the expiry sweep.
        if (carried) {
          discardPendingPhoto(carried, config.uploadDir);
          carried = null;
        }
      } catch (error) {
        if (error instanceof PhotoError) {
          result.errors.add('photo', error.message);
        } else {
          throw error;
        }
      }
    }

    if (!result.ok || !result.errors.ok) {
      // The submission is going back to the user for correction. Hold on to any
      // photo already accepted, so fixing a typo does not cost them the picture.
      let photoToken = carried?.token ?? null;
      if (storedPhoto) {
        try {
          photoToken = createPendingPhoto({ userId: user.id, stored: storedPhoto });
        } catch (error) {
          // If we cannot record it we must not leave the file behind, or every
          // failed submit leaks megabytes that nothing will ever clean up.
          removeUpload(config.uploadDir, storedPhoto.storageName);
          photoToken = null;
          process.stderr.write(
            `[warn] could not hold uploaded photo across a failed submit: ${error.message}\n`,
          );
        }
      }

      return c.html(
        String(
          surveyFormPage({
            csrfToken: c.get('csrfToken'),
            user,
            rubric,
            values,
            errors: result.errors,
            itemCount: ITEM_COUNT,
            photoToken,
            photoName:
              storedPhoto?.originalName ?? carried?.original_name ?? null,
          }),
        ),
        422,
      );
    }

    const created = createSurvey({
      userId: user.id,
      rubric,
      visit: result.visit,
      visitMetrics: result.visitMetrics,
      items: result.items,
      notes: result.notes,
      status: 'submitted',
    });

    // Either a photo uploaded with this request, or one accepted during an
    // earlier attempt that failed validation.
    if (storedPhoto) {
      addPhoto({
        surveyId: created.id,
        surveyItemId: null,
        uploadedBy: user.id,
        storageName: storedPhoto.storageName,
        mimeType: storedPhoto.mimeType,
        byteSize: storedPhoto.byteSize,
        sha256: storedPhoto.sha256,
        originalName: storedPhoto.originalName,
        caption: null,
        metadata: storedPhoto.metadata,
      });
    } else if (carried) {
      addPhoto({
        surveyId: created.id,
        surveyItemId: null,
        uploadedBy: user.id,
        caption: null,
        ...pendingToPhotoInput(carried),
      });
      // The photos table owns the file now, so only the holding record goes.
      consumePendingPhoto(carried.token);
    }

    return c.redirect(`/surveys/${created.publicId}?created=1`, 303);
  });

  app.get('/surveys', requireAuth(), (c) => {
    const user = c.get('user');
    const isAdmin = user.role === 'admin';

    const limit = 25;
    const pageParam = Number(c.req.query('page') ?? '1');
    const page = Number.isFinite(pageParam) && pageParam >= 1 ? Math.floor(pageParam) : 1;

    const { rows, total, offset } = listSurveys({
      // Collectors only ever see their own submissions.
      userId: isAdmin ? null : user.id,
      limit,
      offset: (page - 1) * limit,
    });

    return c.html(
      String(
        surveyListPage({
          user,
          csrfToken: c.get('csrfToken'),
          rows,
          total,
          limit,
          offset,
          scopeIsAll: isAdmin,
        }),
      ),
    );
  });

  app.get('/surveys/:publicId', requireAuth(), (c) => {
    const user = c.get('user');
    const rubric = getRubric(DEFAULT_RUBRIC_KEY);
    const survey = getSurvey(c.req.param('publicId'), rubric);

    // A survey that exists but belongs to someone else is reported as missing
    // rather than forbidden, so the response does not confirm that the id is
    // real to someone probing for other people's submissions.
    if (!survey || (user.role !== 'admin' && survey.userId !== user.id)) {
      return c.notFound();
    }

    return c.html(
      String(
        surveyDetailPage({
          user,
          csrfToken: c.get('csrfToken'),
          survey,
          rubric,
          justCreated: c.req.query('created') === '1',
        }),
      ),
    );
  });
}
