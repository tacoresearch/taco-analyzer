# Security decisions

Why the auth and security layer is built the way it is, with the sources that
justify each choice. Recorded so a future change is a deliberate decision rather
than an accident, and so the deviations below are visible instead of buried.

Verified 2026-07-26 against OWASP Cheat Sheet Series, OWASP ASVS 5.0,
NIST SP 800-63B, and draft-ietf-httpbis-rfc6265bis-22.

## Password storage

**Argon2id when the runtime provides it, scrypt otherwise.** OWASP's order of
preference is Argon2id, then scrypt, then bcrypt (legacy only). Node 24.7.0
added `crypto.argon2`/`argon2Sync`, which makes OWASP's first choice available
with no native dependency. Because that API may still be marked experimental,
`server/auth/passwords.js` detects it at runtime and falls back to `node:crypto`
scrypt. Stored hashes are PHC strings that name their own algorithm and
parameters, so verification dispatches on what the row actually contains and an
account is transparently upgraded to the stronger algorithm the next time its
owner logs in.

- Argon2id: `m=19456 KiB, t=2, p=1, tagLength=32`, 16-byte nonce (OWASP minimum).
- scrypt: `N=2^15, r=8, p=3, keylen=32`, 16-byte salt (an OWASP-listed set).

**scrypt needs `maxmem` raised explicitly.** Node's default `maxmem` is 32 MiB
and it throws when `128 * N * r > maxmem`. Every OWASP-recommended scrypt setting
except the weakest exceeds that default, so the parameters above are inert
without also passing `maxmem`. This is a silent-failure trap worth naming.

**Hashing is capped by a semaphore.** Each scrypt hash at these parameters
allocates 32 MiB, and Node's scrypt is single-threaded per call. Unbounded
concurrent logins would let a handful of requests exhaust a small container's
memory, turning the password KDF into a denial-of-service vector against
ourselves. Concurrency is limited to 2, with additional attempts queueing.

**bcrypt is not used.** Its 72-byte input limit conflicts with accepting long
passphrases, working around that limit introduces null-byte truncation and
password-shucking risks, and its 4 KiB memory footprint is weak against GPUs.

## Password policy

NIST SP 800-63B SHALLs, applied as written:

- **Minimum 15 characters.** This is the single-factor minimum. The 8-character
  figure applies only with MFA, which v1 does not have.
- Maximum 256 characters (NIST wants at least 64 permitted; the cap exists only
  to bound KDF work).
- **No composition rules.** No required character classes. NIST SHALL NOT.
- **No periodic expiry.** NIST SHALL NOT. Rotation is forced only on evidence of
  compromise, which includes the admin-issued initial credential below.
- No password hints and no security questions. Both NIST SHALL NOT.
- Paste and password managers are permitted, and a show-password toggle is
  offered.
- The full password is verified, never a truncated prefix.

**Deviation: no breached-password blocklist.** NIST requires comparison against
a list of known-compromised passwords. The Pwned Passwords k-anonymity API needs
outbound internet, which a LAN box may not have and which sends a hash prefix of
our users' passwords to a third party; the offline database is tens of
gigabytes, which is disproportionate here. Instead we reject a bundled list of
the most common passwords and reject passwords containing the user's own email
local part or display name. **This is a knowing, documented gap.** The 15
character minimum is what carries most of the weight. Revisit if this app ever
holds anything more sensitive than taco scores.

## Sessions

- Token is 32 random bytes, base64url. 256 bits, against an OWASP floor of 64
  and an ASVS floor of 128.
- **Only the SHA-256 of the token is stored.** A leaked database file, backup, or
  stray `SELECT *` in a log then yields no usable session. Plain SHA-256 with no
  salt is correct here: the token already has 256 bits of entropy, so there is
  nothing to brute-force. Noted honestly: this is well-established practice with
  strong reasoning, not a citable OWASP mandate.
- Idle timeout 30 minutes, absolute timeout 12 hours (OWASP suggests 15 to 30
  minutes idle and 4 to 8 hours absolute; 12 hours covers a collection day and
  stays well inside NIST's AAL2 24-hour ceiling). `last_seen_at` is refreshed at
  most once a minute to avoid a database write on every request.
- The session identifier is **regenerated on login, on password change, and on
  any privilege change** (ASVS 7.2.4), old row deleted in the same transaction.
- Deactivating a user terminates all of that user's sessions (ASVS 7.4.2).
- Logout deletes the row server side and sends `Clear-Site-Data`.

## Session cookie

`HttpOnly`, `SameSite=Strict`, `Path=/`, and no `Domain` attribute.
`SameSite=Strict` is correct because the app has no cross-site entry point and
no OAuth redirect to receive.

**The cookie name changes with the transport, deliberately.** Over HTTPS the
cookie is `__Host-id` with `Secure`; over plain HTTP it is `id` without it. A
non-secure origin cannot set a `Secure` cookie at all (rfc6265bis 5.7 step 13),
and the `__Host-` prefix requires `Secure`, so the prefixed name is impossible
on a LAN over HTTP. Because the *name* differs, flipping to HTTPS orphans every
cookie issued during the HTTP phase. That is intended: it forces a fresh login
onto the secure cookie instead of leaving a non-`Secure` cookie around as a
downgrade target.

`COOKIE_SECURE` defaults to on. Running without TLS requires setting it off
explicitly, so an insecure deployment cannot happen by forgetting a flag.

**Plain HTTP on a LAN is low-assurance and is treated as such.** The session
token crosses the network in cleartext and an active attacker on that network
can read or overwrite it. The installer therefore sets up TLS by default.

## CSRF

**Synchronizer token, one per session.** OWASP calls SameSite "useful as a
defense-in-depth control" that "does not replace a proper CSRF defense," so a
token is still required in 2026. The synchronizer pattern is OWASP's recommended
option and costs one column on a session row we already have; signed
double-submit exists to avoid server-side state, which we are not short of. The
token is 32 random bytes, compared with `timingSafeEqual`, and rotated whenever
the session identifier rotates.

`Origin` is checked as a second layer. **`Sec-Fetch-*` headers are deliberately
not relied on:** the Fetch Metadata spec only sends them from trustworthy
origins, so they are absent entirely over LAN HTTP. `Origin` is sent on
same-origin form POSTs over plain HTTP and works in both phases.

**`Referrer-Policy` is `strict-origin-when-cross-origin`, never `no-referrer`.**
`no-referrer` can null out `Origin` on non-CORS requests, which would break the
`Origin` check above. This is the reason the app sets its headers explicitly
rather than accepting a middleware default.

**The CSRF field is emitted before the file input** in any upload form. A
streaming multipart parser reads parts in wire order, so a token that arrives
last cannot be checked until the whole upload has been spooled, which would let
an unauthorized request consume disk and bandwidth first. (Engineering rationale;
not an OWASP requirement.)

## Login throttling

- Per-account counter with a 15-minute decay window: no delay for the first
  three failures, then 1 second doubling to a 60-second cap, then a 15-minute
  lock at ten consecutive failures.
- Per-IP counter, 20 failures in 15 minutes, because a per-account counter cannot
  see credential spraying across many accounts.
- **At 100 lifetime failed attempts the account is disabled** and an admin must
  re-enable it. This is NIST SP 800-63B 3.2.2, the one hard number in this area.
  The specific thresholds above are a reasoned synthesis; OWASP declines to give
  numbers and warns that hard lockout can itself be abused to deny service.
- Lockout is cheap to recover from here because accounts are admin-provisioned
  and an unlock path already exists.

**Username enumeration is prevented in timing, not just in wording.** A generic
"Login failed" message is worthless if a missing account returns in 2 ms while a
real one takes 300 ms in the KDF. On a username miss the app verifies against a
dummy hash computed at boot with production parameters, applies the same delay
ladder, and returns a byte-identical response. The lock check happens *after*
verification for the same reason.

## Response headers

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self';
  img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none';
  form-action 'self'; base-uri 'none'; object-src 'none'
Referrer-Policy: strict-origin-when-cross-origin
X-Content-Type-Options: nosniff
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-site
Permissions-Policy: geolocation=(), camera=(), microphone=()
X-Frame-Options: DENY
X-XSS-Protection: 0
```

- `default-src 'none'` rather than `'self'`, so a directive we forgot fails
  closed instead of silently allowing.
- **No nonces are needed.** Every script and style is an external file, which is
  what makes bare `script-src 'self'` sufficient. The moment an inline script is
  introduced, the correct move is nonces, never `'unsafe-inline'`.
- `frame-ancestors` does not inherit from `default-src` and must be set.
- `img-src` includes `blob:` because the photo field previews a chosen file with
  `URL.createObjectURL` before upload.
- `X-XSS-Protection: 0` disables a legacy auditor that was itself an information
  leak. OWASP recommends explicitly turning it off.
- **HSTS is sent only when TLS is on.** Sending it during the HTTP phase would
  let any browser that once reached the app over HTTPS cache the pin and then
  refuse the plain-HTTP URL, with no user override. `preload` is not used.

## Photo uploads

Pipeline order matters, because each step is cheaper than the next:

1. Reject on `Content-Length` before reading a body, and cap the stream at
   10 MB regardless of what the header claimed.
2. Authenticate and verify CSRF before spooling bytes.
3. Spool to a temporary file outside any served directory, mode 0600, random name.
4. **Identify by magic bytes, never by `Content-Type` or file extension**, both
   of which are attacker-controlled.
5. Strip metadata (see below).
6. Store as a random UUID name. The client's filename is kept only as a display
   label and is never used as a path component.

**Uploads are served through an application route, never as static files.** The
directory is outside the static root so nothing in it can ever be
interpreter-mapped, the `Content-Type` is set from our own validated
identification rather than anything stored, and `nosniff` plus
`Content-Disposition` are sent. Authorization is enforced on the route: a random
UUID is obscurity, not access control.

**EXIF is stripped because phone photos carry GPS coordinates** precise to the
building, along with camera serial numbers and an embedded thumbnail that can
survive cropping. This is a privacy obligation, not hygiene.

**Coordinates are extracted into our own database before being stripped from the
file.** This is deliberate, and is not a weakening of the above: the image we
serve carries no location, while the coordinates live in the `photos` table, where
they let a reviewer cross-check the state and town a collector typed in against
where the photo was actually taken. Extraction happens in the same pass as
stripping because stripping is irreversible; a photo stored before the extractor
existed could never have its coordinates recovered, and re-collecting would mean
physically revisiting the taco.

The consequence worth stating plainly: the database now holds location traces of
the people doing the collecting, which makes it a more sensitive asset than a pile
of taco scores. That is part of why the data directory is mode 0700, why the
database is never served statically, and why how widely coordinates are shown in
the UI is an open question rather than a default (docs/backlog.md item 1).

**Deviation: metadata is stripped, not re-encoded.** OWASP recommends decoding
and re-encoding uploads, which destroys polyglots and malformed-chunk decoder
exploits as a side effect. Doing that requires an image library (`sharp`, a
native dependency). Instead the app parses the container and removes metadata
segments in pure JavaScript, and compensates with strict magic-byte
identification, a `default-src 'none'` CSP, `nosniff`, serving from a
non-executable path, and an explicit server-set content type. **Accepted
residual risk: a crafted image that exploits a browser decoder would pass
through.** Re-encoding is the recommended upgrade if this app ever accepts
uploads from people outside the team.

**Deviation: HEIC/HEIF is rejected.** Stripping metadata from HEIC safely needs a
real ISOBMFF parser (locating the `meta` box, walking `iinf`/`iloc` to the `Exif`
item, removing it, and fixing up every offset that referenced it). A buggy parser
on untrusted input is worse than a rejection, so accepting HEIC today would mean
either shipping users' GPS coordinates or shipping a parser we cannot fully
verify. Accepted formats are JPEG, PNG, and WebP.

**This deviation is weaker than it first looked, and is tracked in
docs/backlog.md.** An earlier version of this document justified it partly on
"iOS converts HEIC to JPEG when uploading through a file input." That argument
does not carry here: the primary user is on **Android**, where Samsung and Pixel
devices can capture HEIC and the browser will not necessarily convert it. So real
users may hit this rejection rather than it being a theoretical edge case. The
error message is written to be device-neutral and to point at the camera's format
setting on either platform. Revisit once we know whether the actual phone in use
produces HEIC through the browser's file picker.

## Admin-issued initial credentials

1. The **server** generates the initial secret with a CSPRNG. An admin never
   chooses it, so no guessable house pattern exists across accounts.
2. It is displayed exactly once and stored only as a hash, in the same format as
   a real password.
3. `must_change_password` is set, and every route except logout and the
   change-password page redirects there until a new password is chosen.
4. It expires 24 hours after issue (by analogy to NIST SP 800-63A's
   confirmation-code ceiling; no standard covers admin-issued initial passwords
   directly). An admin can reissue.
5. On change: the flag clears, the expiry clears, and **the session identifier
   rotates again**.

**Deviation: the initial secret is not invalidated on first use**, only on
password change or expiry. Strict single-use would brick an account if the user
lost their connection between logging in and submitting the new password,
requiring an admin round trip. Expiry plus the mandatory change gate covers the
same threat with a recoverable failure mode.

Never: an admin-chosen or pattern-derived password, storage in reversible form
"so it can be looked up," re-displaying it after the first view, or skipping the
change gate for an admin's own account.
