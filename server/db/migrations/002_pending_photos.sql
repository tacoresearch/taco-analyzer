-- Photos that have been accepted but do not belong to a survey yet.
--
-- Why this table exists:
--
-- A browser cannot repopulate a file input. That is a deliberate security
-- property (a page must not be able to silently re-send a file you chose
-- earlier), and it is not something a web app can work around on the client.
--
-- So when a survey fails validation and the form re-renders, the chosen photo is
-- gone from the form even though the server already received it, validated it,
-- stripped its metadata, and wrote it to disk. The user sees their typo message,
-- fixes the typo, resubmits, and their photo is silently missing. That is
-- exactly what happened in real use: a mistyped price cost a photo, and the loss
-- was invisible until the survey was already saved.
--
-- Holding the accepted upload here, keyed by a random token echoed back in the
-- form, lets the resubmit re-attach the file the server already has. It also
-- fixes a second, quieter bug: without this table those files stayed on disk
-- with nothing referencing them, so every failed submit leaked a few megabytes
-- permanently.

CREATE TABLE pending_photos (
  id              INTEGER PRIMARY KEY,
  -- Random, unguessable, and echoed in the form as a hidden field. Ownership is
  -- still checked against user_id on redemption: this token identifies an
  -- upload, it does not authorize access to it.
  token           TEXT    NOT NULL UNIQUE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Everything needed to create the real photos row on a later successful
  -- submit, so redemption is a straight copy with no reprocessing of the file.
  storage_name    TEXT    NOT NULL UNIQUE,
  mime_type       TEXT    NOT NULL,
  byte_size       INTEGER NOT NULL CHECK (byte_size > 0),
  sha256          TEXT    NOT NULL,
  original_name   TEXT,

  gps_latitude    REAL CHECK (gps_latitude  IS NULL OR (gps_latitude  BETWEEN -90  AND 90)),
  gps_longitude   REAL CHECK (gps_longitude IS NULL OR (gps_longitude BETWEEN -180 AND 180)),
  gps_altitude_m  REAL,
  had_gps         INTEGER NOT NULL DEFAULT 0 CHECK (had_gps IN (0, 1)),
  captured_at     TEXT,
  captured_at_raw TEXT,
  camera_make     TEXT,
  camera_model    TEXT,

  created_at      TEXT    NOT NULL,
  -- Bounded lifetime. An abandoned draft must not keep a file on disk forever,
  -- and a stale token must stop working rather than lingering as a way to attach
  -- an old photo to a much later survey.
  expires_at      TEXT    NOT NULL
) STRICT;

CREATE INDEX pending_photos_user_id_idx ON pending_photos(user_id);
CREATE INDEX pending_photos_expires_at_idx ON pending_photos(expires_at);
