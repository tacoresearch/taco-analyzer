-- Taco Analyzer, initial schema.
--
-- Design notes
--
-- Timestamps are ISO-8601 UTC strings ('2026-07-26T14:03:11Z'). SQLite has no
-- native date type, and this format sorts correctly as text, is unambiguous,
-- and needs no conversion layer.
--
-- Money is stored as integer cents. Never floats.
--
-- Booleans are INTEGER 0/1 with CHECK constraints, since SQLite has no boolean.
--
-- Extensibility: rubric answers live in `responses` as (metric_key, value)
-- rows rather than as columns. A second rubric (business, non-taco items) is
-- therefore a new rubric definition in server/rubrics/ plus new rows here, not
-- an ALTER TABLE. A `survey` is a container for one visit and can hold several
-- `survey_items` of differing rubric_key, which is what makes a future
-- "taco + business + non-taco" combined survey possible without a redesign.

CREATE TABLE users (
  id                   INTEGER PRIMARY KEY,
  -- Stored lowercased and trimmed; the UNIQUE index is therefore the real
  -- guard against duplicate accounts differing only by case.
  email                TEXT    NOT NULL UNIQUE,
  display_name         TEXT    NOT NULL,
  -- Self-describing hash string: scrypt$N$r$p$saltB64$hashB64. Carrying the
  -- parameters inline lets us raise the cost later and rehash on next login
  -- without a migration or a second column.
  password_hash        TEXT    NOT NULL,
  role                 TEXT    NOT NULL DEFAULT 'collector'
                                 CHECK (role IN ('admin', 'collector')),
  is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  -- Set when an admin provisions or resets the account. Forces a rotation to a
  -- user-chosen password before anything else can be done.
  must_change_password INTEGER NOT NULL DEFAULT 1
                                 CHECK (must_change_password IN (0, 1)),
  -- An admin-issued initial password is a short-lived credential, not a
  -- permanent one. NULL once the user has chosen their own.
  password_expires_at  TEXT,
  password_updated_at  TEXT,

  -- Login throttling counters. Kept on the account row rather than derived from
  -- login_attempts because this is one indexed read we are already doing, and it
  -- survives a restart.
  failed_login_count     INTEGER NOT NULL DEFAULT 0,
  last_failed_login_at   TEXT,
  locked_until           TEXT,
  -- NIST SP 800-63B 3.2.2 SHALL: disable the authenticator after no more than
  -- 100 consecutive failures. This counter is never reset automatically.
  lifetime_failed_logins INTEGER NOT NULL DEFAULT 0,

  created_at           TEXT    NOT NULL,
  created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_login_at        TEXT
) STRICT;

CREATE TABLE sessions (
  -- The primary key is the SHA-256 of the session token, never the token
  -- itself: a stolen database dump then yields no usable sessions.
  id                  TEXT    PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at          TEXT    NOT NULL,
  -- Bumped on use to enforce an idle timeout.
  last_seen_at        TEXT    NOT NULL,
  -- Hard ceiling regardless of activity, to bound the value of a stolen token.
  absolute_expires_at TEXT    NOT NULL,
  -- Synchronizer CSRF token, scoped to this session and rotated with it. Stored
  -- in full (not hashed): unlike the session token it is not a bearer
  -- credential on its own, and it has to be echoed into every form.
  csrf_token          TEXT    NOT NULL,
  ip                  TEXT,
  user_agent          TEXT
) STRICT;

CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_absolute_expires_at_idx ON sessions(absolute_expires_at);

-- Login throttling. Rows are pruned periodically; this is not an audit log.
CREATE TABLE login_attempts (
  id           INTEGER PRIMARY KEY,
  -- Namespaced bucket: 'email:someone@example.com' or 'ip:203.0.113.7'. We
  -- throttle on both so one noisy IP cannot lock out every account, and one
  -- targeted account cannot be ground down from many IPs.
  bucket       TEXT    NOT NULL,
  attempted_at TEXT    NOT NULL,
  successful   INTEGER NOT NULL CHECK (successful IN (0, 1))
) STRICT;

CREATE INDEX login_attempts_bucket_idx ON login_attempts(bucket, attempted_at);

-- CSRF tokens for forms shown to visitors who have no session yet, which in
-- practice means the login form.
--
-- The login form needs CSRF protection like any other state-changing form: login
-- CSRF lets an attacker force a victim into a session the attacker controls. But
-- the synchronizer token for every other form lives on the session row, and an
-- anonymous visitor has none, so pre-authentication forms get their own short
-- lived store rather than being exempted from the check.
--
-- Like sessions, the cookie value is stored only as a SHA-256 hash.
CREATE TABLE pre_auth_tokens (
  id         TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX pre_auth_tokens_expires_at_idx ON pre_auth_tokens(expires_at);

CREATE TABLE surveys (
  id             INTEGER PRIMARY KEY,
  -- Random URL-safe identifier used in links, so survey URLs are not a
  -- sequential list an authenticated user can walk.
  public_id      TEXT    NOT NULL UNIQUE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- The entry rubric for this visit. Items may carry a different rubric_key
  -- once combined surveys exist.
  rubric_key     TEXT    NOT NULL,
  rubric_version INTEGER NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'submitted')),
  -- Visit identity. Column-backed rather than in `responses` because these are
  -- what every list, filter, and dashboard query groups by.
  business_name  TEXT    NOT NULL,
  state          TEXT    NOT NULL,
  town           TEXT    NOT NULL,
  visited_on     TEXT    NOT NULL,               -- 'YYYY-MM-DD', local to the visit
  notes          TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  submitted_at   TEXT
) STRICT;

CREATE INDEX surveys_user_id_idx ON surveys(user_id, created_at DESC);
CREATE INDEX surveys_status_idx ON surveys(status, submitted_at DESC);
CREATE INDEX surveys_location_idx ON surveys(state, town);
CREATE INDEX surveys_business_idx ON surveys(business_name);

-- One priced thing being scored within a visit. For taco_v1 this is a menu
-- item; a future business_v1 item would leave the pricing columns NULL.
CREATE TABLE survey_items (
  id             INTEGER PRIMARY KEY,
  survey_id      INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  rubric_key     TEXT    NOT NULL,
  rubric_version INTEGER NOT NULL,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  item_name      TEXT,
  price_cents    INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
  qty            INTEGER CHECK (qty IS NULL OR qty >= 1),
  created_at     TEXT    NOT NULL
) STRICT;

CREATE INDEX survey_items_survey_id_idx ON survey_items(survey_id, sort_order);
CREATE INDEX survey_items_name_idx ON survey_items(item_name);

-- Rubric answers, one row per metric. `survey_item_id` NULL means the answer is
-- scoped to the visit as a whole (the observer variables), not to one item.
CREATE TABLE responses (
  id             INTEGER PRIMARY KEY,
  survey_id      INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  survey_item_id INTEGER REFERENCES survey_items(id) ON DELETE CASCADE,
  rubric_key     TEXT    NOT NULL,
  metric_key     TEXT    NOT NULL,
  -- Scale answers land in value_num. value_text exists for future rubrics with
  -- free-text or single-choice metrics; taco_v1 leaves it NULL.
  value_num      REAL,
  value_text     TEXT,
  created_at     TEXT    NOT NULL,
  CHECK (value_num IS NOT NULL OR value_text IS NOT NULL)
) STRICT;

-- One answer per metric per scope. COALESCE keeps visit-scoped rows (NULL item)
-- from bypassing the constraint, since NULLs are distinct in a UNIQUE index.
CREATE UNIQUE INDEX responses_scope_metric_idx
  ON responses(survey_id, COALESCE(survey_item_id, 0), metric_key);
CREATE INDEX responses_metric_idx ON responses(metric_key, value_num);
CREATE INDEX responses_item_idx ON responses(survey_item_id);

CREATE TABLE photos (
  id             INTEGER PRIMARY KEY,
  public_id      TEXT    NOT NULL UNIQUE,
  survey_id      INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  survey_item_id INTEGER REFERENCES survey_items(id) ON DELETE SET NULL,
  -- Random on-disk name. The client's filename is never used as a path.
  storage_name   TEXT    NOT NULL UNIQUE,
  -- Determined from the file's magic bytes, not from the upload's headers or
  -- filename, both of which the client controls.
  mime_type      TEXT    NOT NULL,
  byte_size      INTEGER NOT NULL CHECK (byte_size > 0),
  sha256         TEXT    NOT NULL,
  -- The client's original filename, kept only as a display label. Never used as
  -- a path component.
  original_name  TEXT,
  caption        TEXT,

  -- Capture metadata read out of the image's Exif block and recorded HERE before
  -- being stripped from the stored file. The privacy property is unchanged: the
  -- image we serve carries no location, while the coordinates stay in our own
  -- database, where they let a reviewer sanity-check the town and business the
  -- collector typed in.
  --
  -- Extraction has to happen in the same pass as stripping, because stripping is
  -- irreversible: a photo stored before this existed could never have its
  -- coordinates recovered.
  gps_latitude    REAL CHECK (gps_latitude  IS NULL OR (gps_latitude  BETWEEN -90  AND 90)),
  gps_longitude   REAL CHECK (gps_longitude IS NULL OR (gps_longitude BETWEEN -180 AND 180)),
  gps_altitude_m  REAL,
  -- Distinguishes "the phone had location turned off" from "we never looked".
  had_gps         INTEGER NOT NULL DEFAULT 0 CHECK (had_gps IN (0, 1)),
  -- Exif DateTimeOriginal. Exif carries no timezone, so the raw string is kept
  -- alongside the parsed value rather than pretending it is UTC.
  captured_at     TEXT,
  captured_at_raw TEXT,
  camera_make     TEXT,
  camera_model    TEXT,
  uploaded_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at     TEXT    NOT NULL
) STRICT;

CREATE INDEX photos_survey_id_idx ON photos(survey_id, created_at);
CREATE INDEX photos_item_id_idx ON photos(survey_item_id);
CREATE INDEX photos_sha256_idx ON photos(sha256);
