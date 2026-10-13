#!/bin/bash
# Live check runner. Installs the working tree into a sandbox config folder
# with the real installer, then starts `claude` in a throwaway project with
# that settings file attached through --settings. The user's own
# ~/.claude/settings.json and ~/.carwash are never touched.
#
# Usage: CARWASH_SANDBOX=<dir> live.sh [claude args...]
# For a scripted session, run it under pty-drive.py.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
sandbox="${CARWASH_SANDBOX:?set CARWASH_SANDBOX to a throwaway directory}"
proj="$sandbox/proj"
mkdir -p "$proj"
[ -d "$proj/.git" ] || git -C "$proj" init -q -b main

# Reinstall every time, so the sandbox always runs the current working tree.
CARWASH_HOME="$sandbox/home" CLAUDE_CONFIG_DIR="$sandbox/config" \
  node "$here/../bin/carwash.mjs" install --yes > "$sandbox/install.log"

# --settings carries the hooks and the status line but not skills, so /wash
# goes in as a project skill.
mkdir -p "$proj/.claude/skills/wash"
cp "$sandbox/config/skills/wash/SKILL.md" "$proj/.claude/skills/wash/SKILL.md"

cd "$proj"
# Drop the variables a parent Claude Code session exports, so the run behaves
# like a session started from a plain shell.
exec env \
  -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_PID \
  -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_ENTRYPOINT \
  -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_EFFORT -u CLAUDE_CODE_EXECPATH \
  CARWASH_HOME="$sandbox/home" \
  ${CARWASH_SPIKE_CLAUDE:-claude} --settings "$sandbox/config/settings.json" "$@"
