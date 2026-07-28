# Backlog

Deferred work, with enough context to act on it without reconstructing the
conversation that produced it. Ordered roughly by when it should be picked up.

---

## 0. Deploy verification: what is proven, what is not

**Deployed and verified 2026-07-27** on a Debian 13 (trixie) unprivileged LXC,
from a clean clone plus `bash deploy/install.sh --lan --hostname taco.lan
--email ...`. Five real bugs were found and fixed in the process, all of them
things no amount of re-reading would have caught.

Proven working:

- The installer end to end, exit 0 from a bare container: Node 24.18.0 tarball
  with GPG signature verification, `npm install` with no compiler needed
  (better-sqlite3's bundled Node-API prebuild loaded fine), migrations, the
  hardened systemd unit, Caddy with its internal CA.
- **The full systemd hardening applied cleanly in an unprivileged LXC.** None of
  the mount-namespace fallbacks triggered, and Caddy bound ports 80 and 443 via
  ambient `CAP_NET_BIND_SERVICE`, which had been flagged as unverified.
- **Argon2id was selected at runtime**, confirming Node's built-in
  `crypto.argon2` works and the scrypt fallback was not needed.
- Sign-in with a one-time password, the forced password change, survey
  submission, the dashboard, list and detail pages, admin pages, sign-out.
- Data correctness: price stored as integer cents, taste average computed to the
  expected 4.25, 11 response rows for 3 observer plus 8 item metrics.
- Rejections, which matter more than the happy path: forged CSRF token 403,
  cross-origin POST 403, wrong password returns the same generic message and
  status as an unknown account.
- `npm test`: 42 pass, 0 fail. `check-syntax`: 41 files, no errors.

**Not yet verified. Do these next:**

1. **A real photo upload from an actual phone.** This is the biggest remaining
   gap. The pipeline passes 42 synthetic tests, but no genuine camera JPEG has
   been through it, so GPS extraction from real EXIF is untested against real
   data. Take a photo with location on, submit it, and check that
   `gps_latitude`/`gps_longitude` land in the `photos` table AND that the served
   file has no EXIF (`exiftool` on the stored file should show nothing).
   Also confirm whether the phone produces HEIC, which is currently rejected.
2. **The `--public` Let's Encrypt path.** Only the LAN internal-CA path has run.
3. **The LXC hardening fallbacks**, which never executed because they were not
   needed. That detection code is therefore still unexercised.
4. **`update.sh` and `backup.sh`.** Neither has run. `update.sh` uses `setpriv`
   with an `xargs`-built environment that is fragile and probably has the same
   class of bug as the `runuser` PATH issue that was just fixed here.
5. **A second browser, on a real phone.** Everything so far was curl. The CSS,
   the scale widget's nine touch targets, and the theme toggle have never been
   rendered by a browser.

## 0b. Wire up the remaining client-side hook

`data-password-toggle` is **done** (app.js now handles it, preserving the caret
and re-concealing on submit or tab hide).

Still inert: **`data-confirm="<sentence>"`** on the destructive admin submits
(deactivate, reset password, change role). The attribute is rendered but no
handler reads it, so those actions fire immediately with no confirmation step.
They are all reversible by an admin and none of them destroy survey data, so this
is a papercut rather than a hazard, but it is a visible promise the UI is not
keeping.

A handler belongs in `public/app.js` next to `initPasswordToggles`, following the
same independently-guarded pattern: intercept submit on any form containing a
`[data-confirm]` submit button, and only proceed if confirmed. Note that
`window.confirm` is blocked in some embedded browsers, so treat a blocked dialog
as "do not proceed" rather than assuming it returned true.

## 0c. Restore onto a different machine: script and docs

Backup and restore-in-place are built and verified. Restoring onto a *different*
machine is not documented, and the existing restore snippet in DEPLOY.md has a
real gap.

### The documentation gap (fix this even if the script never gets written)

`DEPLOY.md`'s restore steps omit `migrate`, and cover only same-machine restore.

**Running `migrate` after a restore is not optional.** A backup is a snapshot of
the schema as it was. Restore one taken before `002_pending_photos` onto current
code and the app starts against a database with no such table. Migrations are
idempotent, so running it always is safe.

### `deploy/restore.sh`

Should take a backup directory and do the whole sequence, refusing rather than
guessing when something looks wrong.

```
sudo deploy/restore.sh /path/to/20260728T002048Z [--force]
```

Steps: verify the source (a `taco.db` and a readable `MANIFEST`), run
`PRAGMA integrity_check` on the backup *before* touching anything live, stop the
service, move the current database aside rather than overwriting it (a restore is
when you least want the previous state gone), copy in, delete stale `-wal`/`-shm`,
extract `uploads.tar.gz`, `chown -R tacoapp:tacoapp`, `chmod 0750`, run
`migrate`, start, and confirm `/healthz`. Print row counts before and after so
the operator sees what arrived.

### Ordering and gotchas the script must handle

- **Do not let the installer create an admin first.** On a fresh machine,
  `install.sh --email ...` sees an empty database and creates an account, then
  the restore overwrites that database and the account silently disappears. Either
  document installing without `--email`, or have `restore.sh` detect the
  situation and say so plainly.
- **Refuse a downgrade.** Compare `schema_migrations` in the backup against
  `server/db/migrations/`. If the backup contains a migration the code does not
  have, the backup is newer than the code: stop, do not "restore" it. Migrations
  only run forward.
- **Everyone will be signed out if the hostname changed.** Cookies are
  host-scoped and the name itself differs between transports (`id` versus
  `__Host-id`). Worth stating in the output so it is not read as a bug. Passwords
  are unaffected; the hashes travel with the database.
- **`BASE_URL` must match the new hostname** or the CSRF origin check rejects
  every form with "security token out of date". Re-run the installer to change it
  rather than hand-editing the env file.
- **Check for photo rows whose files did not arrive**, i.e. rows in `photos` with
  nothing matching in `uploads/`. The serving route already 404s gracefully, but
  the operator should be told the count rather than discovering it one broken
  image at a time. `findOrphanedUploads` covers the opposite direction; this is
  the mirror of it.
- **Finish with `PRAGMA foreign_key_check`.** Cheap, and it catches a truncated
  or mismatched restore immediately.

### Worth stating in the docs

Nothing outside `/var/lib/taco-analyzer` needs to be copied between machines.
There is no application secret to migrate: sessions and CSRF tokens are random
values stored in the database rather than signed payloads, and the env file is
regenerated by the installer. Data is the only precious thing, which is a
property worth keeping.

## 1. Admin edit, with an audit trail

Requested after real use. Surveys are currently write-once: submit and it is
final. That is a defensible default (it keeps collected data honest) but it has
no escape hatch for a typo noticed later, and the one-shot form makes typos
likely.

Wanted: an admin can edit a submitted survey, and the survey detail page shows a
history at the bottom of what changed, by whom, and when.

### Design notes for whoever builds it

**Do not mutate rows in place and log a message about it.** That gives a log that
can silently disagree with the data. Record the change as the source of truth:

```sql
CREATE TABLE survey_revisions (
  id          INTEGER PRIMARY KEY,
  survey_id   INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  changed_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  changed_at  TEXT    NOT NULL,
  reason      TEXT,            -- optional, prompt for it; it is the useful part
  field       TEXT    NOT NULL,-- 'business_name', 'item.0.price_cents',
                               -- 'metric.hunger', 'item.0.metric.tortilla'
  old_value   TEXT,
  new_value   TEXT
) STRICT;
```

One row per changed field, using the same field-name vocabulary as the form
(server/lib/validate.js header). That keeps the trail readable without a join to
interpret it, and it survives a rubric gaining metrics.

Specifics worth getting right:

- **Reuse the existing validator.** An edit must go through
  `validateSurveySubmission` exactly as a create does, or edits become the way
  invalid data gets in.
- **Write the revision rows and the update in one transaction.** A trail that can
  be missing entries is worse than no trail, because it will be trusted.
- **`changed_by` is ON DELETE RESTRICT** for the same reason `surveys.user_id`
  is: an audit trail that loses its author is not an audit trail.
- **Record only fields that actually changed.** Resubmitting a form unchanged
  should produce no revision rows at all.
- **Admins only**, and consider showing the trail to the survey's author too:
  someone should be able to see that their submission was edited.
- **Photos:** decide whether an edit can replace or remove one. If it can
  remove, the file needs deleting as well, and the trail should record that it
  happened without keeping the image. Note the app never deletes surveys today,
  so nothing currently cleans up photo files on deletion; if survey deletion is
  ever added, it must delete files too (SQLite's ON DELETE CASCADE removes the
  row, not the file on disk).
- **Delete is wanted too, but build it after edit, not alongside.** Edit plus
  trail is recoverable and delete is not, so getting the trail right first means
  delete can be recorded in it. See item 1a.

Presentation: a `.data-table` under the existing sections on the detail page,
newest first, reading like "Havell changed Menu price from $14.25 to $3.50 on
27 Jul 2026". Empty state when a survey has never been edited, so the absence of
a trail is explicit rather than ambiguous.

## 1a. Delete a survey, behind a real confirmation

Requested. An admin can delete a survey, with an "are you sure" step.

### Prefer a soft delete

Recommended: mark it deleted rather than removing the row. `surveys.status`
already has a CHECK constraint of `('draft', 'submitted')`, so this is adding
`'deleted'` (plus `deleted_at` and `deleted_by`) rather than a new concept.

Why soft first:

- A hard delete of a survey cascades away its items, responses, and photo rows,
  which is precisely the evidence the audit trail in item 1 exists to keep. A
  trail that says "this was deleted" but cannot say what it contained is barely
  a trail.
- Fat-finger recovery costs one UPDATE instead of a restore from backup.
- Every list, dashboard, and count query then needs a `status = 'submitted'`
  filter. Most already have one, but **audit them all**, because a missed filter
  is how a deleted survey reappears in the dashboard totals.

Offer a real purge separately (an admin action on an already-deleted survey, or
a retention sweep), so the irreversible step is its own deliberate decision.

### The confirmation

**Do not rely on `window.confirm` alone.** It is blocked outright in some
embedded and mobile browsers, and the `data-confirm` hook currently rendered on
the destructive admin buttons has no handler at all (see item 0b), so today it
would silently do nothing.

Make the server the gate:

- `POST /surveys/<id>/delete` renders a confirmation page showing exactly what
  will go: business name, town, visit date, item name, and the photo count.
- Deleting requires a second POST carrying a CSRF token from that page.
- For a survey with photos, or any survey once purge is implemented, require
  typing the business name to confirm. `deploy/uninstall.sh --purge` already uses
  that pattern for the same reason: a confirmation you can dismiss by reflex is
  not a confirmation.
- A client-side `confirm()` may be layered on top as a convenience, never as the
  control.

### Purging must delete the files too

**SQLite's `ON DELETE CASCADE` removes the photo rows, not the JPEGs on disk.**
A hard delete that forgets this leaks exactly the way failed submits used to.
Collect `storage_name` for the survey's photos *before* deleting rows, then call
`removeUpload()` from `server/db/pending-photos.js` for each. `prune-orphans`
will catch anything missed, but it should have nothing to catch.

Also note the FK trap found while cleaning up test data: the `sqlite3` CLI has
foreign keys **off** by default, so hand-written cleanup SQL orphans child rows
silently. The app enables them per connection. Any maintenance script must set
`PRAGMA foreign_keys=ON` and finish with `PRAGMA foreign_key_check`.

### Also

- Admin only. A collector deleting their own submission after the fact defeats
  the point of collected data.
- Record the deletion in the audit trail from item 1, including who and why.
- `users.id` is `ON DELETE RESTRICT` from `surveys`, so deleting a user still
  will not silently take their surveys with them. Keep it that way.

## 2. Surface photo GPS coordinates in the survey UI

**Status: half done.** Extraction is implemented; display is not.

The coordinates are already read out of the image's Exif block and stored on
`photos` (`gps_latitude`, `gps_longitude`, `gps_altitude_m`, `had_gps`,
`captured_at`, `camera_make`, `camera_model`). Extraction was deliberately NOT
deferred, because stripping Exif is irreversible: any photo collected before the
extractor existed could never have its coordinates recovered, and re-collecting
means physically revisiting the taco.

What is still to do is the reviewer-facing half:

- Show the coordinates on the survey detail page when `had_gps` is true.
- Compare the photo's coordinates against the typed state and town and flag a
  mismatch, so a reviewer can validate that a survey was really filled out where
  it claims. This is the actual point of the feature: a cross-check on
  self-reported location.
- Decide what "mismatch" means. Reverse geocoding needs either a network service
  (which a LAN box may not have, and which leaks collection locations to a third
  party) or a local dataset. A cheaper first version: show the coordinates as a
  map link and let a human judge, rather than automating the verdict.
- Show `captured_at` next to the survey's `visited_on` as a second cross-check.
  A photo taken three weeks before the claimed visit date is worth noticing.
- Decide whether coordinates should be visible to the collector who submitted the
  survey, or only to admins. Leaning admin-only: it is a validation signal about
  the collector's own submission.

Also unresolved: whether to record `had_gps = 0` prominently, since a collector
could disable location on purpose. Worth surfacing as "no location data" rather
than silently showing nothing.

---

## 3. Accept HEIC/HEIF uploads

**Status: currently rejected outright**, with a specific `HEIC_UNSUPPORTED`
error and a message pointing the user at their camera's format setting.

The original rationale leaned partly on "iOS converts HEIC to JPEG when uploading
through a file input." **That reasoning is weak here, because the primary user is
on Android**, where Samsung and Pixel devices can capture HEIC and the browser
will not necessarily convert it on upload. So real users may hit this rejection.

To accept HEIC properly we need to strip its metadata, which means parsing
ISOBMFF: locating the `meta` box, walking `iinf`/`iloc` to find the `Exif` item,
and removing it while fixing up the offsets that reference it. That is a real
parser, and a buggy one on untrusted input is worse than a rejection.

Options, cheapest first:

1. Keep rejecting, but confirm how often it actually happens on the user's own
   phone before spending effort. Possibly a non-issue in practice.
2. Convert client-side before upload: draw the image to a `<canvas>` and export
   JPEG via `toBlob`. This strips all metadata as a side effect (which would
   conflict with item 2 above unless GPS is read client-side first and posted
   alongside). Browser HEIC decode support is inconsistent, so this may not work
   at all on the devices that need it.
3. Write the ISOBMFF metadata stripper. Most correct, most work, needs careful
   fuzzing against malformed input.
4. Add a native image library (`sharp`) and re-encode everything, which also
   closes the decoder-exploit gap noted in docs/security-decisions.md. Costs the
   zero-native-dependency property that currently makes deployment trivial.

Decide based on whether the user's phone actually produces HEIC through the
browser's file picker.

---

## 4. Additional rubrics: business, non-taco items, combined surveys

Explicitly out of scope for v1, but the schema was built for it: a survey is a
container for one visit and can hold several `survey_items` with differing
`rubric_key`, and rubric answers are `(metric_key, value)` rows rather than
columns. Adding a rubric should be a new module in `server/rubrics/` registered
in `index.js`, with no migration.

When this is picked up, verify that assumption actually holds rather than
trusting this note. Likely friction points:

- `survey_items` has `item_name`, `price_cents`, `qty` as real columns. A
  business rubric would leave all three NULL, which works but is a hint that a
  third rubric might want fields these columns cannot express.
- The form renderer currently assumes one item per survey. Multi-item and
  multi-rubric surveys need the item loop to be dynamic, including on the client
  for adding an item without a page reload.
- `dashboardStats` averages the scored metrics of the default rubric. With two
  rubrics in play it needs to group by `rubric_key` or it will average
  incomparable things into one meaningless number.

---

## 5. The consistency modifier (rubric Layer 3)

The rubric defines a consistency modifier that activates on re-visit, worth up to
plus or minus 5 percent of the taste score, scaled by visit count. It is not
implemented, deliberately: the rubric itself says to lock the weighting once real
data exists rather than guessing up front.

The dashboard already counts `revisitedVenues`, so there is a signal for when
this becomes computable. Implement once there are venues with several visits.

Note the identity question this raises: repeat visits are currently matched on
`business_name` + `state` + `town` as strings. "Taco Truck" and "taco truck" and
"Taco Truck #2" will not group the way a human would expect. A real venue table
with explicit identity is probably a prerequisite.

---

## 6. Breached-password blocklist

A knowing gap, recorded in docs/security-decisions.md. NIST SP 800-63B requires
checking new passwords against a list of known-compromised ones. We currently
reject only a small bundled list of obvious choices plus anything containing the
user's own email or name, and lean on the 15-character minimum.

The two real options are the Pwned Passwords k-anonymity API (needs outbound
internet, and sends a hash prefix of your users' passwords to a third party) or
the offline database (tens of gigabytes). Revisit if this app ever holds anything
more sensitive than taco scores, or if it gains public sign-up.

---

## 7. Re-encode uploaded images

Also recorded in docs/security-decisions.md. OWASP recommends decoding and
re-encoding uploads, which destroys polyglot files and malformed-chunk decoder
exploits. We strip metadata in pure JavaScript instead, and compensate with
strict magic-byte identification, a `default-src 'none'` CSP, `nosniff`, serving
from a non-executable path, and a server-set content type.

Accepted residual risk: a crafted image targeting a browser decoder would pass
through. Worth closing if uploads are ever accepted from outside the team. This
overlaps with option 4 in item 3 above; doing both at once is the efficient path.

---

## 8. Multi-factor authentication

Not built. Its absence is why the password minimum is 15 characters rather than
8: NIST's shorter minimum applies only when a second factor is present. Adding
TOTP would let that minimum drop and would materially improve account security.
`node:crypto` can do TOTP without a dependency; the QR code for enrolment is the
only awkward part, and can be a plain secret string typed into an authenticator
app instead.
