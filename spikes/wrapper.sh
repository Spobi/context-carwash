# M1 spike: prototype of the one-step shell function, for bash and zsh.
# Source it, then use `claude` as usual. `command claude` bypasses it.
#
# The function runs the real binary with inherited stdio. If a relaunch marker
# for this invocation exists when the binary exits, it starts a fresh session
# in the same terminal with the original flags and the pending brief's id.

_carwash_real() { command claude "$@"; }

claude() {
  local wrap_id="$$-$RANDOM"
  local marker="${CARWASH_HOME:-$HOME/.carwash}/relaunch/$wrap_id"
  local -a replay
  replay=()

  # Replay the original flags minus the ones that pick a session.
  # Known gap: a positional prompt (`claude "fix the bug"`) is replayed too.
  local arg skip_value=""
  for arg in "$@"; do
    if [ -n "$skip_value" ]; then
      skip_value=""
      case "$arg" in
        -*) ;;
        *) continue ;;
      esac
    fi
    case "$arg" in
      -c | --continue | --fork-session) ;;
      -r | --resume | --session-id | --from-pr | --teleport) skip_value=1 ;;
      --resume=* | --session-id=* | --from-pr=* | --teleport=*) ;;
      *) replay+=("$arg") ;;
    esac
  done

  CARWASH_WRAPPED="$wrap_id" _carwash_real "$@"
  local rc=$?
  local pending
  while [ -f "$marker" ]; do
    pending="$(cat "$marker")"
    rm -f "$marker"
    CARWASH_WRAPPED="$wrap_id" CARWASH_PENDING="$pending" _carwash_real "${replay[@]}"
    rc=$?
  done
  return $rc
}
