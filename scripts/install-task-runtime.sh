#!/bin/bash
# Build the task runtime and install it, with its own Node, at DEST
# (default build/task-runtime). scripts/bundle-app.sh installs it into
# 2ndscreen.app/Contents/Resources/task-runtime, where `2ndscreen task`
# finds it; any other DEST is used through SECONDSCREEN_TASK_RUNTIME=DEST.
#
#   install-task-runtime.sh [DEST] [--generic]
#
# --generic installs the generic runtime (packages/task-runtime/scripts/build.mjs
# --generic): no business module and no skills directory, for a product that
# carries no business package. Without it the legacy runtime with the BOSS
# workflow and the skills is installed, as 2ndscreen.app ships it.
#
#   DEST/bin/node      the pinned Node (scripts/fetch-node.sh), with its license
#   DEST/main.mjs      `2ndscreen task …`
#   DEST/worker.mjs    the background worker
#   DEST/skills/       the skills (task.json, profiles, procedures, SKILL.md); legacy only
#   DEST/build.json    every built file with its sha256
#
# Dependencies come from packages/task-runtime/package-lock.json through
# `npm ci`, run by the pinned Node's own npm; nothing global is used. The
# result is checked before it replaces what was at DEST.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
VARIANT=()
DEST=""
for arg in "$@"; do
    case "$arg" in
        --generic|--legacy)
            # One variant only; a second flag is refused here, before anything is fetched or built.
            if [[ ${#VARIANT[@]} -gt 0 && "${VARIANT[0]}" != "$arg" ]]; then
                echo "error: ${VARIANT[0]} and $arg exclude each other" >&2
                exit 2
            fi
            VARIANT=("$arg") ;;
        --*) echo "error: unknown option $arg" >&2; exit 2 ;;
        *) DEST="$arg" ;;
    esac
done
DEST="${DEST:-$ROOT/build/task-runtime}"
case "$DEST" in /*) ;; *) DEST="$PWD/$DEST" ;; esac
PKG="$ROOT/packages/task-runtime"

NODE_DIR="$("$ROOT/scripts/fetch-node.sh")"
NODE="$NODE_DIR/bin/node"
NPM_CLI="$NODE_DIR/lib/node_modules/npm/bin/npm-cli.js"
# esbuild's install script and npm's lifecycle scripts look for node on the PATH: give them this one.
export PATH="$NODE_DIR/bin:/usr/bin:/bin:/usr/sbin:/sbin"

(cd "$PKG" && "$NODE" "$NPM_CLI" ci --no-audit --no-fund --loglevel=error)

STAGE="$(mktemp -d "$(dirname "$DEST")/.task-runtime.XXXXXX" 2>/dev/null || { mkdir -p "$(dirname "$DEST")"; mktemp -d "$(dirname "$DEST")/.task-runtime.XXXXXX"; })"
trap 'rm -rf "$STAGE"' EXIT
"$NODE" "$PKG/scripts/build.mjs" "$STAGE/task-runtime" "${VARIANT[@]}" >/dev/null
mkdir -p "$STAGE/task-runtime/bin"
cp "$NODE" "$STAGE/task-runtime/bin/node"
cp "$NODE_DIR/LICENSE" "$STAGE/task-runtime/bin/node.LICENSE"

# The install must answer on its own Node before it replaces anything.
HELP="$("$STAGE/task-runtime/bin/node" --disable-warning=ExperimentalWarning "$STAGE/task-runtime/main.mjs" --help)"
[[ "$HELP" == '{"ok":true,"command":"help"'* ]] || { echo "error: the built runtime did not answer --help: $HELP" >&2; exit 1; }

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
mv "$STAGE/task-runtime" "$DEST"
echo "installed the $(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["variant"])' "$DEST/build.json") task runtime (node $("$DEST/bin/node" --version)) at $DEST"
