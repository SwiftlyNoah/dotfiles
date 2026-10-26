#!/usr/bin/env bash
# Auto-approve every permission prompt while the session is in accept-edits mode.
#
# Equivalent to holding Enter on each prompt, but decided programmatically:
# it fires only in acceptEdits mode, so shift+tab back to normal mode restores
# ordinary prompting.
#
# Wired up as a PreToolUse hook (matcher "*") in home/.claude/settings.json;
# home.nix links it to ~/.claude/hooks/auto-accept.sh.
#
# Emitting no output leaves the decision alone, and Claude Code prompts as usual.

set -uo pipefail

payload=$(cat)

mode=$(printf '%s' "$payload" | jq -r '.permission_mode // ""')
[[ $mode == "acceptEdits" ]] || exit 0

jq -nc '{hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    permissionDecisionReason: "auto-accept: accept-edits mode"
  }}'
