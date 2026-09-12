#!/usr/bin/env bash
#
# Install Chrome Bridge as an agent skill.
#
# Copies the runtime pieces (bridge server, CLI, extension, tools, tests) plus SKILL.md
# into a skill directory, so an AI agent can discover and use it.
#
#   ./install.sh                          # → ~/.workbuddy-ai/skills/chrome-bridge/
#   ./install.sh /path/to/skills/foo      # → custom location
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-$HOME/.workbuddy-ai/skills/chrome-bridge}"

# Refuse obviously wrong targets before any rm -rf runs.
case "$DEST" in
  /|/Users|/home|"$HOME"|"$HOME"/*/..*)
    echo "Refusing to install into '$DEST' — pick a subdirectory." >&2
    exit 1
    ;;
esac
if [ "$DEST" = "$HERE" ]; then
  echo "Target is the source directory; nothing to do." >&2
  exit 1
fi

echo "Source: $HERE"
echo "Target: $DEST"

mkdir -p "$DEST"
rm -rf "$DEST/scripts" "$DEST/extension" "$DEST/tools" "$DEST/tests"
mkdir -p "$DEST/scripts" "$DEST/extension" "$DEST/tools" "$DEST/tests/fixtures"

cp "$HERE/server/bridge.mjs"  "$DEST/scripts/"
cp "$HERE/server/ws-lite.mjs" "$DEST/scripts/"
cp "$HERE/cli/cb.mjs"         "$DEST/scripts/"
cp "$HERE/extension/"*        "$DEST/extension/"
cp "$HERE/tools/"*.mjs        "$DEST/tools/"
cp "$HERE/tests/"*.mjs        "$DEST/tests/"
cp "$HERE/tests/fixtures/"*   "$DEST/tests/fixtures/"
cp "$HERE/skill/SKILL.md"     "$DEST/SKILL.md"
cp "$HERE/start-bridge.sh"    "$DEST/"

chmod +x "$DEST/scripts/cb.mjs" "$DEST/start-bridge.sh"

cat <<EOF

Done. Next steps:

  1) Start the bridge:
       $DEST/start-bridge.sh

  2) Load the extension in Chrome (one-time, manual):
       chrome://extensions  →  Developer mode  →  Load unpacked
       Select:  $DEST/extension

  3) Verify:
       node $DEST/scripts/cb.mjs health

EOF
