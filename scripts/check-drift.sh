#!/usr/bin/env bash
# The instruction doc embeds reference/bellhop.ts between BEGIN/END markers.
# Fail when the embedded copy drifts from the reference.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOC="$ROOT/connectors/fleet--bellhop.md"
REF="$ROOT/reference/bellhop.ts"

EMBEDDED=$(awk '/<!-- BEGIN bellhop.ts -->/{flag=1;next}/<!-- END bellhop.ts -->/{flag=0}flag' "$DOC" \
  | sed -e '1{' -e '/^```/d' -e '}' | sed -e '${' -e '/^```/d' -e '}')
if [ -z "$EMBEDDED" ]; then
  echo "FAIL: no embedded source found in $DOC"
  exit 1
fi
if ! diff <(printf '%s\n' "$EMBEDDED") "$REF" 1>/dev/null; then
  echo "FAIL: connectors/fleet--bellhop.md drifted from reference/bellhop.ts"
  echo "Re-embed: update the doc's code block from the reference file."
  exit 1
fi
echo "ok: doc matches reference"
