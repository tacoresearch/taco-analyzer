#!/usr/bin/env bash
#
# Back up the Taco Analyzer database and uploaded photos.
#
#   sudo bash deploy/backup.sh [--out DIR] [--keep N] [--quiet]
#
# IMPORTANT: this uses SQLite's own online backup, not `cp`.
#
# The database runs in WAL mode, which means committed data can live in a
# separate -wal file that has not yet been folded into the main file. Copying
# taco.db with cp, rsync, or tar while the service is running can therefore
# capture a torn, half-written state that looks fine until you try to restore it.
# `sqlite3 .backup` (and VACUUM INTO) take a consistent snapshot of a live
# database, which is the entire reason this script exists rather than a one-line
# cron job with cp.
#
set -euo pipefail

DATA_DIR="/var/lib/taco-analyzer"
DB_FILE="${DATA_DIR}/taco.db"
UPLOAD_DIR="${DATA_DIR}/uploads"
OUT_DIR="${DATA_DIR}/backups"
KEEP=14
QUIET="no"

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_BLUE=$'\033[34m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
else
  C_RESET=""; C_BOLD=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""
fi

log()  { [[ "$QUIET" == "yes" ]] || printf '%s==>%s %s\n' "${C_BLUE}${C_BOLD}" "${C_RESET}" "$*"; }
ok()   { [[ "$QUIET" == "yes" ]] || printf '%s  ok%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
warn() { printf '%swarn%s %s\n' "${C_YELLOW}${C_BOLD}" "${C_RESET}" "$*" >&2; }
die()  { printf '%serror%s %s\n' "${C_RED}${C_BOLD}" "${C_RESET}" "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)   OUT_DIR="${2:?--out needs a directory}"; shift 2 ;;
    --keep)  KEEP="${2:?--keep needs a number}";      shift 2 ;;
    --quiet) QUIET="yes";                             shift ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ "$KEEP" =~ ^[0-9]+$ ]] || die "--keep must be a whole number."
[[ $EUID -eq 0 ]] || die "Run this as root (use sudo)."
[[ -f "$DB_FILE" ]] || die "No database at ${DB_FILE}. Is the app installed?"

# sqlite3 is not a dependency of the app itself (the Node driver bundles its own
# SQLite), so it may well be absent on a minimal container.
if ! command -v sqlite3 >/dev/null 2>&1; then
  log "Installing the sqlite3 CLI (needed for a consistent online backup)"
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends sqlite3 \
    >/dev/null 2>&1 || die "Could not install sqlite3. Install it and re-run."
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${OUT_DIR}/${STAMP}"
mkdir -p "$DEST"
chmod 0700 "$OUT_DIR" "$DEST"

log "Backing up the database"
# .backup copies page by page while holding appropriate locks, retrying on
# contention, so a writer mid-transaction does not corrupt the result.
sqlite3 "$DB_FILE" ".backup '${DEST}/taco.db'" \
  || die "sqlite3 .backup failed."

# Verify what we just wrote rather than trusting that the command succeeded. A
# backup discovered to be corrupt at restore time is worse than no backup,
# because you stopped worrying about it.
integrity="$(sqlite3 "${DEST}/taco.db" 'PRAGMA integrity_check;' 2>&1 || true)"
if [[ "$integrity" != "ok" ]]; then
  die "The backup failed its integrity check: ${integrity}"
fi
ok "database backed up and verified"

if [[ -d "$UPLOAD_DIR" ]] && [[ -n "$(ls -A "$UPLOAD_DIR" 2>/dev/null || true)" ]]; then
  log "Archiving uploaded photos"
  tar -czf "${DEST}/uploads.tar.gz" -C "$DATA_DIR" uploads
  ok "photos archived ($(du -h "${DEST}/uploads.tar.gz" | cut -f1))"
else
  log "No uploaded photos to archive"
fi

# Record what produced this backup, so a restore years later is not guesswork.
{
  printf 'created_utc=%s\n' "$STAMP"
  printf 'host=%s\n' "$(hostname)"
  printf 'db_source=%s\n' "$DB_FILE"
  printf 'integrity_check=%s\n' "$integrity"
  if command -v git >/dev/null 2>&1; then
    repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    git config --global --add safe.directory "$repo_root" 2>/dev/null || true
    printf 'git_commit=%s\n' "$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || echo unknown)"
  fi
  printf 'schema_migrations=%s\n' \
    "$(sqlite3 "${DEST}/taco.db" 'SELECT group_concat(name, " ") FROM schema_migrations;' 2>/dev/null || echo unknown)"
} > "${DEST}/MANIFEST"

chown -R root:root "$DEST"
chmod -R go-rwx "$DEST"

# Prune old backups. Sorting by name works because the directory names are
# UTC timestamps in a sortable format.
if [[ "$KEEP" -gt 0 ]]; then
  mapfile -t all < <(find "$OUT_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
  count=${#all[@]}
  if (( count > KEEP )); then
    remove=$(( count - KEEP ))
    log "Pruning ${remove} old backup(s), keeping the newest ${KEEP}"
    for (( i = 0; i < remove; i++ )); do
      rm -rf "${OUT_DIR}/${all[i]}"
    done
  fi
fi

if [[ "$QUIET" == "yes" ]]; then
  printf '%s\n' "$DEST"
else
  printf '\n%sBackup complete:%s %s\n\n' "${C_BOLD}" "${C_RESET}" "$DEST"
  printf 'To restore:\n'
  printf '  systemctl stop taco-analyzer.service\n'
  printf '  cp %s/taco.db %s\n' "$DEST" "$DB_FILE"
  printf '  rm -f %s-wal %s-shm\n' "$DB_FILE" "$DB_FILE"
  printf '  tar -xzf %s/uploads.tar.gz -C %s   # if present\n' "$DEST" "$DATA_DIR"
  printf '  chown -R tacoapp:tacoapp %s\n' "$DATA_DIR"
  printf '  systemctl start taco-analyzer.service\n\n'
  printf 'Removing the stale -wal and -shm files matters: leaving them next to a\n'
  printf 'restored database can silently reintroduce the data you just rolled back.\n\n'
fi
