#!/bin/bash
# M1 spike runner. Launches `claude` in a throwaway sandbox project with the
# logging hooks and status line attached through --settings, so the user's own
# ~/.claude/settings.json is never edited.
#
# Usage: CARWASH_SANDBOX=<dir> run.sh <spike-name> [claude args...]
# Output lands in $CARWASH_SANDBOX/out/<spike-name>/.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
sandbox="${CARWASH_SANDBOX:?set CARWASH_SANDBOX to a throwaway directory}"
name="${1:?spike name}"
shift

proj="$sandbox/proj"
out="$sandbox/out/$name"
mkdir -p "$proj" "$out"
[ -d "$proj/.git" ] || git -C "$proj" init -q -b main

node -e '
const [here, out, refresh] = process.argv.slice(1);
const cmd = `node ${here}/log-hook.mjs ${out}/hooks.ndjson ${out}/behavior.json`;
const events = ["SessionStart", "SessionEnd", "Stop", "UserPromptSubmit", "UserPromptExpansion"];
const settings = {
  hooks: Object.fromEntries(events.map((e) => [e, [{ hooks: [{ type: "command", command: cmd }] }]])),
  statusLine: { type: "command", command: `node ${here}/statusline.mjs ${out}/status.ndjson` },
};
if (refresh) settings.statusLine.refreshInterval = Number(refresh);
require("fs").writeFileSync(`${out}/settings.json`, JSON.stringify(settings, null, 2));
' "$here" "$out" "${CARWASH_SPIKE_REFRESH:-}"

cd "$proj"
# Drop the variables a parent Claude Code session exports, so the spike behaves
# like a session started from a plain shell.
exec env \
  -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_PID \
  -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_ENTRYPOINT \
  -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_EFFORT -u CLAUDE_CODE_EXECPATH \
  ${CARWASH_SPIKE_CLAUDE:-claude} --settings "$out/settings.json" "$@"
