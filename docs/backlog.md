# Backlog

Deferred work, with enough context to act on it without reconstructing the
conversation that produced it. Ordered roughly by when it should be picked up.

---

## 1. Surface photo GPS coordinates in the survey UI

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

## 2. Accept HEIC/HEIF uploads

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
   conflict with item 1 above unless GPS is read client-side first and posted
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

## 3. Additional rubrics: business, non-taco items, combined surveys

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

## 4. The consistency modifier (rubric Layer 3)

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

## 5. Breached-password blocklist

A knowing gap, recorded in docs/security-decisions.md. NIST SP 800-63B requires
checking new passwords against a list of known-compromised ones. We currently
reject only a small bundled list of obvious choices plus anything containing the
user's own email or name, and lean on the 15-character minimum.

The two real options are the Pwned Passwords k-anonymity API (needs outbound
internet, and sends a hash prefix of your users' passwords to a third party) or
the offline database (tens of gigabytes). Revisit if this app ever holds anything
more sensitive than taco scores, or if it gains public sign-up.

---

## 6. Re-encode uploaded images

Also recorded in docs/security-decisions.md. OWASP recommends decoding and
re-encoding uploads, which destroys polyglot files and malformed-chunk decoder
exploits. We strip metadata in pure JavaScript instead, and compensate with
strict magic-byte identification, a `default-src 'none'` CSP, `nosniff`, serving
from a non-executable path, and a server-set content type.

Accepted residual risk: a crafted image targeting a browser decoder would pass
through. Worth closing if uploads are ever accepted from outside the team. This
overlaps with option 4 in item 2 above; doing both at once is the efficient path.

---

## 7. Multi-factor authentication

Not built. Its absence is why the password minimum is 15 characters rather than
8: NIST's shorter minimum applies only when a second factor is present. Adding
TOTP would let that minimum drop and would materially improve account security.
`node:crypto` can do TOTP without a dependency; the QR code for enrolment is the
only awkward part, and can be a plain secret string typed into an authenticator
app instead.
