#!/usr/bin/env bash
#
# Taco Analyzer: one-command installer for a fresh Debian 13 (trixie) machine,
# including an unprivileged LXC container.
#
# Usage, after "git clone" as root:
#
#   cd /opt/taco-analyzer
#   ./deploy/install.sh --lan --hostname taco.lan
#
# What it does, in order:
#   1. Sanity checks (root, Debian 13, amd64, repo layout).
#   2. Installs a short list of apt packages. Never runs apt-get upgrade.
#   3. Installs Node.js 24.18.0 from the official tarball, GPG-verified and
#      SHA256-pinned, into /opt/nodejs with an atomic "current" symlink.
#   4. Creates the tacoapp system user, /var/lib/taco-analyzer and
#      /etc/taco-analyzer.
#   5. Installs production npm dependencies.
#   6. Writes /etc/taco-analyzer/taco-analyzer.env.
#   7. Installs and starts the hardened systemd unit, degrading the
#      mount-namespace hardening if (and only if) the container refuses it.
#   8. Runs database migrations.
#   9. Installs Caddy and a TLS reverse proxy, unless --no-tls.
#  10. Creates the first admin account if the database has no users.
#
# It is idempotent: re-running it on an installed machine is safe and is the
# supported way to change the hostname or TLS mode.
#
set -Eeuo pipefail

# --------------------------------------------------------------- constants --

APP_NAME="taco-analyzer"
APP_USER="tacoapp"
APP_GROUP="tacoapp"
DATA_DIR="/var/lib/taco-analyzer"
CONF_DIR="/etc/taco-analyzer"
ENV_FILE="${CONF_DIR}/taco-analyzer.env"
SERVICE_NAME="taco-analyzer.service"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}"
OVERRIDE_DIR="/etc/systemd/system/${SERVICE_NAME}.d"
CADDY_FILE="/etc/caddy/Caddyfile"
CADDY_ROOT_CA="/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt"

# Node.js 24.18.0 is Active LTS (EOL 2028-04-30). Debian 13's own nodejs package
# is 20.19.2, which is both end-of-life (2026-04-30) and below this app's
# engines floor of >=24.15.0, so it cannot be used.
#
# The official tarball is used rather than NodeSource because Debian 13 replaced
# gpg with sqv as apt's signature verifier, and sqv rejects SHA-1 key binding
# signatures. That has broken the NodeSource apt repository twice in the last
# eight months. This path depends on one HTTPS host and is cryptographically
# pinned two independent ways (see install_nodejs).
NODE_VER="v24.18.0"
NODE_TARBALL="node-${NODE_VER}-linux-x64.tar.xz"
NODE_SHA256="55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742"
NODE_BASE_URL="https://nodejs.org/dist/${NODE_VER}"
NODE_KEYRING_URL="https://github.com/nodejs/release-keys/raw/HEAD/gpg/pubring.kbx"
NODE_PREFIX="/opt/nodejs"
NODE_DIR="${NODE_PREFIX}/node-${NODE_VER}-linux-x64"
NODE_BIN="/usr/local/bin/node"

# Resolve the repository root from this script's own location, so the installer
# works from wherever the clone happens to live. /opt/taco-analyzer is the
# canonical spot but nothing depends on it.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="${REPO_ROOT}/deploy"

# ----------------------------------------------------------------- options --

TLS_MODE=""          # lan | public | none
HOSTNAME_ARG=""
EMAIL_ARG=""
PORT="8787"
FORCE_OS="no"
ACCEPT_INSECURE="no"
CREATED_PASSWORD=""
CREATED_EMAIL=""
RELAXED_STAGE="0"
# Absolute path to runuser or su, resolved on first use by detect_app_runner.
APP_RUNNER=""
APP_RUNNER_KIND=""

# ------------------------------------------------------------------ output --

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_RED=$'\033[31m'
  C_YELLOW=$'\033[33m'; C_GREEN=$'\033[32m'; C_BLUE=$'\033[34m'
else
  C_RESET=""; C_BOLD=""; C_RED=""; C_YELLOW=""; C_GREEN=""; C_BLUE=""
fi

log()  { printf '%s==>%s %s\n' "${C_BLUE}${C_BOLD}" "${C_RESET}" "$*"; }
ok()   { printf '%s  ok%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
warn() { printf '%swarn%s %s\n' "${C_YELLOW}${C_BOLD}" "${C_RESET}" "$*" >&2; }
die()  { printf '%serror%s %s\n' "${C_RED}${C_BOLD}" "${C_RESET}" "$*" >&2; exit 1; }

rule() { printf '%s\n' "--------------------------------------------------------------------------"; }

on_error() {
  local code=$? line="$1"
  printf '\n%s================ INSTALL FAILED ================%s\n' "${C_RED}${C_BOLD}" "${C_RESET}" >&2
  printf 'Failed at %s line %s (exit status %s).\n' "${BASH_SOURCE[0]}" "$line" "$code" >&2
  printf '\nUseful next steps:\n' >&2
  printf '  systemctl status %s\n' "$SERVICE_NAME" >&2
  printf '  journalctl -u %s -n 100 --no-pager\n' "$SERVICE_NAME" >&2
  printf '  journalctl -u caddy -n 50 --no-pager\n' >&2
  printf '\nThis installer is idempotent: fix the cause and run it again.\n' >&2
  exit "$code"
}
trap 'on_error "$LINENO"' ERR

WORK_DIR=""
cleanup() { [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]] && rm -rf "$WORK_DIR"; return 0; }
trap cleanup EXIT

usage() {
  cat <<'EOF'
Taco Analyzer installer (Debian 13)

  ./deploy/install.sh [options]

TLS mode (pick exactly one; TLS is the default and plain HTTP must be opted into):

  --lan                  Serve HTTPS with Caddy's internal CA. For private names
                         such as taco.lan on a network with no public DNS. You
                         must install the generated root CA on every client
                         device (see DEPLOY.md) or browsers will warn.
  --public               Serve HTTPS with a real Let's Encrypt certificate.
                         Requires public DNS pointing here plus inbound 80/443.
                         Requires --email.
  --no-tls               Plain HTTP, no proxy. INSECURE. Also requires
                         --i-accept-insecure-http.

Options:

  --hostname <name>      Hostname clients will use. Sets BASE_URL and the TLS
                         certificate name. Required for --lan and --public.
  --email <addr>         Let's Encrypt account/expiry address. Also used as the
                         email of the first admin account if one is created.
  --port <n>             Local port the app listens on (default 8787).
  --i-accept-insecure-http
                         Required acknowledgement for --no-tls.
  --force-os             Proceed on a non-Debian-13 system. Package names and
                         the Node install path are Debian specific; you are on
                         your own.
  --help                 Show this text.

Examples:

  ./deploy/install.sh --lan --hostname taco.lan
  ./deploy/install.sh --public --hostname taco.example.org --email ops@example.org
  ./deploy/install.sh --lan --hostname taco.lan --port 9000

Re-running with no TLS mode reuses the settings already in
/etc/taco-analyzer/taco-analyzer.env, which makes it a safe "repair" command.
EOF
}

# ------------------------------------------------------------ arg handling --

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --lan)      TLS_MODE="lan"; shift ;;
      --public)   TLS_MODE="public"; shift ;;
      --no-tls)   TLS_MODE="none"; shift ;;
      --hostname) [[ $# -ge 2 ]] || die "--hostname needs a value"; HOSTNAME_ARG="$2"; shift 2 ;;
      --email)    [[ $# -ge 2 ]] || die "--email needs a value"; EMAIL_ARG="$2"; shift 2 ;;
      --port)     [[ $# -ge 2 ]] || die "--port needs a value"; PORT="$2"; shift 2 ;;
      --i-accept-insecure-http) ACCEPT_INSECURE="yes"; shift ;;
      --force-os) FORCE_OS="yes"; shift ;;
      --help|-h)  usage; exit 0 ;;
      *)          usage >&2; printf '\n' >&2; die "unknown option: $1" ;;
    esac
  done
}

validate_options() {
  if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
    die "--port must be a number between 1 and 65535, got '${PORT}'"
  fi
  if (( PORT < 1024 )); then
    die "--port ${PORT} is privileged. The service runs with an empty capability set and cannot bind it. Pick a port above 1023."
  fi

  # No TLS mode given: reuse what is already configured, so a bare re-run
  # repairs an install instead of demanding the original flags again.
  if [[ -z "$TLS_MODE" ]]; then
    if [[ -f "$ENV_FILE" ]]; then
      local base secure
      base="$(env_value BASE_URL)"
      secure="$(env_value COOKIE_SECURE)"
      [[ -n "$(env_value PORT)" ]] && PORT="$(env_value PORT)"
      if [[ -z "$HOSTNAME_ARG" && -n "$base" ]]; then
        HOSTNAME_ARG="${base#*://}"
        HOSTNAME_ARG="${HOSTNAME_ARG%%[:/]*}"
      fi
      if [[ "$base" == https://* ]]; then
        if grep -qs 'taco-analyzer-managed' "$CADDY_FILE" && grep -qs 'tls internal' "$CADDY_FILE"; then
          TLS_MODE="lan"
        else
          TLS_MODE="public"
          [[ -z "$EMAIL_ARG" ]] && EMAIL_ARG="$(sed -n 's/^[[:space:]]*email[[:space:]]\+//p' "$CADDY_FILE" 2>/dev/null | head -n1)"
        fi
      else
        TLS_MODE="none"
        ACCEPT_INSECURE="yes"   # already acknowledged at first install
        [[ "$secure" == "1" ]] && TLS_MODE="lan"
      fi
      log "Reusing existing configuration from ${ENV_FILE} (mode: ${TLS_MODE}, host: ${HOSTNAME_ARG:-unset})."
    else
      usage >&2
      printf '\n' >&2
      die "pick a TLS mode: --lan, --public, or --no-tls"
    fi
  fi

  case "$TLS_MODE" in
    lan|public)
      [[ -n "$HOSTNAME_ARG" ]] || die "--hostname is required with --${TLS_MODE}"
      ;;
    none)
      if [[ "$ACCEPT_INSECURE" != "yes" ]]; then
        rule
        printf '%s REFUSING TO INSTALL WITHOUT TLS %s\n' "${C_RED}${C_BOLD}" "${C_RESET}"
        rule
        cat >&2 <<'EOF'
--no-tls serves the app over plain HTTP with no proxy in front. That means:

  * Session cookies travel in CLEARTEXT. Anyone on the same network (a shared
    office LAN, a guest VLAN, any Wi-Fi) can read a logged-in user's session
    token off the wire and become that user. They can also modify pages in
    flight.
  * Passwords are submitted in cleartext on the login form.
  * The app must be configured with COOKIE_SECURE=0, which drops the Secure
    attribute and the __Host- cookie prefix, removing two independent
    protections against cookie injection and downgrade.
  * Uploaded photos, which may include people and places, are readable in
    transit.

This is acceptable ONLY for a throwaway demo on a network you fully control.

If you have any hostname at all, prefer:   --lan --hostname <name>
That gets you real TLS in about ten seconds with Caddy's internal CA.

To proceed anyway, re-run with --i-accept-insecure-http
EOF
        exit 1
      fi
      warn "Installing WITHOUT TLS. Session tokens will travel in cleartext."
      if [[ -z "$HOSTNAME_ARG" ]]; then
        HOSTNAME_ARG="$(hostname -f 2>/dev/null || true)"
        [[ -n "$HOSTNAME_ARG" ]] || HOSTNAME_ARG="$(hostname -I 2>/dev/null | cut -d' ' -f1)"
        [[ -n "$HOSTNAME_ARG" ]] || HOSTNAME_ARG="localhost"
        warn "No --hostname given; using '${HOSTNAME_ARG}' for BASE_URL."
      fi
      ;;
    *) die "internal error: bad TLS mode '${TLS_MODE}'" ;;
  esac

  if [[ ! "$HOSTNAME_ARG" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
    die "--hostname '${HOSTNAME_ARG}' does not look like a hostname or IP address"
  fi

  if [[ "$TLS_MODE" == "public" ]]; then
    [[ -n "$EMAIL_ARG" ]] || die "--public requires --email <addr> for the Let's Encrypt account"
    [[ "$EMAIL_ARG" == ?*@?*.?* ]] || die "--email '${EMAIL_ARG}' does not look like an email address"
    case "$HOSTNAME_ARG" in
      *.lan|*.local|*.internal|*.home.arpa|localhost)
        die "'${HOSTNAME_ARG}' is a private name. A public CA cannot issue for it. Use --lan instead." ;;
    esac
    [[ "$HOSTNAME_ARG" == *.* ]] || die "--public needs a fully qualified domain name, got '${HOSTNAME_ARG}'"
    if [[ "$HOSTNAME_ARG" =~ ^[0-9.]+$ ]]; then
      die "--public cannot be used with an IP address. Let's Encrypt does not issue IP certificates."
    fi
  fi

  if [[ "$TLS_MODE" == "lan" ]] && [[ "$HOSTNAME_ARG" =~ ^[0-9.]+$ ]]; then
    warn "Using a bare IP address (${HOSTNAME_ARG}). Caddy will issue an internal-CA certificate for it, which works, but the address must never change or every client breaks. A name in /etc/hosts or local DNS is better."
  fi
}

# Read one KEY's value out of the env file, empty string if absent.
env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || { printf ''; return 0; }
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n1
}

# ------------------------------------------------------------ preflight ----

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    die "this installer must run as root. Try:  sudo ./deploy/install.sh $*
(A fresh Debian 13 LXC container normally gives you a root shell already.)"
  fi
}

check_os() {
  local id="" version_id="" pretty=""
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    id="$(. /etc/os-release && printf '%s' "${ID:-}")"
    version_id="$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")"
    pretty="$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-unknown}")"
  fi
  if [[ "$id" == "debian" && "$version_id" == "13" ]]; then
    ok "Debian 13 detected (${pretty})."
    return 0
  fi
  if [[ "$FORCE_OS" == "yes" ]]; then
    warn "Expected Debian 13, found '${pretty}'. Continuing because --force-os was given. Package names and paths may be wrong."
    return 0
  fi
  die "this installer targets Debian 13 (trixie); found '${pretty:-unknown}'.
The Node.js install path, apt package names, and the systemd/LXC workarounds are
Debian 13 specific. Re-run with --force-os if you know what you are doing."
}

check_arch() {
  local arch
  arch="$(uname -m)"
  if [[ "$arch" != "x86_64" ]]; then
    die "this installer downloads the linux-x64 Node.js build; this machine is '${arch}'.
better-sqlite3's bundled prebuild is also linux-x64 here. Adapt NODE_TARBALL and
expect to build native modules from source."
  fi
}

check_repo() {
  local missing=()
  [[ -f "${REPO_ROOT}/package.json" ]] || missing+=("package.json")
  [[ -d "${REPO_ROOT}/server" ]] || missing+=("server/")
  [[ -f "${DEPLOY_DIR}/${SERVICE_NAME}" ]] || missing+=("deploy/${SERVICE_NAME}")
  if (( ${#missing[@]} > 0 )); then
    die "this does not look like a Taco Analyzer checkout (missing: ${missing[*]}).
Detected repository root: ${REPO_ROOT}
Run the script from inside the clone, for example:  /opt/${APP_NAME}/deploy/install.sh"
  fi
  ok "Repository root: ${REPO_ROOT}"
  if [[ "$REPO_ROOT" != "/opt/${APP_NAME}" ]]; then
    warn "Canonical location is /opt/${APP_NAME}; installing in place from ${REPO_ROOT} instead. That is supported, the path just gets baked into the systemd unit."
  fi
}

# -------------------------------------------------------------- apt setup --

apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
}

install_base_packages() {
  log "Installing base packages (apt-get update, then a targeted install; never apt-get upgrade)."
  DEBIAN_FRONTEND=noninteractive apt-get update
  # ca-certificates curl xz-utils gpgv: fetch and verify the Node tarball.
  # gnupg: needed for "gpg --dearmor" when adding the Caddy repository key.
  # libstdc++6: better-sqlite3's Node-API prebuild links libstdc++ (needs
  #   GLIBCXX_3.4.29). Present on a normal install, sometimes absent from a
  #   minimal LXC rootfs, and the failure mode is a confusing dlopen error.
  # sqlite3: the .backup command used by deploy/backup.sh.
  # git: needed by deploy/update.sh.
  apt_install ca-certificates curl xz-utils gpgv gnupg tar libstdc++6 git sqlite3 iproute2
  ok "Base packages present."
}

# ------------------------------------------------------------- node.js -----

install_nodejs() {
  if [[ -x "${NODE_DIR}/bin/node" ]]; then
    ok "Node.js ${NODE_VER} already unpacked at ${NODE_DIR}."
  else
    log "Installing Node.js ${NODE_VER} from the official tarball."
    WORK_DIR="$(mktemp -d)"
    (
      cd "$WORK_DIR"
      curl -fsSLO "${NODE_BASE_URL}/${NODE_TARBALL}"
      curl -fsSLO "${NODE_BASE_URL}/SHASUMS256.txt.asc"
      curl -fsSLo "${WORK_DIR}/nodejs-keyring.kbx" "$NODE_KEYRING_URL"

      # Check 1: the release team's signature over the checksum file.
      gpgv --keyring="${WORK_DIR}/nodejs-keyring.kbx" \
           --output SHASUMS256.txt < SHASUMS256.txt.asc
      sha256sum --check --ignore-missing SHASUMS256.txt

      # Check 2: belt and braces against the hash recorded in this script.
      #
      # Check 1 alone trusts the keyring we just downloaded from GitHub. If that
      # fetch were the thing that got compromised (hostile keyring plus hostile
      # SHASUMS256.txt.asc), it would happily validate a hostile tarball. The
      # literal hash below was recorded out of band when this script was written
      # and reviewed, so an attacker would have to have compromised the source
      # tree as well. Both checks must pass.
      printf '%s  %s\n' "$NODE_SHA256" "$NODE_TARBALL" | sha256sum --check --strict
    ) || die "Node.js verification failed. Nothing was installed.
Either the download was corrupted, or ${NODE_BASE_URL}/${NODE_TARBALL} no longer
matches the SHA256 pinned in this script (NODE_SHA256). Do not work around this
by deleting the check: confirm the expected hash at ${NODE_BASE_URL}/SHASUMS256.txt
and update the script deliberately."
    ok "Tarball verified (release GPG signature and pinned SHA256)."

    mkdir -p "$NODE_PREFIX"
    # Unpack beside any existing version rather than over it, so a failed
    # extraction cannot leave a half-replaced runtime in place.
    tar -xJf "${WORK_DIR}/${NODE_TARBALL}" -C "$NODE_PREFIX"
    [[ -x "${NODE_DIR}/bin/node" ]] || die "unpacked tarball does not contain ${NODE_DIR}/bin/node"
  fi

  # The "current" symlink is what makes upgrades atomic: one rename swaps the
  # whole runtime, and /usr/local/bin never points at a partially written tree.
  ln -sfn "$NODE_DIR" "${NODE_PREFIX}/current"
  local binary
  for binary in node npm npx corepack; do
    if [[ -e "${NODE_PREFIX}/current/bin/${binary}" ]]; then
      ln -sfn "${NODE_PREFIX}/current/bin/${binary}" "/usr/local/bin/${binary}"
    fi
  done

  hash -r 2>/dev/null || true
  local actual
  actual="$("$NODE_BIN" --version)"
  [[ "$actual" == "$NODE_VER" ]] || die "expected node ${NODE_VER} on PATH, got ${actual}"
  ok "node ${actual} at ${NODE_BIN} (npm $(npm --version))."
}

# ------------------------------------------------- user, dirs, ownership ---

create_user_and_dirs() {
  if ! getent group "$APP_GROUP" >/dev/null; then
    groupadd --system "$APP_GROUP"
    ok "Created group ${APP_GROUP}."
  fi
  if ! id -u "$APP_USER" >/dev/null 2>&1; then
    # HOME is the state directory: Node and npm insist on a writable HOME, and a
    # system user's conventional /nonexistent breaks them in obscure ways.
    useradd --system --gid "$APP_GROUP" \
            --home-dir "$DATA_DIR" --no-create-home \
            --shell /usr/sbin/nologin \
            --comment "Taco Analyzer service account" \
            "$APP_USER"
    ok "Created system user ${APP_USER} (nologin)."
  else
    ok "System user ${APP_USER} already exists."
  fi

  install -d -m 0750 -o "$APP_USER" -g "$APP_GROUP" "$DATA_DIR"
  install -d -m 0700 -o "$APP_USER" -g "$APP_GROUP" "${DATA_DIR}/uploads"
  install -d -m 0700 -o "$APP_USER" -g "$APP_GROUP" "${DATA_DIR}/tmp"
  install -d -m 0750 -o root -g "$APP_GROUP" "$CONF_DIR"
  ok "Data directory ${DATA_DIR} (0750 ${APP_USER}:${APP_GROUP})."
}

set_code_ownership() {
  # The application code is owned by root and is only READABLE by the service
  # account. A compromised app process must not be able to rewrite its own
  # source, its dependencies, or this installer.
  log "Setting ownership on the application directory."
  chown -R "root:${APP_GROUP}" "$REPO_ROOT"
  chmod 0750 "$REPO_ROOT"
  find "$REPO_ROOT" -type d -exec chmod u=rwx,g=rx,o= {} +
  find "$REPO_ROOT" -type f -exec chmod u=rw,g=r,o= {} +
  find "${DEPLOY_DIR}" -name '*.sh' -type f -exec chmod u=rwx,g=rx,o= {} +
  ok "Code owned by root:${APP_GROUP}, not writable by the service account."
}

# ------------------------------------------------------------ npm install --

install_dependencies() {
  log "Installing production npm dependencies."
  local flags=(--omit=dev --no-audit --no-fund --loglevel=warn)
  local installer=(npm ci)
  if [[ ! -f "${REPO_ROOT}/package-lock.json" ]]; then
    warn "No package-lock.json in the repository, so 'npm ci' cannot be used and dependency versions are resolved fresh at install time. That means two installs on different days can get different transitive dependencies. Commit a lockfile."
    installer=(npm install)
  fi

  # --ignore-scripts is a real hardening win: it stops any dependency (direct or
  # transitive) from executing arbitrary code as root at install time. It works
  # here because none of this app's dependencies need a build step:
  # better-sqlite3 13.x is Node-API based and ships prebuilds/linux-x64.node in
  # its npm tarball with no install script, and hono is pure JavaScript.
  # If that ever stops being true the fallback below handles it.
  if ! ( cd "$REPO_ROOT" && HOME=/root NPM_CONFIG_UPDATE_NOTIFIER=false \
         "${installer[@]}" "${flags[@]}" --ignore-scripts ); then
    warn "Dependency install failed with --ignore-scripts. Retrying with a compiler toolchain available, in case a dependency now needs to build from source."
    apt_install build-essential python3 pkg-config
    ( cd "$REPO_ROOT" && HOME=/root NPM_CONFIG_UPDATE_NOTIFIER=false \
      "${installer[@]}" "${flags[@]}" ) \
      || die "npm dependency install failed. Read the output above; a network problem and a native build failure look quite different."
  fi

  # Fail here, with a clear message, rather than in a systemd restart loop.
  if ! ( cd "$REPO_ROOT" && "$NODE_BIN" -e 'require("better-sqlite3")' ); then
    die "better-sqlite3 installed but will not load.
If the error above mentions GLIBCXX or libstdc++, install it:
    apt-get install -y --no-install-recommends libstdc++6
The bundled prebuild needs glibc >= 2.34 and GLIBCXX_3.4.29; Debian 13 ships
glibc 2.41, so this is normally only seen on a very minimal container rootfs."
  fi
  ok "Dependencies installed and better-sqlite3 loads."
  chown -R "root:${APP_GROUP}" "${REPO_ROOT}/node_modules"
}

# --------------------------------------------------------- env file -------

write_env_file() {
  log "Writing ${ENV_FILE}."
  local base_url host trust_proxy cookie_secure
  if [[ "$TLS_MODE" == "none" ]]; then
    base_url="http://${HOSTNAME_ARG}:${PORT}"
    # No proxy in front, so the app itself must be reachable from the network.
    host="0.0.0.0"
    trust_proxy="0"
    cookie_secure="0"
  else
    base_url="https://${HOSTNAME_ARG}"
    # Caddy terminates TLS and proxies to loopback. Binding loopback only means
    # the app cannot be reached over plain HTTP even by accident.
    host="127.0.0.1"
    trust_proxy="1"
    cookie_secure="1"
  fi

  local tmp
  tmp="$(mktemp "${CONF_DIR}/.env.XXXXXX")"
  cat >"$tmp" <<EOF
# Taco Analyzer configuration.
# Generated by deploy/install.sh on $(date -u '+%Y-%m-%dT%H:%M:%SZ').
#
# Read by systemd via EnvironmentFile=, so this is a plain KEY=VALUE file:
# no shell quoting, no variable expansion, no inline comments after a value.
# After editing:  systemctl restart ${SERVICE_NAME}
#
# See DEPLOY.md for what each variable does.

NODE_ENV=production

# Listen address. 127.0.0.1 whenever a reverse proxy is in front, which is the
# only thing stopping a browser from reaching the app over plain HTTP directly.
HOST=${host}
PORT=${PORT}

DATA_DIR=${DATA_DIR}

# Public origin. Used for absolute links and for the CSRF Origin check, so it
# must match what users actually type.
BASE_URL=${base_url}

# 1 sets Secure and the __Host- cookie prefix. Turning this off is only valid
# without TLS, and the app refuses the contradictory combination at boot.
COOKIE_SECURE=${cookie_secure}

# Believe X-Forwarded-For. Only safe because the Caddyfile OVERWRITES that
# header rather than appending to it; otherwise clients could forge their
# address and evade per-IP login throttling.
TRUST_PROXY=${trust_proxy}

# Extra origins the app may legitimately be reached on, comma separated.
# Example: EXTRA_ORIGINS=https://taco.lan,https://192.168.1.50
EXTRA_ORIGINS=

# 10 MiB. Keep the Caddyfile's request_body max_size at or above this.
MAX_UPLOAD_BYTES=10485760

# Log every SQL statement. Debugging only: it is noisy and puts query text in
# the journal.
LOG_SQL=0
EOF

  if [[ -f "$ENV_FILE" ]] && ! diff -q \
      <(grep -v '^# Generated by' "$ENV_FILE") \
      <(grep -v '^# Generated by' "$tmp") >/dev/null 2>&1; then
    local backup="${ENV_FILE}.$(date -u '+%Y%m%dT%H%M%SZ').bak"
    cp -a "$ENV_FILE" "$backup"
    chmod 0600 "$backup"
    warn "Configuration changed. Previous version saved as ${backup}."
  fi

  # 0640 root:tacoapp. The service reads it; nothing else on the box can.
  chown "root:${APP_GROUP}" "$tmp"
  chmod 0640 "$tmp"
  mv -f "$tmp" "$ENV_FILE"
  ok "Configuration written (BASE_URL=${base_url}, HOST=${host}, PORT=${PORT})."
}

# --------------------------------------------------------- systemd unit ---

install_unit() {
  log "Installing the systemd unit."
  local tmp
  tmp="$(mktemp)"
  sed "s|__APP_DIR__|${REPO_ROOT}|g" "${DEPLOY_DIR}/${SERVICE_NAME}" >"$tmp"
  if ! grep -q "ExecStart=${NODE_BIN} ${REPO_ROOT}/server/index.js" "$tmp"; then
    rm -f "$tmp"
    die "rendered unit does not contain the expected ExecStart line; deploy/${SERVICE_NAME} may have been edited incompatibly"
  fi
  install -m 0644 -o root -g root "$tmp" "$SERVICE_FILE"
  rm -f "$tmp"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null
  ok "Unit installed and enabled at boot."
}

detect_app_runner() {
  # Resolve the privilege-dropping tool ONCE, as an absolute path.
  #
  # This has to happen before run_as_app narrows PATH for the child: runuser
  # lives in /usr/sbin, which that narrowed PATH deliberately excludes, so
  # calling it by bare name there fails with "command not found". Resolving it
  # here keeps the narrow PATH for the application while still finding the tool.
  local candidate
  for candidate in /usr/sbin/runuser /sbin/runuser; do
    if [[ -x "$candidate" ]]; then
      APP_RUNNER="$candidate"
      APP_RUNNER_KIND="runuser"
      return 0
    fi
  done
  candidate="$(command -v runuser 2>/dev/null || true)"
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    APP_RUNNER="$candidate"
    APP_RUNNER_KIND="runuser"
    return 0
  fi

  # su is the fallback for images that ship a trimmed util-linux.
  for candidate in /bin/su /usr/bin/su; do
    if [[ -x "$candidate" ]]; then
      APP_RUNNER="$candidate"
      APP_RUNNER_KIND="su"
      return 0
    fi
  done

  die "Neither runuser nor su was found, so privileges cannot be dropped to ${APP_USER}."
}

run_as_app() {
  # Run a command as the service account with the service's own environment, so
  # migrations and user creation see exactly what the running app sees.
  [[ -n "$APP_RUNNER" ]] || detect_app_runner
  (
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
    export HOME="$DATA_DIR"
    export NPM_CONFIG_UPDATE_NOTIFIER=false
    export PATH="/usr/local/bin:/usr/bin:/bin"
    cd "$REPO_ROOT"
    # Preserving the environment is required either way: without it the tool
    # resets HOME to the account's home directory, and npm cannot run without a
    # writable HOME (the service account's is /nonexistent).
    if [[ "$APP_RUNNER_KIND" == "runuser" ]]; then
      "$APP_RUNNER" --preserve-environment -u "$APP_USER" -- "$@"
    else
      # su takes a single command string rather than an argument vector, so each
      # argument is quoted individually to survive the extra shell parse.
      "$APP_RUNNER" --preserve-environment -s /bin/bash "$APP_USER" \
        -c "$(printf '%q ' "$@")"
    fi
  )
}

run_migrations() {
  log "Running database migrations (idempotent)."
  run_as_app npm run --silent migrate \
    || die "migrations failed. The database was left untouched by a failed migration only if the migration runner is transactional; check the output above before retrying."
  ok "Schema up to date."
}

# ------------------------------------------------- service start + LXC ----

in_container() {
  local virt
  virt="$(systemd-detect-virt --container 2>/dev/null || printf 'none')"
  [[ "$virt" != "none" ]]
}

wait_for_health() {
  local tries="${1:-40}" i state
  for (( i = 0; i < tries; i++ )); do
    state="$(systemctl show -p ActiveState --value "$SERVICE_NAME" 2>/dev/null || printf 'unknown')"
    if [[ "$state" == "failed" ]]; then
      return 1
    fi
    if [[ "$state" == "active" ]] \
       && curl -fsS -m 2 -o /dev/null "http://127.0.0.1:${PORT}/healthz" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

sandbox_failure_detected() {
  local status journal
  status="$(systemctl show -p ExecMainStatus --value "$SERVICE_NAME" 2>/dev/null || printf '')"
  journal="$(journalctl -u "$SERVICE_NAME" -n 100 --no-pager 2>/dev/null || printf '')"
  # 243 is EXIT_CREDENTIALS, 226 is EXIT_NAMESPACE. Both mean systemd could not
  # build the sandbox, not that the app is broken.
  if [[ "$status" == "243" || "$status" == "226" ]]; then
    return 0
  fi
  printf '%s' "$journal" | grep -qE \
    'Failed at step (NAMESPACE|CREDENTIALS)|Failed to set up mount namespacing|243/CREDENTIALS|226/NAMESPACE'
}

write_relax_override() {
  local stage="$1"
  install -d -m 0755 "$OVERRIDE_DIR"
  if [[ "$stage" == "1" ]]; then
    cat >"${OVERRIDE_DIR}/10-lxc-relax.conf" <<'EOF'
# Written automatically by deploy/install.sh.
#
# This container's kernel/LXC configuration refused the mount-namespace based
# sandboxing in taco-analyzer.service ("Failed at step NAMESPACE", or exit
# 243/CREDENTIALS, which is the most frequently reported Debian 13 LXC problem).
# Rather than leave you with a dead service, the installer relaxed ONLY the
# directives that require a private mount namespace.
#
# Still fully in force, because none of it needs mount namespacing:
#   NoNewPrivileges, CapabilityBoundingSet=, AmbientCapabilities=,
#   SystemCallFilter, SystemCallArchitectures, RestrictAddressFamilies,
#   LockPersonality, RestrictSUIDSGID, RestrictRealtime, RestrictNamespaces,
#   ProtectHostname, ProtectClock, UMask, LimitNOFILE.
#
# To get the full sandbox back, fix the container instead of the unit:
#   * On Proxmox, enable nesting:   pct set <CTID> -features nesting=1
#     then reboot the container. This is the usual fix.
#   * Or install LXC's systemd generator on the host distribution so that
#     /etc/systemd/system-generators/lxc exists inside the container.
# Then delete this file and run:  systemctl daemon-reload && systemctl restart taco-analyzer
[Service]
ProtectSystem=full
ProtectProc=default
ProcSubset=all
ProtectControlGroups=no
PrivateTmp=no
EOF
  else
    cat >"${OVERRIDE_DIR}/20-lxc-relax-more.conf" <<'EOF'
# Written automatically by deploy/install.sh, second stage.
#
# The service still could not start with 10-lxc-relax.conf applied, so this
# container refuses mount namespacing altogether. Every remaining
# namespace-dependent directive is disabled here.
#
# The privilege and syscall restrictions are STILL ENFORCED (see the comment in
# 10-lxc-relax.conf). Do not add MemoryDenyWriteExecute here or anywhere else;
# it kills Node.
#
# The right fix is to enable nesting on the container and delete both override
# files. See DEPLOY.md, "LXC failure modes".
[Service]
ProtectSystem=no
ProtectHome=no
ProtectKernelTunables=no
ProtectKernelModules=no
ProtectKernelLogs=no
ReadWritePaths=
EOF
  fi
  systemctl daemon-reload
}

start_service() {
  log "Starting ${SERVICE_NAME}."
  systemctl restart "$SERVICE_NAME" || true
  if wait_for_health; then
    ok "Service is active and /healthz answers on 127.0.0.1:${PORT}."
    return 0
  fi

  if sandbox_failure_detected; then
    if in_container; then
      warn "systemd could not build the sandbox inside this container. Relaxing the mount-namespace hardening (stage 1) and retrying."
    else
      warn "systemd could not build the sandbox on this host. Relaxing the mount-namespace hardening (stage 1) and retrying."
    fi
    write_relax_override 1
    RELAXED_STAGE="1"
    systemctl restart "$SERVICE_NAME" || true
    if wait_for_health; then
      ok "Service started with stage-1 relaxed sandboxing."
      return 0
    fi
    if sandbox_failure_detected; then
      warn "Still refused. Disabling the remaining namespace-dependent directives (stage 2) and retrying."
      write_relax_override 2
      RELAXED_STAGE="2"
      systemctl restart "$SERVICE_NAME" || true
      if wait_for_health; then
        ok "Service started with stage-2 relaxed sandboxing."
        return 0
      fi
    fi
  fi

  printf '\n'
  warn "The service did not become healthy. Last 40 journal lines:"
  journalctl -u "$SERVICE_NAME" -n 40 --no-pager || true
  die "${SERVICE_NAME} failed to start. See the journal above.
Common causes:
  * A configuration contradiction in ${ENV_FILE} (the app validates at boot and
    explains the problem on the first lines of the journal).
  * Port ${PORT} already in use:  ss -lntp | grep ':${PORT}'
  * Somebody added MemoryDenyWriteExecute=yes to the unit. It kills Node.js."
}

# --------------------------------------------------------------- caddy ----

install_caddy() {
  if command -v caddy >/dev/null 2>&1 && [[ -f /etc/apt/sources.list.d/caddy-stable.list ]]; then
    ok "Caddy already installed ($(caddy version | head -n1))."
    return 0
  fi
  log "Installing Caddy from the official repository."
  # Debian's own caddy package is 2.6.2 and too old; the upstream repository is
  # the supported path. gnupg is needed here for --dearmor.
  apt_install debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    >/etc/apt/sources.list.d/caddy-stable.list
  # apt runs its fetch as the _apt user, which must be able to read both files.
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  chmod o+r /etc/apt/sources.list.d/caddy-stable.list
  DEBIAN_FRONTEND=noninteractive apt-get update
  apt_install caddy
  ok "Caddy installed ($(caddy version | head -n1))."
}

configure_caddy() {
  local template="${DEPLOY_DIR}/Caddyfile.lan.example"
  [[ "$TLS_MODE" == "public" ]] && template="${DEPLOY_DIR}/Caddyfile.public.example"
  [[ -f "$template" ]] || die "missing Caddyfile template: ${template}"

  log "Writing ${CADDY_FILE} from $(basename "$template")."
  install -d -m 0755 /etc/caddy
  install -d -m 0750 -o caddy -g caddy /var/log/caddy 2>/dev/null || true

  if [[ -f "$CADDY_FILE" ]] && ! grep -q 'taco-analyzer-managed' "$CADDY_FILE"; then
    local backup="${CADDY_FILE}.pre-${APP_NAME}.$(date -u '+%Y%m%dT%H%M%SZ')"
    cp -a "$CADDY_FILE" "$backup"
    warn "An unmanaged ${CADDY_FILE} was already here; saved it as ${backup}. If that machine serves other sites, merge them back by hand."
  fi

  local tmp
  tmp="$(mktemp)"
  sed -e "s|__HOSTNAME__|${HOSTNAME_ARG}|g" \
      -e "s|__PORT__|${PORT}|g" \
      -e "s|__EMAIL__|${EMAIL_ARG}|g" \
      "$template" >"$tmp"
  install -m 0644 -o root -g root "$tmp" "$CADDY_FILE"
  rm -f "$tmp"

  # Pre-create the access log owned by caddy, BEFORE validating.
  #
  # `caddy validate` instantiates the configured log writers, and it runs here as
  # root, so it creates /var/log/caddy/taco-analyzer.log as root:root 0600. The
  # service then runs as the caddy user and cannot open its own log file, and
  # Caddy treats that as fatal: it exits 1 with "permission denied" and the whole
  # proxy never starts. Creating the file with the right owner first, and
  # correcting ownership again afterwards, closes both orderings.
  install -d -m 0750 -o caddy -g caddy /var/log/caddy 2>/dev/null || true
  install -m 0640 -o caddy -g caddy /dev/null /var/log/caddy/${APP_NAME}.log 2>/dev/null || true

  if ! caddy validate --config "$CADDY_FILE" --adapter caddyfile >/dev/null 2>&1; then
    caddy validate --config "$CADDY_FILE" --adapter caddyfile || true
    die "Caddy rejected the generated configuration (${CADDY_FILE}). The error is above."
  fi

  # Validation may have recreated the file as root even though it existed; fix
  # ownership unconditionally rather than assuming.
  chown caddy:caddy "/var/log/caddy/${APP_NAME}.log" 2>/dev/null || true
  chmod 0640 "/var/log/caddy/${APP_NAME}.log" 2>/dev/null || true

  ok "Caddyfile validates."

  systemctl enable caddy >/dev/null 2>&1 || true
  if systemctl is-active --quiet caddy; then
    systemctl reload caddy || systemctl restart caddy
  else
    systemctl start caddy
  fi

  # Give Caddy a moment to bind and, for --lan, to provision its internal CA.
  local i
  for (( i = 0; i < 20; i++ )); do
    systemctl is-active --quiet caddy && break
    sleep 0.5
  done

  if ! systemctl is-active --quiet caddy; then
    warn "Caddy is not running. Last 30 journal lines:"
    journalctl -u caddy -n 30 --no-pager || true
    die "Caddy failed to start, so the app is not reachable over TLS.
The app itself is running on 127.0.0.1:${PORT}; only the proxy is broken.
If the journal mentions 'permission denied' binding :80 or :443, this is an
unprivileged container that will not grant CAP_NET_BIND_SERVICE. Note that
sysctl net.ipv4.ip_unprivileged_port_start is NOT a reliable workaround inside
an unprivileged LXC. Either run the container privileged, or publish through a
host-level proxy, or use --no-tls --i-accept-insecure-http on a trusted LAN."
  fi

  if command -v ss >/dev/null 2>&1; then
    if ! ss -H -lnt 2>/dev/null | grep -qE ':(443)[[:space:]]'; then
      warn "Caddy is running but nothing is listening on port 443. Check 'journalctl -u caddy' for a bind failure; in an unprivileged LXC, CAP_NET_BIND_SERVICE for ports 80/443 is not always granted."
    else
      ok "Caddy is listening on 443 (and redirecting 80)."
    fi
  fi

  if [[ "$TLS_MODE" == "lan" ]]; then
    for (( i = 0; i < 20; i++ )); do
      [[ -f "$CADDY_ROOT_CA" ]] && break
      sleep 0.5
    done
    if [[ -f "$CADDY_ROOT_CA" ]]; then
      ok "Internal CA root certificate at ${CADDY_ROOT_CA}."
    else
      warn "Caddy has not written its internal CA root yet. It is created on the first TLS handshake. Load https://${HOSTNAME_ARG}/ once, then look for ${CADDY_ROOT_CA}."
    fi
  fi
}

# ------------------------------------------------------- first admin -----

count_users() {
  local db="${DATA_DIR}/taco.db"
  if [[ ! -f "$db" ]]; then printf '0'; return 0; fi
  local script="${WORK_DIR:-/tmp}/count-users.cjs"
  [[ -n "${WORK_DIR}" ]] || { WORK_DIR="$(mktemp -d)"; script="${WORK_DIR}/count-users.cjs"; }
  cat >"$script" <<'JS'
// Count rows in users, tolerating a database that has no such table yet.
const Database = require('better-sqlite3');
const db = new Database(process.env.TACO_DB_FILE);
const present = db
  .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='users'")
  .get().c;
process.stdout.write(present ? String(db.prepare('SELECT count(*) AS c FROM users').get().c) : '0');
JS
  chmod 0644 "$script"
  chown "root:${APP_GROUP}" "$script" 2>/dev/null || true
  chmod 0755 "$WORK_DIR"
  TACO_DB_FILE="$db" run_as_app env "TACO_DB_FILE=$db" "$NODE_BIN" "$script" 2>/dev/null || printf 'error'
}

maybe_create_first_admin() {
  local users
  users="$(count_users)"
  if [[ "$users" == "error" ]]; then
    warn "Could not check whether any users exist; skipping first-admin creation. Create one by hand (see the summary below)."
    return 0
  fi
  if [[ "$users" != "0" ]]; then
    ok "Database already has ${users} user account(s); not creating another."
    return 0
  fi

  local admin_email="$EMAIL_ARG" admin_name=""
  if [[ -z "$admin_email" ]]; then
    if [[ -t 0 ]]; then
      printf '\n'
      log "No user accounts exist yet. Let's create the first admin."
      read -r -p "  Admin email address: " admin_email
      read -r -p "  Display name: " admin_name
    else
      warn "No user accounts exist and no --email was given (and this is not an interactive terminal), so no admin was created."
      printf '\nCreate the first admin yourself with:\n' >&2
      printf '  cd %s && sudo -u %s env HOME=%s npm run create-user -- --email you@example.org --name "Your Name" --role admin\n\n' \
        "$REPO_ROOT" "$APP_USER" "$DATA_DIR" >&2
      return 0
    fi
  fi
  [[ -n "$admin_email" ]] || { warn "No email given; skipping first-admin creation."; return 0; }
  if [[ -z "$admin_name" ]]; then
    admin_name="${admin_email%%@*}"
  fi

  log "Creating the first admin account (${admin_email})."
  local output
  if ! output="$(run_as_app npm run --silent create-user -- \
        --email "$admin_email" --name "$admin_name" --role admin 2>&1)"; then
    warn "create-user failed:"
    printf '%s\n' "$output" >&2
    warn "Create the account by hand once the cause is fixed (command is in the summary below)."
    return 0
  fi
  printf '%s\n' "$output"
  CREATED_EMAIL="$admin_email"
  # The generated one-time password is on stdout. Pull out the longest
  # whitespace-delimited token that looks like a generated secret, so the
  # summary can repeat it; if the format is not recognised, the raw output above
  # is still shown and nothing is lost.
  CREATED_PASSWORD="$(printf '%s' "$output" \
    | grep -oE '[A-Za-z0-9_.@%^&*+=~/-]{16,}' \
    | grep -vE '^(https?|--|npm|password|Password)' \
    | tail -n1 || true)"
}

# ------------------------------------------------------------- summary ----

print_summary() {
  local url
  if [[ "$TLS_MODE" == "none" ]]; then
    url="http://${HOSTNAME_ARG}:${PORT}"
  else
    url="https://${HOSTNAME_ARG}"
  fi

  printf '\n'
  rule
  printf '%s Taco Analyzer is installed and running%s\n' "${C_GREEN}${C_BOLD}" "${C_RESET}"
  rule
  printf '\n'
  printf '  %sURL%s              %s\n' "$C_BOLD" "$C_RESET" "$url"
  printf '  %sApp directory%s    %s\n' "$C_BOLD" "$C_RESET" "$REPO_ROOT"
  printf '  %sData directory%s   %s   (taco.db, uploads/, tmp/)\n' "$C_BOLD" "$C_RESET" "$DATA_DIR"
  printf '  %sConfiguration%s    %s\n' "$C_BOLD" "$C_RESET" "$ENV_FILE"
  printf '  %sService account%s  %s (nologin)\n' "$C_BOLD" "$C_RESET" "$APP_USER"
  printf '  %sNode.js%s          %s  (%s -> %s)\n' "$C_BOLD" "$C_RESET" "$NODE_VER" "${NODE_PREFIX}/current" "$NODE_DIR"
  printf '\n'

  if [[ -n "$CREATED_EMAIL" ]]; then
    rule
    printf '%s FIRST ADMIN ACCOUNT: WRITE THIS DOWN NOW %s\n' "${C_YELLOW}${C_BOLD}" "${C_RESET}"
    rule
    printf '\n'
    printf '  Email:     %s\n' "$CREATED_EMAIL"
    if [[ -n "$CREATED_PASSWORD" ]]; then
      printf '  Password:  %s%s%s\n' "${C_BOLD}" "$CREATED_PASSWORD" "${C_RESET}"
    else
      printf '  Password:  see the create-user output printed above\n'
    fi
    printf '\n'
    printf '  %sThis password is shown ONCE. It is stored only as a hash, so it cannot\n' "${C_BOLD}"
    printf '  be recovered or looked up. It EXPIRES 24 HOURS after issue, and you will\n'
    printf '  be forced to choose a new one on first login.%s\n' "${C_RESET}"
    printf '  If it expires, reissue with:\n'
    printf '    cd %s && sudo -u %s env HOME=%s npm run reset-password -- --email %s\n' \
      "$REPO_ROOT" "$APP_USER" "$DATA_DIR" "$CREATED_EMAIL"
    printf '\n'
  fi

  if [[ "$TLS_MODE" == "lan" ]]; then
    rule
    printf '%s LAN TLS: install the root CA on every device %s\n' "${C_BOLD}" "${C_RESET}"
    rule
    printf '\n'
    printf '  Until you do this, every browser and phone shows a certificate warning.\n\n'
    printf '  Root CA certificate on this machine:\n'
    printf '    %s\n\n' "$CADDY_ROOT_CA"
    printf '  Copy it to your workstation:\n'
    printf '    scp root@%s:%s ./taco-lan-ca.crt\n\n' "$HOSTNAME_ARG" "$CADDY_ROOT_CA"
    printf '  iPhone / iPad:\n'
    printf '    1. AirDrop or email taco-lan-ca.crt to the device and open it.\n'
    printf '    2. Settings > General > VPN & Device Management > install the profile.\n'
    printf '    3. REQUIRED SECOND STEP: Settings > General > About > Certificate\n'
    printf '       Trust Settings > enable full trust for "Taco Analyzer Local CA".\n'
    printf '       Skipping step 3 is the single most common reason iOS still warns.\n\n'
    printf '  Android:\n'
    printf '    Settings > Security & privacy > More security settings > Encryption &\n'
    printf '    credentials > Install a certificate > CA certificate > pick the file.\n'
    printf '    (Wording varies by vendor. Chrome honours this store; some apps do not.)\n\n'
    printf '  Windows (elevated PowerShell or cmd):\n'
    printf '    certutil -addstore -f Root taco-lan-ca.crt\n\n'
    printf '  macOS:\n'
    printf '    sudo security add-trusted-cert -d -r trustRoot \\\n'
    printf '      -k /Library/Keychains/System.keychain taco-lan-ca.crt\n\n'
    printf '  Firefox uses its OWN trust store on every platform: either import the\n'
    printf '  certificate under Settings > Privacy & Security > View Certificates >\n'
    printf '  Authorities > Import, or set security.enterprise_roots.enabled = true\n'
    printf '  in about:config so it reads the system store.\n\n'
    printf '  DNS: %s must resolve to this machine on your LAN (local DNS, your\n' "$HOSTNAME_ARG"
    printf '  router''s host entries, or a hosts-file entry on each client).\n\n'
  fi

  if [[ "$TLS_MODE" == "public" ]]; then
    rule
    printf '%s Public TLS %s\n' "${C_BOLD}" "${C_RESET}"
    rule
    printf '\n'
    printf '  Caddy obtains and renews the certificate automatically. Requirements:\n'
    printf '    * %s resolves publicly to this machine.\n' "$HOSTNAME_ARG"
    printf '    * Inbound TCP 80 AND 443 reach it (80 is needed for the challenge).\n'
    printf '  Watch the first issuance with:  journalctl -u caddy -f\n\n'
  fi

  if [[ "$TLS_MODE" == "none" ]]; then
    rule
    printf '%s WARNING: NO TLS %s\n' "${C_RED}${C_BOLD}" "${C_RESET}"
    rule
    printf '\n'
    printf '  Session cookies and passwords cross the network in cleartext, and the\n'
    printf '  app is running with COOKIE_SECURE=0. Anyone on this network can steal a\n'
    printf '  session. Move to TLS as soon as you can:\n\n'
    printf '    %s/deploy/install.sh --lan --hostname %s\n\n' "$REPO_ROOT" "$HOSTNAME_ARG"
    printf '  That also changes the session cookie name, so everyone logs in again.\n\n'
  fi

  if [[ "$RELAXED_STAGE" != "0" ]]; then
    rule
    printf '%s HARDENING WAS RELAXED (stage %s) %s\n' "${C_YELLOW}${C_BOLD}" "$RELAXED_STAGE" "${C_RESET}"
    rule
    printf '\n'
    printf '  This container refused systemd''s mount-namespace sandboxing, so the\n'
    printf '  service would not start. Rather than leave you with a dead service, the\n'
    printf '  installer disabled only the namespace-dependent directives:\n\n'
    if [[ "$RELAXED_STAGE" == "1" ]]; then
      printf '    ProtectSystem   strict -> full\n'
      printf '    ProtectProc     invisible -> default\n'
      printf '    ProcSubset      pid -> all\n'
      printf '    ProtectControlGroups  yes -> no\n'
      printf '    PrivateTmp      yes -> no\n'
    else
      printf '    ProtectSystem, ProtectHome, PrivateTmp, ProtectControlGroups,\n'
      printf '    ProtectProc, ProcSubset, ProtectKernelTunables, ProtectKernelModules,\n'
      printf '    ProtectKernelLogs, ReadWritePaths: all disabled.\n'
    fi
    printf '\n  STILL ENFORCED (these need no mount namespace):\n'
    printf '    NoNewPrivileges, empty CapabilityBoundingSet and AmbientCapabilities,\n'
    printf '    SystemCallFilter, SystemCallArchitectures, RestrictAddressFamilies,\n'
    printf '    LockPersonality, RestrictSUIDSGID, RestrictRealtime,\n'
    printf '    RestrictNamespaces, ProtectHostname, ProtectClock, UMask=0077.\n\n'
    printf '  Override files:  %s/\n' "$OVERRIDE_DIR"
    printf '  Proper fix (Proxmox):  pct set <CTID> -features nesting=1, reboot the\n'
    printf '  container, delete the override files, systemctl daemon-reload &&\n'
    printf '  systemctl restart %s\n\n' "$SERVICE_NAME"
  fi

  rule
  printf '%s Day-to-day commands %s\n' "${C_BOLD}" "${C_RESET}"
  rule
  printf '\n'
  printf '  Status        systemctl status %s\n' "$SERVICE_NAME"
  printf '  Logs (live)   journalctl -u %s -f\n' "$SERVICE_NAME"
  printf '  Logs (last)   journalctl -u %s -n 200 --no-pager\n' "$SERVICE_NAME"
  printf '  Restart       systemctl restart %s\n' "$SERVICE_NAME"
  printf '  Proxy logs    journalctl -u caddy -n 100 --no-pager\n'
  printf '  Health        curl -fsS http://127.0.0.1:%s/healthz\n' "$PORT"
  printf '\n'
  printf '  Add a user    cd %s && sudo -u %s env HOME=%s \\\n' "$REPO_ROOT" "$APP_USER" "$DATA_DIR"
  printf '                  npm run create-user -- --email a@b.org --name "A B" --role collector\n'
  printf '  Update        sudo %s/deploy/update.sh\n' "$REPO_ROOT"
  printf '  Back up       sudo %s/deploy/backup.sh\n' "$REPO_ROOT"
  printf '  Uninstall     sudo %s/deploy/uninstall.sh\n' "$REPO_ROOT"
  printf '\n'
  printf '  Full runbook: %s/DEPLOY.md\n' "$REPO_ROOT"
  printf '\n'
}

# ---------------------------------------------------------------- main ----

main() {
  parse_args "$@"
  require_root "$@"
  check_os
  check_arch
  check_repo
  validate_options

  install_base_packages
  install_nodejs
  create_user_and_dirs
  install_dependencies
  set_code_ownership
  write_env_file
  install_unit

  # Migrate with the service stopped, so old code never sees a new schema.
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  run_migrations
  start_service

  if [[ "$TLS_MODE" != "none" ]]; then
    install_caddy
    configure_caddy
  fi

  maybe_create_first_admin
  print_summary
}

main "$@"
