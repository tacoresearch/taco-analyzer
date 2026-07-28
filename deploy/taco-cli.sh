#!/usr/bin/env bash
#
# Run a Taco Analyzer maintenance command as the service account, with the
# service's own environment.
#
#   sudo deploy/taco-cli.sh create-user --email you@example.org --name "You" --role admin
#   sudo deploy/taco-cli.sh reset-password --email you@example.org
#   sudo deploy/taco-cli.sh prune-orphans [--delete]
#   sudo deploy/taco-cli.sh migrate
#   sudo deploy/taco-cli.sh check-syntax
#   sudo deploy/taco-cli.sh test
#
# Why this exists rather than a documented npm incantation:
#
# The app reads DATA_DIR from the environment and falls back to ./data relative
# to the working directory. Running `npm run create-user` by hand without
# sourcing /etc/taco-analyzer/taco-analyzer.env therefore does not fail cleanly:
# it tries to create a SECOND database inside the repository, and on a correctly
# installed system that fails with a confusing EACCES because the service
# account cannot write to the code directory. Worse, if the permissions were
# ever loose, it would silently create an empty parallel database and the
# operator would wonder why their new account cannot sign in.
#
# Sourcing the env file is the whole job, so it belongs in a script rather than
# in a README command nobody will copy correctly.
#
set -euo pipefail

APP_USER="tacoapp"
DATA_DIR="/var/lib/taco-analyzer"
ENV_FILE="/etc/taco-analyzer/taco-analyzer.env"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_RED=$'\033[31m'
else
  C_RESET=""; C_BOLD=""; C_RED=""
fi
die() { printf '%serror%s %s\n' "${C_RED}${C_BOLD}" "${C_RESET}" "$*" >&2; exit 1; }

usage() {
  sed -n '3,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  printf '\nAvailable commands: create-user, reset-password, migrate, check-syntax, test\n'
}

[[ $# -gt 0 ]] || { usage; exit 64; }
case "${1:-}" in
  -h|--help|help) usage; exit 0 ;;
esac

[[ $EUID -eq 0 ]] || die "Run this as root (use sudo)."
[[ -f "$ENV_FILE" ]] || die "No configuration at ${ENV_FILE}. Run deploy/install.sh first."

COMMAND="$1"; shift

case "$COMMAND" in
  create-user|reset-password|migrate|check-syntax|test|prune-orphans) ;;
  *) die "Unknown command: ${COMMAND}. Try --help." ;;
esac

# Resolve the privilege-dropping tool by absolute path before narrowing PATH:
# runuser lives in /usr/sbin, which the child's PATH deliberately excludes.
RUNNER=""; RUNNER_KIND=""
for candidate in /usr/sbin/runuser /sbin/runuser; do
  [[ -x "$candidate" ]] && { RUNNER="$candidate"; RUNNER_KIND="runuser"; break; }
done
if [[ -z "$RUNNER" ]]; then
  for candidate in /bin/su /usr/bin/su; do
    [[ -x "$candidate" ]] && { RUNNER="$candidate"; RUNNER_KIND="su"; break; }
  done
fi
[[ -n "$RUNNER" ]] || die "Neither runuser nor su found; cannot drop privileges."

run_as_app() {
  (
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
    export HOME="$DATA_DIR"
    export NPM_CONFIG_UPDATE_NOTIFIER=false
    export PATH="/usr/local/bin:/usr/bin:/bin"
    cd "$REPO_ROOT"
    if [[ "$RUNNER_KIND" == "runuser" ]]; then
      "$RUNNER" --preserve-environment -u "$APP_USER" -- "$@"
    else
      "$RUNNER" --preserve-environment -s /bin/bash "$APP_USER" -c "$(printf '%q ' "$@")"
    fi
  )
}

case "$COMMAND" in
  check-syntax) run_as_app node scripts/check-syntax.js ;;
  test)         run_as_app npm test ;;
  migrate)      run_as_app npm run --silent migrate ;;
  *)            run_as_app npm run --silent "$COMMAND" -- "$@" ;;
esac
