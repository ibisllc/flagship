# box-build — build one commit's box artifact on this machine in a throwaway staging folder (release plan G9).
# Sourced by scripts/owner-build.sh and scripts/repro-compare.sh.
#
#   box_build_local <repo> <commit> <arch> <sequence> <out dir> <no-rust 0|1> [extra build.ts args...]
#
# The staging folder has its own HOME, TMPDIR and npm cache; the build runs under `env -i` with only PATH,
# the locale and the cargo/rustup homes; the build tools come from the commit itself (its lockfile, scripts
# off), never from the caller's checkout; the folder is removed afterwards, also on failure.
# BOX_BUILD_NODE_ARCHIVE may name an already downloaded official Node archive (its SHA-256 is still checked
# against the commit's pins). BOX_BUILD_SKIP_PGP=1 skips the SHASUMS256 signature check (offline only;
# recorded in the provenance's flags).

box_build_refuse_on_a_server() {
  if [ -e /etc/flagship/daemon.env ] || [ -d /var/flagship/keyd ] || [ -e /opt/flagship/.runtime ]; then
    echo "refused: this machine is a Flagship server. Build somewhere else; an owner build never runs beside live keys or data." >&2
    return 1
  fi
}

box_build_local() {
  local repo="$1" commit="$2" arch="$3" seq="$4" out="$5" no_rust="$6"
  shift 6
  box_build_refuse_on_a_server || return 1
  local stage; stage="$(mktemp -d "${TMPDIR:-/tmp}/flagship-owner-build.XXXXXX")"
  # shellcheck disable=SC2064
  trap "chmod -R u+w '$stage' 2>/dev/null; rm -rf '$stage' || true" RETURN
  mkdir -p "$stage/home" "$stage/tmp" "$stage/tools"
  git -C "$repo" rev-parse --verify --quiet "${commit}^{commit}" >/dev/null || { echo "$commit is not in $repo" >&2; return 1; }
  # The commit's own build tools, installed from its own lockfile with lifecycle scripts off.
  git -C "$repo" archive "$commit" | tar -x -C "$stage/tools"
  local path_min="$PATH" cargo_home="${CARGO_HOME:-$HOME/.cargo}" rustup_home="${RUSTUP_HOME:-$HOME/.rustup}"
  local -a envv=(env -i "PATH=$path_min" "HOME=$stage/home" "TMPDIR=$stage/tmp" "LANG=C.UTF-8" "LC_ALL=C.UTF-8"
    "npm_config_cache=$stage/home/.npm" "CARGO_HOME=$cargo_home" "RUSTUP_HOME=$rustup_home" "CARGO_INCREMENTAL=0"
    "GOFLAGS=-modcacherw" "GOPATH=$stage/home/go" "GOTOOLCHAIN=local")
  (cd "$stage/tools" && "${envv[@]}" npm ci --ignore-scripts --no-audit --no-fund --include-workspace-root --workspace=packages/server-daemon >/dev/null) || return 1
  local -a args=(build --commit "$commit" --arch "$arch" --sequence "$seq" --out "$out" --repo "$repo")
  [ "$no_rust" = 1 ] && args+=(--no-rust)
  [ -n "${BOX_BUILD_NODE_ARCHIVE:-}" ] && args+=(--node-archive "$BOX_BUILD_NODE_ARCHIVE")
  [ "${BOX_BUILD_SKIP_PGP:-0}" = 1 ] && args+=(--skip-pgp)
  # tsx as a loader, not its CLI: the CLI opens a socket under TMPDIR, which fails when the staging path is long.
  (cd "$stage/tools" && "${envv[@]}" node --import tsx tools/box-artifact/build.ts "${args[@]}" "$@") || return 1
}
