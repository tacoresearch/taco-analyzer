# Deploying Taco Analyzer

An operator's runbook. Target is a **Debian 13 (trixie) LXC container** you can
SSH into as root.

The whole install is: clone the repo, run one script.

---

## Quick start

### LAN demo (private hostname, no public DNS)

```bash
apt-get update && apt-get install -y git
git clone https://github.com/tacoresearch/taco-analyzer.git /opt/taco-analyzer
cd /opt/taco-analyzer
bash deploy/install.sh --lan --hostname taco.lan
```

Then read [Installing the LAN root certificate](#installing-the-lan-root-certificate),
because until you do, every browser will show a certificate warning.

### Public hostname (real certificate)

Requires public DNS pointing at the box and inbound ports 80 and 443.

```bash
bash deploy/install.sh --public --hostname analyzer.tacoresearch.org --email you@example.org
```

### Plain HTTP (insecure, closed networks only)

```bash
bash deploy/install.sh --no-tls --hostname 192.168.1.50 --i-accept-insecure-http
```

**What you are accepting:** session cookies cannot carry the `Secure` flag over
plain HTTP, so login tokens cross the network in cleartext and anyone on that
network can read or replace them. The acknowledgement flag is mandatory so this
cannot happen by forgetting an option. Do not expose such an install to the
internet.

---

## Installer options

| Option | Meaning |
|---|---|
| `--lan` | HTTPS via Caddy's internal CA, for private names. You must distribute the root CA. |
| `--public` | HTTPS via Let's Encrypt. Needs public DNS and inbound 80/443. Requires `--email`. |
| `--no-tls` | Plain HTTP. Requires `--i-accept-insecure-http`. |
| `--hostname <name>` | Hostname clients use. Sets `BASE_URL` and the certificate name. |
| `--email <addr>` | Let's Encrypt contact, and the first admin's email if one is created. |
| `--port <n>` | Local port the app listens on. Default 8787. |
| `--force-os` | Proceed on something other than Debian 13. Package names and the Node path are Debian specific. |

Re-running with no TLS mode reuses whatever is already in the env file, which
makes it a safe repair command.

---

## What the installer actually does

1. Refuses to run as non-root, and refuses on non-Debian-13 without `--force-os`.
2. Installs `ca-certificates curl xz-utils gpgv git libstdc++6` and nothing else
   it does not need. It never runs `apt-get upgrade`.
3. **Installs Node.js 24.18.0 from the official tarball, with GPG signature
   verification**, into `/opt/nodejs` with a `current` symlink. It does *not* use
   Debian's `nodejs` package, which is 20.x: that line went end-of-life in April
   2026 and is below the SQLite driver's minimum. NodeSource is also avoided
   because Debian 13 replaced apt's OpenPGP verifier with `sqv`, which has broken
   third-party repositories twice in the past year.
4. Creates the `tacoapp` system user (nologin) and `/var/lib/taco-analyzer`
   at mode 0750.
5. Runs `npm ci --omit=dev`. **No compiler is needed:** `better-sqlite3` 13 ships
   prebuilt Node-API binaries and has no install script.
6. Writes `/etc/taco-analyzer/taco-analyzer.env` (mode 0640, root:tacoapp).
7. Installs and starts the systemd unit, then **verifies `/healthz` actually
   responds** rather than assuming a successful `systemctl start` means a healthy
   process.
8. Installs and configures Caddy for TLS, unless `--no-tls`.
9. Creates the first admin account **only if no accounts exist**, and prints the
   one-time password.

Everything is idempotent. Re-running is safe.

---

## The first sign-in

The installer prints something like:

```
  Email     you@example.org
  Password  K7M2X-9PQRT-4H8VN-3JWYC-6BFDG
```

That password is **shown once**, is stored only as a hash, and **expires 24 hours
after it was issued**. At first sign-in the app forces you to choose a new one
before you can reach any other page.

Password rules, which follow NIST SP 800-63B:

- **At least 15 characters.** This is the minimum for password-only login; the
  familiar 8 applies only when a second factor exists, and this app has none yet.
  A short phrase of a few words is easier to remember and stronger than a short
  jumble.
- No required character types. No forced periodic expiry. Both are things NIST
  explicitly says not to do.
- Paste and password managers work.

If you lose the password before using it, or it expires:

```bash
sudo /opt/taco-analyzer/deploy/taco-cli.sh reset-password --email you@example.org
```

---

## Creating more accounts

There is no self-signup. Accounts are provisioned.

**From the web UI:** sign in as an admin, go to **Users**, fill in email, name,
and role. The one-time password is displayed once. Read it to the person, or hand
it over on paper. Do not send it through the same channel as their email address.

**From the shell:**

```bash
sudo /opt/taco-analyzer/deploy/taco-cli.sh create-user   --email collector@example.org --name "Sam Collector" --role collector
```

`taco-cli.sh` runs the command as the service account with the service's own
environment. Do not call `npm run create-user` directly: without the env file
the app falls back to a `./data` directory relative to the working directory,
and instead of failing cleanly it tries to create a second, empty database
inside the repository.

Roles: `collector` sees and submits only their own surveys. `admin` additionally
sees everyone's surveys and manages users.

---

## Installing the LAN root certificate

Only for `--lan`. Caddy generates its own certificate authority; nothing trusts it
until you install the root certificate on each device. Its path:

```
/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
```

Copy it off the box:

```bash
scp root@<container-ip>:/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt .
```

**Android**

Android distinguishes user-installed CAs from system ones, and Chrome honours
user CAs for normal browsing.

1. Copy `root.crt` to the phone (email it to yourself, or use a USB cable).
2. Settings, then search for "certificate".
3. Choose **Encryption & credentials**, then **Install a certificate**, then
   **CA certificate**.
4. Accept the warning, pick the file.
5. Verify under **Trusted credentials**, **User** tab.

Exact wording varies by manufacturer. On Samsung it is Settings, Biometrics and
security, Other security settings, Install from device storage, CA certificate.

**Windows**

```powershell
Import-Certificate -FilePath root.crt -CertStoreLocation Cert:\LocalMachine\Root
```

Or double-click the file, Install Certificate, Local Machine, Place all
certificates in the following store, Trusted Root Certification Authorities.

**macOS**

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain root.crt
```

**iOS**

Mail the file to yourself, tap it, Settings will offer to install a profile.
Then, and this step is easy to miss, Settings, General, About, **Certificate
Trust Settings**, and switch the certificate on.

**Firefox** keeps its own trust store, so import there too: Settings, Privacy &
Security, Certificates, View Certificates, Authorities, Import.

### Making `taco.lan` resolve

The certificate name must match what you type in the browser. Options, easiest
first:

1. Add a DNS record on your router or local DNS server pointing `taco.lan` at the
   container.
2. Add it to each client's hosts file (`C:\Windows\System32\drivers\etc\hosts`,
   or `/etc/hosts`). Note Android does not have an editable hosts file without
   root, so this option does not work for phones.
3. Use a hostname ending in `.internal`, `.local`, or `.home.arpa`, or a bare IP
   address, for which Caddy applies its internal CA automatically.

---

## Day-to-day operations

```bash
systemctl status taco-analyzer          # is it running
journalctl -u taco-analyzer -f          # follow the log
journalctl -u taco-analyzer -n 100      # recent history
systemctl restart taco-analyzer
curl -s http://127.0.0.1:8787/healthz   # liveness
```

### Updating

```bash
cd /opt/taco-analyzer
sudo bash deploy/update.sh
```

Takes a backup, pulls, reinstalls dependencies, syntax-checks, stops the service,
migrates, restarts, and confirms health. It stops the service *before* migrating
so old code never sees a new schema, and it refuses to pull over uncommitted
local changes.

### Backups

```bash
sudo bash deploy/backup.sh                    # into /var/lib/taco-analyzer/backups
sudo bash deploy/backup.sh --out /mnt/backup --keep 30
```

**Do not back up this database with `cp`, `rsync`, or `tar`.** It runs in WAL
mode, so committed data can still be sitting in a separate `-wal` file. A plain
file copy of a live database can capture a torn state that looks fine until you
try to restore it. `backup.sh` uses SQLite's online backup, then runs
`PRAGMA integrity_check` on the result and fails if it does not come back `ok`.

A nightly cron entry:

```bash
echo '17 3 * * * root bash /opt/taco-analyzer/deploy/backup.sh --quiet' \
  > /etc/cron.d/taco-analyzer-backup
```

Copy backups off the box. A backup on the same container does not survive losing
the container.

### Restoring

```bash
systemctl stop taco-analyzer
cp /var/lib/taco-analyzer/backups/<STAMP>/taco.db /var/lib/taco-analyzer/taco.db
rm -f /var/lib/taco-analyzer/taco.db-wal /var/lib/taco-analyzer/taco.db-shm
tar -xzf /var/lib/taco-analyzer/backups/<STAMP>/uploads.tar.gz -C /var/lib/taco-analyzer
chown -R tacoapp:tacoapp /var/lib/taco-analyzer
systemctl start taco-analyzer
```

**Removing the stale `-wal` and `-shm` files is not optional.** Leaving them
beside a restored database can silently reintroduce exactly the data you rolled
back.

### Uninstalling

```bash
sudo bash deploy/uninstall.sh            # keeps your data
sudo bash deploy/uninstall.sh --purge    # deletes the database and photos
```

`--purge` requires typing a confirmation phrase.

---

## Moving from LAN to a public hostname

```bash
cd /opt/taco-analyzer
sudo bash deploy/install.sh --public --hostname analyzer.tacoresearch.org --email you@example.org
```

**Everyone will have to sign in again, and that is intentional.** Over HTTPS the
session cookie is named `__Host-id` and carries `Secure`; over plain HTTP it
cannot (a non-secure origin is not permitted to set a `Secure` cookie at all, and
the `__Host-` prefix requires one). Because the cookie *name* changes, every
cookie issued during the HTTP phase is orphaned at cutover rather than lingering
as a non-`Secure` downgrade target.

Before switching: confirm public DNS resolves to this box, and that inbound 80
and 443 reach it. Port 80 is needed both for the HTTP-01 challenge and the
redirect to HTTPS.

---

## Environment variables

Set in `/etc/taco-analyzer/taco-analyzer.env`. Restart after editing.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `production` | |
| `HOST` | `127.0.0.1` | `127.0.0.1` when proxied. `0.0.0.0` only for `--no-tls`. |
| `PORT` | `8787` | |
| `DATA_DIR` | `/var/lib/taco-analyzer` | Database, uploads, temp files. |
| `BASE_URL` | from `--hostname` | Used for the CSRF Origin check. Must match what clients type. |
| `COOKIE_SECURE` | `1` | `1` requires HTTPS. Defaults on, so insecure needs an explicit `0`. |
| `TRUST_PROXY` | `1` behind Caddy | Believes `X-Forwarded-For`. Only enable behind a proxy that overwrites it. |
| `EXTRA_ORIGINS` | empty | Extra allowed origins, comma separated, e.g. when both an IP and a hostname work. |
| `MAX_UPLOAD_BYTES` | `10485760` | 10 MB photo cap. |
| `LOG_SQL` | `0` | Logs every statement. Debugging only; noisy. |

`BASE_URL` matters more than it looks. It is the origin the CSRF check compares
against, so if clients reach the app by a name that is not listed there or in
`EXTRA_ORIGINS`, every form submission will be rejected.

---

## Troubleshooting

### Service fails with `243/CREDENTIALS`

The most-reported Debian 13 LXC problem. systemd 257's credential plumbing does
not work in unprivileged containers.

The installer detects this and applies an override automatically. If you hit it
manually, the clean fix is LXC's generator:

```bash
mkdir -p /etc/systemd/system-generators
curl -fsSLo /etc/systemd/system-generators/lxc \
  https://raw.githubusercontent.com/lxc/distrobuilder/main/targets/lxc.generator
chmod +x /etc/systemd/system-generators/lxc
systemctl daemon-reload && reboot
```

Alternatively enable nesting on the container (`features: nesting=1` on Proxmox),
though that grants more privilege than it needs.

### Service fails at `step NAMESPACE`

Mount-namespace hardening directives cannot always be applied inside LXC. The
installer detects this and writes
`/etc/systemd/system/taco-analyzer.service.d/10-lxc-relax.conf`, relaxing only the
mount-related directives and telling you which. The seccomp and capability
hardening (`NoNewPrivileges`, `CapabilityBoundingSet`, `SystemCallFilter`,
`RestrictAddressFamilies`) is never relaxed, because it does not need mount
namespacing.

Check what was relaxed:

```bash
cat /etc/systemd/system/taco-analyzer.service.d/10-lxc-relax.conf
```

### Service restarts in a loop with SIGTRAP

Someone added `MemoryDenyWriteExecute=yes` to the unit. **Do not set it.** V8
writes machine code into memory and then marks it executable, which is exactly
what that directive blocks, so Node dies instantly. Paired with
`Restart=on-failure` it becomes a silent restart loop. The unit file carries a
comment saying so.

### Every form submission is rejected as an invalid security token

`BASE_URL` does not match the origin the browser is using. If you reach the app
at `https://192.168.1.50` but `BASE_URL` says `https://taco.lan`, the CSRF Origin
check refuses the POST. Fix `BASE_URL`, or add the other origin to
`EXTRA_ORIGINS`, and restart.

### Nobody can log in, no error in the app log

Usually `COOKIE_SECURE=1` while serving over plain HTTP. A browser silently
discards a `Secure` cookie from a non-secure origin, so the session never sticks.
The app refuses to start on this combination, so if it is running you likely have
a proxy terminating TLS while the app thinks otherwise. Check `BASE_URL` and
`COOKIE_SECURE` agree with reality.

### Certificate warnings on the LAN

The root CA is not installed on that device, or the hostname does not match
`--hostname`. See [Installing the LAN root certificate](#installing-the-lan-root-certificate).
Firefox needs its own import.

### Caddy cannot bind port 80 or 443

In an unprivileged container this is usually AppArmor or capability related.
Check `journalctl -u caddy -n 50`. Caddy's packaged unit uses
`AmbientCapabilities=CAP_NET_BIND_SERVICE`, which normally works in LXC. Note
that `sysctl net.ipv4.ip_unprivileged_port_start` is **not** a reliable
workaround inside unprivileged containers.

### Photo uploads rejected

HEIC and HEIF are not accepted, only JPEG, PNG, and WebP. Some Android phones
(and iPhones) shoot HEIC by default. Turn it off in the camera app's settings,
usually a "HEIF" or "High efficiency" toggle. This is a known limitation and is
tracked in `docs/backlog.md`.

---

## Where things live

| Path | Contents |
|---|---|
| `/opt/taco-analyzer` | The cloned repository (or wherever you cloned it). |
| `/var/lib/taco-analyzer/taco.db` | The database. |
| `/var/lib/taco-analyzer/uploads/` | Uploaded photos. Never served statically. |
| `/var/lib/taco-analyzer/backups/` | Local backups. |
| `/etc/taco-analyzer/taco-analyzer.env` | Configuration. |
| `/etc/systemd/system/taco-analyzer.service` | The unit. |
| `/opt/nodejs/current` | Node.js. |
| `/etc/caddy/Caddyfile` | Reverse proxy and TLS. |

The data directory is mode 0700/0750 and owned by `tacoapp` on purpose: it holds
password hashes, session material, and photo location data.
