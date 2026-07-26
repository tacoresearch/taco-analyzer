#!/usr/bin/env bash
#
# Remove Taco Analyzer from this machine.
#
#   sudo bash deploy/uninstall.sh              # remove service and config, KEEP data
#   sudo bash deploy/uninstall.sh --purge      # also delete the database and photos
#
# Data is preserved unless --purge is given, and --purge requires typing a
# confirmation phrase. Deleting survey data is the one action here that cannot be
# undone, so it is deliberately awkward.
#
set -euo pipefail

APP_USER="tacoapp"
APP_GROUP="tacoapp"
DATA_DIR="/var/lib/taco-analyzer"
CONF_DIR="/etc/taco-analyzer"
SERVICE_NAME="taco-analyzer.service"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}"
OVERRIDE_DIR="/etc/systemd/system/${SERVICE_NAME}.d"

PURGE="no"
REMOVE_USER="no"

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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge)       PURGE="yes";       shift ;;
    --remove-user) REMOVE_USER="yes"; shift ;;
    -h|--help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Run this as root (use sudo)."

if [[ "$PURGE" == "yes" ]]; then
  surveys="unknown"
  if [[ -f "${DATA_DIR}/taco.db" ]] && command -v sqlite3 >/dev/null 2>&1; then
    surveys="$(sqlite3 "${DATA_DIR}/taco.db" 'SELECT COUNT(*) FROM surveys;' 2>/dev/null || echo unknown)"
  fi
  photos=0
  if [[ -d "${DATA_DIR}/uploads" ]]; then
    photos="$(find "${DATA_DIR}/uploads" -type f 2>/dev/null | wc -l | tr -d ' ')"
  fi

  printf '\n%s%sThis will permanently delete all collected data.%s\n\n' \
    "${C_RED}" "${C_BOLD}" "${C_RESET}"
  printf '  Database   %s\n' "${DATA_DIR}/taco.db"
  printf '  Surveys    %s\n' "$surveys"
  printf '  Photos     %s\n' "$photos"
  printf '  Uploads    %s\n\n' "${DATA_DIR}/uploads"
  printf 'There is no undo. If you have not taken a backup, stop now and run:\n'
  printf '  sudo bash deploy/backup.sh\n\n'
  printf 'Type %sdelete the taco data%s to confirm: ' "${C_BOLD}" "${C_RESET}"

  # Read from the terminal explicitly so this cannot be satisfied by a piped
  # stdin, which would defeat the whole point of asking.
  if [[ ! -t 0 ]] && [[ ! -r /dev/tty ]]; then
    printf '\n'
    die "Refusing to purge without an interactive confirmation."
  fi
  read -r reply < /dev/tty
  if [[ "$reply" != "delete the taco data" ]]; then
    printf '\n'
    die "Confirmation did not match. Nothing was deleted."
  fi
  printf '\n'
fi

log "Stopping and disabling the service"
systemctl stop "$SERVICE_NAME" 2>/dev/null || true
systemctl disable "$SERVICE_NAME" 2>/dev/null || true
ok "service stopped"

log "Removing the unit and any overrides"
rm -f "$SERVICE_FILE"
rm -rf "$OVERRIDE_DIR"
systemctl daemon-reload
systemctl reset-failed "$SERVICE_NAME" 2>/dev/null || true
ok "unit removed"

log "Removing configuration"
rm -rf "$CONF_DIR"
ok "removed ${CONF_DIR}"

if [[ "$PURGE" == "yes" ]]; then
  log "Deleting data"
  rm -rf "$DATA_DIR"
  ok "removed ${DATA_DIR}"
else
  warn "Data was KEPT at ${DATA_DIR}"
  warn "Re-running deploy/install.sh will pick it up again."
  warn "To delete it: sudo bash deploy/uninstall.sh --purge"
fi

if [[ "$REMOVE_USER" == "yes" ]]; then
  if [[ "$PURGE" != "yes" ]] && [[ -d "$DATA_DIR" ]]; then
    # Files owned by a deleted UID become orphaned and awkward to recover.
    warn "Not removing the ${APP_USER} account: it still owns files in ${DATA_DIR}."
    warn "Either --purge the data too, or chown it to another user first."
  else
    log "Removing the ${APP_USER} account"
    deluser --system "$APP_USER" 2>/dev/null || true
    delgroup --system "$APP_GROUP" 2>/dev/null || true
    ok "account removed"
  fi
fi

printf '\n%sUninstalled.%s\n\n' "${C_BOLD}" "${C_RESET}"
printf 'Left alone deliberately:\n'
printf '  Node.js at /opt/nodejs (other things may use it)\n'
printf '  Caddy and /etc/caddy/Caddyfile (may serve other sites)\n'
printf '  The cloned repository itself\n\n'
printf 'Caddy is still proxying to a port nothing is listening on. Edit\n'
printf '/etc/caddy/Caddyfile and run: systemctl reload caddy\n\n'
