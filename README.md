# Taco Analyzer

A survey collection tool for scoring tacos against the
[TacoResearch rubric](TacoResearch_RubricV1.md). Mobile first, self-hosted, no
third-party services.

Collectors are given accounts by an administrator, fill out one survey per taco,
and a dashboard tracks what has been gathered.

## What it is

- **Rubric driven.** [`server/rubrics/taco_v1.js`](server/rubrics/taco_v1.js) is
  the single source of truth. The form, the server-side validation, the scoring,
  and the dashboard labels all read from it. Nothing about the rubric is
  hardcoded anywhere else, so adding a second rubric (business, non-taco items) is
  a sibling module rather than a rewrite.
- **Self-hosted and boring by design.** Node.js, SQLite, server-rendered HTML.
  No build step, no frontend framework, three runtime dependencies, none of them
  native. It runs on a small Debian container and does not phone anywhere.
- **Scores kept separate on purpose.** Taste is the six-metric average and
  nothing else touches it. Serving temperature and value are recorded beside it,
  never folded in. Hunger, mood, and distance from home describe the reviewer and
  never enter the score at all. That separation is the point of the rubric, so the
  app is built to preserve it rather than collapse it into one number.

## Deploying

See **[DEPLOY.md](DEPLOY.md)**. The short version, on a fresh Debian 13 container:

```bash
sudo -i
git clone <this repo> /opt/taco-analyzer
cd /opt/taco-analyzer
bash deploy/install.sh --lan --hostname taco.example.lan --email you@example.org
```

Pick a hostname that actually resolves on your network first; the installer does
not create DNS records, and a name nothing resolves will just look broken. A bare
IP works too. See [DEPLOY.md](DEPLOY.md).

That installs Node, dependencies, the database, a hardened systemd service, and
TLS, then prints a one-time password for the first admin account.

## Documentation

| File | What is in it |
|---|---|
| [DEPLOY.md](DEPLOY.md) | Operator runbook: install, TLS, certificates, backups, updates, troubleshooting. |
| [docs/security-decisions.md](docs/security-decisions.md) | Every security choice, its source, and every deviation with its residual risk. |
| [docs/backlog.md](docs/backlog.md) | Deferred work and known gaps, with enough context to act on. |
| [docs/ui-classes.md](docs/ui-classes.md) | The CSS class contract, required markup, and verified contrast ratios. |
| [TacoResearch_RubricV1.md](TacoResearch_RubricV1.md) | The rubric itself. |

## Layout

```
server/
  rubrics/      rubric definitions; taco_v1 is the only one so far
  db/           connection, migrations, survey persistence
  auth/         passwords, sessions, users, request guards
  security/     CSRF, rate limiting, response headers
  lib/          templating, validation, formatting, photo pipeline
  routes/       HTTP handlers
  views/        server-rendered pages
public/         styles.css and app.js, served as-is
deploy/         installer, systemd unit, Caddy examples, backup and update
scripts/        migrate, create-user, reset-password, syntax check
```

## Security posture

Worth knowing up front, with full reasoning in
[docs/security-decisions.md](docs/security-decisions.md):

- Argon2id where the runtime provides it, scrypt otherwise, probed at startup by
  actually hashing rather than trusting a version number. Hashes are
  self-describing and upgrade on next login.
- Password minimum is **15 characters**, which is NIST's floor without a second
  factor. No composition rules and no forced expiry, both of which NIST forbids.
- Sessions store only a hash of the token, with separate idle and absolute
  expiry, rotated on login and password change.
- Login is uniform in *time*, not just in wording: an unknown account still runs
  a full password verification against a dummy hash, so response latency cannot
  be used to enumerate accounts.
- Photo uploads are identified by magic bytes, never by filename or content type,
  and metadata is stripped before storage. GPS coordinates are extracted into the
  database first, so location can validate a survey while the served image
  carries none.
- TLS is the installer's default. Plain HTTP requires an explicit
  acknowledgement flag, because session cookies cannot be `Secure` without it.

Known gaps are listed honestly in [docs/backlog.md](docs/backlog.md) rather than
left implicit. The notable ones: no multi-factor authentication, no
breached-password blocklist, HEIC uploads rejected, and uploads are metadata
stripped rather than fully re-encoded.

## Status

**Deployed and verified** on a Debian 13 (trixie) unprivileged LXC container on
2026-07-27, from a clean `git clone` plus one command.

Verified working end to end: the installer (Node tarball with GPG signature
verification, dependencies with no compiler needed, hardened systemd unit, Caddy
serving HTTPS with its internal CA), sign-in with a one-time password, the forced
password change, survey submission, the dashboard, the survey list and detail
pages, admin user management, and sign-out. Argon2id was selected at runtime, so
the built-in `crypto.argon2` path is real rather than theoretical.

The rejections were confirmed too, which matters more than the happy path: a
forged CSRF token and a cross-origin POST both return 403, and a wrong password
returns exactly the same generic message as an unknown account.

`npm test` passes 42 photo-pipeline tests, and all 41 JavaScript files parse.

Still unverified, and tracked in [docs/backlog.md](docs/backlog.md): a real photo
upload from a phone (including GPS extraction from genuine camera EXIF), the
`--public` Let's Encrypt path, and the LXC hardening fallbacks, which never
triggered because the full systemd sandbox applied cleanly on this container.
