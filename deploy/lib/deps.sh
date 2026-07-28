#!/usr/bin/env bash
#
# Shared dependency installation, sourced by install.sh and update.sh.
#
# This exists because the two had their own copies and drifted: install.sh
# passed --ignore-scripts and update.sh did not, so a fresh install worked while
# the first upgrade attempt failed trying to compile better-sqlite3 from source
# on a box with no compiler. One copy, sourced twice, cannot do that again.
#
# Callers must already define log(), ok(), warn() and die().

# Install this app's production dependencies into $1, verifying the native
# module actually loads afterwards.
#
#   taco_install_dependencies /opt/taco-analyzer /usr/local/bin/node
#
taco_install_dependencies() {
  local repo_root="$1"
  local node_bin="${2:-node}"

  log "Installing production npm dependencies."

  local flags=(--omit=dev --no-audit --no-fund --loglevel=warn)
  local installer=(npm ci)
  if [[ ! -f "${repo_root}/package-lock.json" ]]; then
    warn "No package-lock.json in the repository, so 'npm ci' cannot be used and dependency versions are resolved fresh at install time. That means two installs on different days can get different transitive dependencies. Commit a lockfile."
    installer=(npm install)
  fi

  # --ignore-scripts does two jobs, and both matter.
  #
  # 1. Hardening: no dependency, direct or transitive, gets to execute arbitrary
  #    code as root at install time.
  # 2. It stops npm's implicit native build. npm compiles any package that has a
  #    binding.gyp and no install script of its own, and better-sqlite3 has
  #    exactly that shape. Without this flag npm ignores the prebuilt binary
  #    sitting in the tarball and tries node-gyp, which fails on a container with
  #    no compiler. That is the bug this file was extracted to prevent.
  #
  # Neither dependency needs a build step: better-sqlite3 13.x is Node-API based
  # and ships prebuilds/linux-x64.node, and hono is pure JavaScript.
  if ! ( cd "$repo_root" && HOME=/root NPM_CONFIG_UPDATE_NOTIFIER=false \
         "${installer[@]}" "${flags[@]}" --ignore-scripts ); then
    warn "Dependency install failed with --ignore-scripts. Retrying with a compiler toolchain available, in case a dependency now genuinely needs to build from source."
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential python3 pkg-config >/dev/null 2>&1 || true
    ( cd "$repo_root" && HOME=/root NPM_CONFIG_UPDATE_NOTIFIER=false \
      "${installer[@]}" "${flags[@]}" ) \
      || die "npm dependency install failed. Read the output above; a network problem and a native build failure look quite different."
  fi

  # Fail here with an explanation rather than in a systemd restart loop.
  if ! ( cd "$repo_root" && "$node_bin" -e 'require("better-sqlite3")' ); then
    die "better-sqlite3 installed but will not load.
If the error above mentions GLIBCXX or libstdc++, install it:
    apt-get install -y --no-install-recommends libstdc++6
The bundled prebuild needs glibc >= 2.34 and GLIBCXX_3.4.29; Debian 13 ships
glibc 2.41, so this is normally only seen on a very minimal container rootfs."
  fi

  ok "Dependencies installed and better-sqlite3 loads."
}
