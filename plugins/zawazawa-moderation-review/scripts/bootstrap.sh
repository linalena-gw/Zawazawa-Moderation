#!/bin/sh
# macOS entry point. Only explicit --prepare may download or modify the runtime.
set -eu
umask 077
fail() { printf '%s\n' "$*" >&2; exit 1; }
mode=${1-}
case "$mode" in
  ''|--prepare|--print-root|--print-node) [ "$#" -le 1 ] || fail 'Only one bootstrap option is allowed.' ;;
  --run-script)
    [ "$#" -ge 2 ] && [ "$#" -le 3 ] || fail 'Usage: bootstrap.sh --run-script auth|diagnose|register|unregister [group]'
    case "$2" in auth|diagnose|register|unregister) ;; *) fail 'Unsupported utility script.' ;; esac
    if [ "$#" = 3 ] && [ "$2" != auth ]; then fail 'Only auth accepts a group argument.'; fi ;;
  *) fail 'Usage: bootstrap.sh [--prepare|--print-root|--print-node|--run-script auth|diagnose|register|unregister [group]]' ;;
esac
[ "$(/usr/bin/uname -s)" = Darwin ] || fail 'This entry point requires macOS.'
script_dir=$(CDPATH='' cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
source_root=$(CDPATH='' cd -- "$script_dir/.." && pwd -P)
# Resolve existing ancestors, including symlinks, without creating directories.
canonical() {
  candidate=$1
  suffix=''
  while [ ! -d "$candidate" ]; do
    [ ! -e "$candidate" ] || return 1
    part=${candidate##*/}
    suffix="/$part$suffix"
    candidate=${candidate%/*}
    [ -n "$candidate" ] || candidate=/
  done
  ancestor=$(CDPATH='' cd -- "$candidate" && pwd -P) || return 1
  printf '%s%s\n' "${ancestor%/}" "$suffix"
}
base=${ZAWAZAWA_HOME_DIR:-"$HOME/Library/Application Support/ZAWAZAWA Moderation Review"}
case "$base" in /*) ;; *) fail 'ZAWAZAWA_HOME_DIR must be absolute.' ;; esac
# Reject traversal before canonicalizing missing ancestors.
case "/$base/" in */../*|*/./*) fail 'ZAWAZAWA_HOME_DIR must not contain dot path segments.' ;; esac
base=$(canonical "$base") || fail 'Cannot resolve ZAWAZAWA_HOME_DIR.'
case "$base/" in "$source_root/"*|*/plugins/cache/*|/) fail 'ZAWAZAWA_HOME_DIR must be outside the plugin/cache tree.' ;; esac
export ZAWAZAWA_HOME_DIR="$base"
export ZAWAZAWA_RUNTIME_DIR="$base/runtimes"
export PLAYWRIGHT_BROWSERS_PATH="$base/browsers"
arch=$(/usr/bin/uname -m)
# A shell running under Rosetta still installs the native Apple Silicon build.
if [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || :)" = 1 ]; then arch=arm64; fi
case "$arch" in arm64) ;; x86_64) arch=x64 ;; *) fail 'Unsupported macOS architecture.' ;; esac
version=$(/usr/bin/plutil -extract version raw -o - "$script_dir/node-release.json")
checksum=$(/usr/bin/plutil -extract "darwin-$arch" raw -o - "$script_dir/node-release.json")
case "$version" in 24.21.0) ;; *) fail 'Unsupported pinned Node version.' ;; esac
[ "${#checksum}" = 64 ] || fail 'Invalid Node checksum.'
name="node-v$version-darwin-$arch"
target="$base/node/v$version-darwin-$arch"
node="$target/bin/node"
npm_cli="$target/lib/node_modules/npm/bin/npm-cli.js"
ready() { [ -f "$node" ] && [ -x "$node" ] && [ -f "$npm_cli" ] && [ "$("$node" --version 2>/dev/null)" = "v$version" ]; }
lock=''
staging=''
cleanup() {
  [ -z "$staging" ] || /bin/rm -rf -- "$staging"
  [ -z "$lock" ] || /bin/rm -rf -- "$lock"
}
if [ "$mode" = --prepare ] && ! ready; then
  /bin/mkdir -p -- "$base/node"
  lock_path="$target.prepare-lock"
  attempts=0
  acquired=false
  while :; do
    if /bin/mkdir -- "$lock_path" 2>/dev/null; then acquired=true; break; fi
    if ready; then break; fi
    owner=$( /bin/cat "$lock_path/pid" 2>/dev/null || : )
    reclaim=false
    case "$owner" in
      ''|*[!0-9]*|0*)
        # An interrupted mkdir/PID publication can leave a malformed lock.
        lock_before=$(/usr/bin/stat -f '%i:%m' "$lock_path" 2>/dev/null || :)
        lock_time=${lock_before##*:}
        now=$(/bin/date +%s)
        case "$lock_time" in ''|*[!0-9]*) ;; *)
          if [ "$((now - lock_time))" -gt 5 ]; then
            owner_after=$(/bin/cat "$lock_path/pid" 2>/dev/null || :)
            lock_after=$(/usr/bin/stat -f '%i:%m' "$lock_path" 2>/dev/null || :)
            if [ "$owner" = "$owner_after" ] && [ "$lock_before" = "$lock_after" ]; then reclaim=true; fi
          fi ;;
        esac ;;
      *) if ! kill -0 "$owner" 2>/dev/null; then reclaim=true; fi ;;
    esac
    if [ "$reclaim" = true ]; then
      # Rename the old directory before cleanup rather than deleting the lock path.
      reclaimed="$lock_path.abandoned.$$"
      if /bin/mv -- "$lock_path" "$reclaimed" 2>/dev/null; then /bin/rm -rf -- "$reclaimed"; fi
    fi
    attempts=$((attempts + 1))
    [ "$attempts" -lt 60 ] || fail 'Node preparation is busy; retry after the current preparation finishes.'
    /bin/sleep 1
  done
  if ! ready; then
    lock=$lock_path
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    printf '%s\n' "$$" > "$lock/pid"
    staging=$(/usr/bin/mktemp -d "$base/node/.node-staging.XXXXXXXX")
    archive="$staging/$name.tar.gz"
    printf 'Downloading official Node.js v%s (%s).\n' "$version" "$arch" >&2
    /usr/bin/curl --fail --location --proto '=https' --tlsv1.2 --output "$archive" "https://nodejs.org/dist/v$version/$name.tar.gz" >&2
    actual=$(/usr/bin/shasum -a 256 "$archive")
    actual=${actual%% *}
    [ "$actual" = "$checksum" ] || fail 'Official Node archive checksum mismatch.'
    /bin/mkdir "$staging/content"
    /usr/bin/tar -xzf "$archive" --strip-components=1 -C "$staging/content"
    [ -f "$staging/content/lib/node_modules/npm/bin/npm-cli.js" ] || fail 'Bundled npm is missing.'
    [ "$("$staging/content/bin/node" --version)" = "v$version" ] || fail 'Prepared Node version mismatch.'
    # The lock protects repair of an incomplete or damaged prior installation.
    if [ -e "$target" ]; then /bin/mv -- "$target" "$staging/previous"; fi
    /bin/mv -- "$staging/content" "$target"
    cleanup
    staging=''
    lock=''
    trap - EXIT INT TERM
  else
    # This process may have acquired the directory after another owner finished.
    # Remove it only if it is empty; never remove a live owner's lock.
    if [ "$acquired" = true ]; then /bin/rmdir -- "$lock_path" 2>/dev/null || :; fi
  fi
fi
ready || fail 'Dedicated Node is not prepared. Run the setup skill with explicit runtime preparation.'
case "$mode" in
  --prepare) exec "$node" "$script_dir/runtime-launcher.mjs" --prepare --npm-cli "$npm_cli" ;;
  --print-node) printf '%s\n' "$node" ;;
  --print-root) exec "$node" "$script_dir/runtime-launcher.mjs" --print-root ;;
  --run-script) exec "$node" "$script_dir/runtime-launcher.mjs" "$@" ;;
  '') exec "$node" "$script_dir/runtime-launcher.mjs" ;;
esac
