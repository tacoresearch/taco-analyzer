#!/usr/bin/env bash
#
# Update an existing Taco Analyzer install.
#
# Pulls the latest code, reinstalls dependencies, applies migrations, and
# restarts the service. Safe to re-run.
#
# The order matters: the service is stopped BEFORE migrations run, so old code
# never sees a new schema. A rolling restart would be nicer, but with one process
# and a SQLite file a brief stop is both simpler and safer.
#
#   sudo bash deploy/update.sh [--no-pull] [--skip-backup]
#
set -euo pipefail

APP_NAME="taco-analyzer"
APP_USER="tacoapp"
DATA_DIR="/var/lib/taco-analyzer"
ENV_FILE="/etc/taco-analyzer/taco-analyzer.env"
SERVICE_NAME="taco-analyzer.service"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DO_PULL="yes"
DO_BACKUP="yes"

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_BLUE=$'\033[34m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
else
  C_RESET=""; C_BOLD=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""
fi

log()  { printf '%s==>%s %s\n' "${C_BLUE}${C_BOLD}" "${C_RESET}" "$*"; }
ok()   { printf '%s  ok%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
warn() { printf '%swarn%s %s\n' "${C_YELLOW}${C_BOLD}" "${C_RESET}" "$*" >&2; }
die()  { printf '%serror%s %s\n' "${C_RED}${C_BOLD}" "${C_RESET}" "$*" >&2; exit 1; }

on_error() {
  local line=$1
  warn "update failed at line ${line}"
  warn "the service may be stopped. Check: systemctl status ${SERVICE_NAME}"
  warn "and:                            journalctl -u ${SERVICE_NAME} -n 50"
}
trap 'on_error $LINENO' ERR

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-pull)     DO_PULL="no";   shift ;;
    --skip-backup) DO_BACKUP="no"; shift ;;
    -h|--help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Run this as root (use sudo)."
[[ -f "$ENV_FILE" ]] || die "No install found at ${ENV_FILE}. Run deploy/install.sh first."
[[ -f "${REPO_ROOT}/package.json" ]] || die "${REPO_ROOT} does not look like the repo."

# A backup before every update is the cheapest possible insurance against a bad
# migration. Skipping it should be a deliberate choice.
if [[ "$DO_BACKUP" == "yes" ]]; then
  log "Backing up the database first"
  bash "${REPO_ROOT}/deploy/backup.sh" --quiet || die "Backup failed, refusing to continue."
  ok "backup taken"
else
  warn "Skipping the pre-update backup because --skip-backup was given."
fi

if [[ "$DO_PULL" == "yes" ]]; then
  log "Pulling the latest code"
  # The repo is owned by root while the app runs as tacoapp, so git needs to be
  # told this directory is trustworthy when invoked as root.
  git config --global --add safe.directory "$REPO_ROOT" 2>/dev/null || true

  if ! git -C "$REPO_ROOT" diff --quiet HEAD 2>/dev/null; then
    warn "There are uncommitted local changes in ${REPO_ROOT}."
    warn "Pulling could conflict. Commit, stash, or discard them first."
    die "Refusing to pull over local modifications."
  fi

  before="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  git -C "$REPO_ROOT" pull --ff-only
  after="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"

  if [[ "$before" == "$after" ]]; then
    ok "already at ${after}, nothing new"
  else
    ok "updated ${before} to ${after}"
  fi
fi

# shellcheck source=lib/deps.sh
. "${REPO_ROOT}/deploy/lib/deps.sh"
taco_install_dependencies "$REPO_ROOT" "$(command -v node || echo /usr/local/bin/node)"
chown -R "root:${APP_USER}" "${REPO_ROOT}/node_modules" 2>/dev/null || true

log "Checking for syntax errors before restarting"
# Cheap, and it catches the class of mistake that would otherwise take the
# service down after the restart rather than before it.
( cd "$REPO_ROOT" && node scripts/check-syntax.js )
ok "all files parse"

log "Stopping the service"
systemctl stop "$SERVICE_NAME" 2>/dev/null || true

log "Applying migrations"
# Delegated to taco-cli.sh rather than assembled here. The previous version built
# the environment with `grep | xargs`, which mangles any value containing a space
# and silently drops nothing-looking lines; taco-cli.sh sources the env file
# properly and resolves the privilege-drop tool by absolute path.
bash "${REPO_ROOT}/deploy/taco-cli.sh" migrate || die "migrations failed"
ok "migrations applied"

log "Restarting the service"
systemctl daemon-reload
systemctl start "$SERVICE_NAME"

# Confirm it actually came up rather than assuming a successful start command
# means a healthy process.
port="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2 | tr -d '[:space:]')"
port="${port:-8787}"
host="$(grep -E '^HOST=' "$ENV_FILE" | cut -d= -f2 | tr -d '[:space:]')"
host="${host:-127.0.0.1}"
[[ "$host" == "0.0.0.0" ]] && host="127.0.0.1"

for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://${host}:${port}/healthz" >/dev/null 2>&1; then
    ok "service is healthy on http://${host}:${port}"
    printf '\n%sUpdate complete.%s\n\n' "${C_BOLD}" "${C_RESET}"
    exit 0
  fi
  sleep 1
done

warn "The service did not become healthy within 30 seconds."
warn "Check: journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
exit 1
