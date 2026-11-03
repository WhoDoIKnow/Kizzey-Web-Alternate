#!/usr/bin/env bash
# Kizzey Web — shell entry point for the Node launcher.
#
#   ./script_pull.sh                        clone/update, install packages, start
#   ./script_pull.sh --no-pull              start the current checkout as-is
#   ./script_pull.sh --update-only          clone/update + install, then exit
#   ./script_pull.sh --host 0.0.0.0 --port 8420
#   ./script_pull.sh --no-voice             start Kizzey without the voice companion
#
# Every argument is forwarded to script_pull.js unchanged. This wrapper only
# checks that Node and npm are present, so a headless server can run one command
# without reading the launcher source first.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
launcher="$here/script_pull.js"

if [ ! -f "$launcher" ]; then
  echo "script_pull.js was not found next to $(basename "${BASH_SOURCE[0]}")." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20.18 or newer is required. Install it first: https://nodejs.org/" >&2
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
node_minor="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$node_major" -lt 20 ] || { [ "$node_major" -eq 20 ] && [ "$node_minor" -lt 18 ]; }; then
  echo "Node.js 20.18 or newer is required (found $(node -v))." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. Install it alongside Node.js." >&2
  exit 1
fi

exec node "$launcher" "$@"
