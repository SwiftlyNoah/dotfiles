#!/bin/sh
# Claude Code's status line, in Rosé Pine Moon: model · account · context.
#
#   Opus 5.5 · noah · ctx ━━━━━━──────── 42%
#
# The account (claude-pool sets CLAUDE_POOL_ACCOUNT; "login" is my own seat) is iris
# on my seat and gold on a teammate's, where Claude in Chrome and the connectors are off.
# ctx is how full this conversation's context window is: foam, then gold past half, then
# rose past 80%. Account usage lives in claude-pool's menu bar app, not here. The pool
# runs this with Claude Code's input (claude-pool records usage first, then calls it).

input=$(cat)
model=$(printf '%s' "$input" | jq -r '.model.display_name // empty')
used=$(printf '%s' "$input" | jq -r '.context_window.used_percentage // empty')

rgb() { printf '\033[38;2;%d;%d;%dm' "$1" "$2" "$3"; }
subtle=$(rgb 144 140 170)   # #908caa
track=$(rgb 86 82 110)      # #56526e (highlight high), the bar's empty part: visible on the translucent window
iris=$(rgb 196 167 231)     # #c4a7e7
gold=$(rgb 246 193 119)     # #f6c177
foam=$(rgb 156 207 216)     # #9ccfd8
rose=$(rgb 235 111 146)     # #eb6f92
reset=$(printf '\033[0m')

line="${subtle}${model}${reset}"

account=${CLAUDE_POOL_ACCOUNT:-}
if [ -n "$account" ]; then
  if [ "$account" = login ]; then
    me=$(cat "$HOME/.config/claude-pool/me" 2>/dev/null)
    line="$line ${subtle}·${reset} ${iris}${me:-me}${reset}"
  else
    line="$line ${subtle}·${reset} ${gold}${account}${reset}"
  fi
fi

if [ -n "$used" ]; then
  pct=$(printf '%.0f' "$used")
  width=14
  filled=$((pct * width / 100))
  [ "$filled" -gt "$width" ] && filled=$width
  [ "$pct" -gt 0 ] && [ "$filled" -eq 0 ] && filled=1 # a sliver as soon as anything is used
  if [ "$pct" -ge 80 ]; then color=$rose; elif [ "$pct" -ge 50 ]; then color=$gold; else color=$foam; fi
  bar="" i=0
  while [ $i -lt $width ]; do
    if [ $i -lt "$filled" ]; then bar="$bar${color}━"; else bar="$bar${track}─"; fi
    i=$((i + 1))
  done
  line="$line ${subtle}· ctx${reset} ${bar}${reset} ${subtle}${pct}%${reset}"
fi

printf '%s' "$line"
