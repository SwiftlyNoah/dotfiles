#!/bin/sh
# Claude Code SessionStart hook: tell herdr to bring this session back with `cc`.
#
# herdr's own hook (herdr-agent-state.sh, beside this one and managed by herdr) reports the
# session, and herdr then restores the pane with plain `claude --resume <id>`. This reports
# the same session with a resume command of our own, so a restored pane comes back through
# claude-pool with the pool's saved defaults, exactly as `cc` would start it.

[ "${HERDR_ENV:-}" = "1" ] || exit 0
[ -n "${HERDR_PANE_ID:-}" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v claude-pool >/dev/null 2>&1 || exit 0

input=$(cat)
id=$(printf '%s' "$input" | jq -r '.session_id // empty')
[ -n "$id" ] || exit 0
[ -z "$(printf '%s' "$input" | jq -r '.agent_id // empty')" ] || exit 0 # subagents
path=$(printf '%s' "$input" | jq -r '.transcript_path // empty')
start=$(printf '%s' "$input" | jq -r '.source // empty')

log="$HOME/Library/Logs/herdr-cc-resume.log"
mkdir -p "$(dirname "$log")"

# herdr's hook reports at the same moment with seq = the time in nanoseconds. Reporting a
# second later, with a larger seq, makes this report the one herdr keeps. Pass along
# everything herdr's own report carries, so this one replaces it without losing anything.
(
  sleep 1
  set -- --source herdr:claude --agent claude --seq "$(date +%s)000000000" \
    --agent-session-id "$id"
  [ -n "$path" ] && set -- "$@" --agent-session-path "$path"
  [ -n "$start" ] && set -- "$@" --session-start-source "$start"
  "${HERDR_BIN_PATH:-herdr}" pane report-agent-session "$HERDR_PANE_ID" "$@" \
    -- claude-pool "$id" ||
    echo "$(date '+%F %T') pane $HERDR_PANE_ID, session $id: report failed" >>"$log"
) >/dev/null 2>>"$log" &
