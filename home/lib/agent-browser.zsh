# The shared browsers, sourced by home/bin/agent-browser-chrome and agent-browser-mcp.
#
# Each is its own Chrome, with its own profile and debugging port, so what one is signed in
# to never reaches agents driving the other. They are listed under "browsers" in your local
# config (home/lib/local-config.zsh): an id, the name of its launcher app, its port, and
# optionally "folders", whose sessions use it, and "key", which opens it with ⌘⇧ and that key
# (home/.hammerspoon/init.lua). "defaultBrowser" (main if unset) takes every
# other session.
#
# The debugging ports listen on 127.0.0.1 only and have no authentication, so any program
# running on this Mac could drive these profiles. That is the accepted price of a browser
# shared by every session.
#
# Optional, per browser, in ~/.config/agent-browser/<name>/ (outside this repo):
#   theme-color   one hex line (#RRGGBB), its Chrome color
#   icon.png      the icon of its launcher app and of the badge on its windows (1024x1024)
#
# Each runs windowed and hidden: agents drive its tabs from behind, and opening its
# launcher (home/bin/agent-browser-mode) only unhides it, with no restart. Hammerspoon hides
# it again whenever it shows itself without my asking, and once I'm done with it. (It ran
# headless once, so it had no Dock icon, but then every look at it was a Chrome restart:
# slow, and each one gave its tabs new IDs.)
#
# Not a custom icon on Chrome itself: that takes a copy of Chrome.app (the Dock and ⌘Tab
# take the icon from the app bundle), and 1Password refuses any Chrome running from
# outside /Applications ("parent browser was not valid"), icon or not. So each browser gets
# a launcher app with its icon instead (home/bin/agent-browser-launchers).

source "${${(%):-%x}:A:h}/local-config.zsh"
readonly AGENT_BROWSER_PAGES="${${(%):-%x}:A:h}/agent-browser-mcp/own-pages.mjs"

# The node that home-manager installs: launchd and Hammerspoon start with a bare PATH.
agent_browser_node() {
  PATH="/etc/profiles/per-user/$USER/bin:$PATH" node "$@"
}

# Every browser's id, main first.
agent_browser_ids() {
  local_config '.browsers[].id'
}

# Sets ID, PORT, STATE, PROFILE, LABEL (the launchd agent that keeps its Chrome running), NAME
# (its launcher app) and CONFIG (its optional settings).
agent_browser_instance() {
  local browser=$(local_config ".browsers[] | select(.id == \"$1\") | \"\\(.port) \\(.name)\"")
  if [[ -z $browser ]]; then
    print -u2 -- "agent-browser: no browser named '$1' (${(j:, :)${(f)"$(agent_browser_ids)"}})"
    return 1
  fi
  ID=$1 PORT=${browser%% *} NAME=${browser#* }
  # main keeps the unsuffixed paths and label it had before there were others.
  STATE="$HOME/.local/share/agent-browser${${1:#main}:+-$1}"
  PROFILE="$STATE/profile"
  LABEL="org.nix-community.home.agent-browser-chrome${${1:#main}:+-$1}"
  CONFIG="$HOME/.config/agent-browser/$1"
  return 0
}

# The browser for a folder: the one with a "folders" entry holding it, or the default.
agent_browser_for() {
  local id folder
  for id folder in ${(f)"$(local_config '.browsers[] | .id as $id | (.folders // [])[] | $id, .')"}; do
    [[ ${1:A}/ == ${$(local_path $folder):A}/* ]] && { print -r -- $id; return; }
  done
  print -r -- "$(local_config '.defaultBrowser // "main"')"
}

# The running Chrome's process ID, if any.
agent_browser_pid() {
  pgrep -f -- "MacOS/Google Chrome --user-data-dir=$PROFILE( |\$)"
}

# Quits its Chrome the way closing it would, over DevTools: Chrome saves its cookies and
# session first, which a signal doesn't wait for (a SIGTERM loses every cookie it hasn't
# written yet, sign-ins included). Its shutdown waits on the macOS keychain, which takes
# from under a second to well over ten when the Mac is busy, so it gets 30 seconds. Every
# step has a time limit, so a Chrome that is stuck can't leave the caller stuck with it:
# one that doesn't finish gets a SIGTERM, and one that ignores that too is killed. Returns
# once all of its processes are gone, so the next Chrome can take the profile.
agent_browser_quit() {
  local pid=$(agent_browser_pid)
  [[ -n $pid ]] || return 0
  # This Chrome's processes, taken now: once they are gone, home/bin/agent-browser-chrome
  # starts the next Chrome right away, on the same profile, which must be left alone.
  local -a pids=(${(f)"$(pgrep -f -- "--user-data-dir=$PROFILE( |\$)")"})
  local -a left
  PATH="/etc/profiles/per-user/$USER/bin:$PATH" node --input-type=module -e '
    setTimeout(() => process.exit(0), 3000);
    const v = await (await fetch(`http://127.0.0.1:${process.argv[1]}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    ws.onmessage = ws.onclose = () => process.exit(0);' $PORT 2>/dev/null || true
  for _ in {1..150}; do kill -0 $pid 2>/dev/null || break; sleep 0.2; done
  if kill -0 $pid 2>/dev/null; then
    print -u2 -- "agent-browser: Chrome $pid did not quit; terminating it"
    kill -TERM $pid 2>/dev/null
    for _ in {1..25}; do kill -0 $pid 2>/dev/null || break; sleep 0.2; done
    kill -KILL $pid 2>/dev/null
  fi
  # Its helpers (renderers, GPU) can outlive it for a moment, and hold the profile open.
  local p
  for _ in {1..25}; do
    left=()
    for p in $pids; do kill -0 $p 2>/dev/null && left+=($p); done
    (( $#left )) || return 0
    sleep 0.2
  done
  kill -KILL $left 2>/dev/null
  return 0
}

# Restarts its Chrome (for an update, say), and waits until it answers again. Each session
# keeps the tabs it opened: Chrome gives restored tabs new IDs, so they are matched up again
# from a list taken just before it quits. home/bin/agent-browser-chrome starts the new
# Chrome as soon as the old one is gone. Never while it is downloading, which a restart
# would cut off: then it says so and returns 75, for the caller to try again later.
agent_browser_restart() {
  if agent_browser_downloading; then
    print -u2 -- "agent-browser: the $ID Chrome is downloading; not restarting it now"
    return 75
  fi
  local snapshot=$(mktemp -t agent-browser)
  agent_browser_node "$AGENT_BROWSER_PAGES" snapshot "http://127.0.0.1:$PORT" >$snapshot 2>/dev/null || true
  agent_browser_quit
  if ! agent_browser_wait_up 30; then
    # Its launchd agent isn't the one that relaunches by itself (before a rebuild has
    # loaded it, say): start it now rather than after launchd's restart delay.
    launchctl kickstart -k "gui/$UID/$LABEL" 2>/dev/null || true
    agent_browser_wait_up 30 || { print -u2 -- "agent-browser: Chrome did not come back on port $PORT"; rm -f $snapshot; return 1; }
  fi
  agent_browser_node "$AGENT_BROWSER_PAGES" remap "http://127.0.0.1:$PORT" $snapshot || true
  rm -f $snapshot
}

# Whether its Chrome is downloading: it holds a file it is still writing (.crdownload) open.
agent_browser_downloading() {
  local pid=$(agent_browser_pid)
  [[ -n $pid ]] && lsof -p $pid -Fn 2>/dev/null | grep -q '\.crdownload$'
}

# Waits up to $1 seconds for its DevTools port to answer.
agent_browser_wait_up() {
  local -i tries=$(( $1 * 5 ))
  while (( tries-- > 0 )); do
    curl -fsS --max-time 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  return 1
}

# Brings this Chrome, and only this one, in front of me, on the tab an agent used most
# recently (or a new tab when it has none).
agent_browser_front() {
  agent_browser_node "$AGENT_BROWSER_PAGES" front "http://127.0.0.1:$PORT" || true
  agent_browser_app show
}

# Shows (unhides and brings in front) or hides its Chrome, the way the app's own menu
# would; other Chromes, mine included, are untouched. Hammerspoon does it (AgentBrowsers in
# home/.hammerspoon/init.lua): macOS lets only the app in front, or one with Hammerspoon's
# permissions, bring another app forward. It also records whether I have it open.
agent_browser_app() {
  /Applications/Hammerspoon.app/Contents/Frameworks/hs/hs -q -t 5 -c "AgentBrowsers.$1('$ID')" >/dev/null && return 0
  print -u2 -- "agent-browser: can't $1 the $ID browser: Hammerspoon isn't answering"
  return 1
}

# Whether this instance's Chrome is running. The trailing space or end keeps "agent-browser"
# from matching another browser's "agent-browser-<id>".
agent_browser_running() {
  pgrep -qf -- "--user-data-dir=$PROFILE( |\$)"
}

# Readies the profile before its Chrome starts. Safe to run every time.
agent_browser_prepare() {
  mkdir -p "$PROFILE/NativeMessagingHosts"
  # The profile holds signed-in sessions: readable by this user only, and kept out of Time
  # Machine (signing in again beats restoring live cookies from a backup disk).
  chmod 700 "$STATE" "$PROFILE"
  tmutil isexcluded "$STATE" | grep -q '\[Excluded\]' || tmutil addexclusion "$STATE"
  # With its own --user-data-dir, Chrome looks for native messaging hosts in
  # $PROFILE/NativeMessagingHosts, not the default profile's folder. Without 1Password's,
  # its extension can't reach the app: no unlock, no Touch ID, no autofill. A link follows
  # the app's own updates to the manifest.
  local hosts="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  [[ -e $hosts/com.1password.1password.json ]] &&
    ln -sf "$hosts/com.1password.1password.json" "$PROFILE/NativeMessagingHosts/"
  # Left by an earlier try at custom icons.
  rm -rf "$STATE/Google Chrome.app" "$STATE/.app-stamp"
  agent_browser_preferences
  return 0
}

# Settings Chrome keeps in the profile's Preferences (not among the signed ones), written
# while this Chrome is not running:
# - Its last exit counts as clean. After one that wasn't (a crash, a kill), Chrome asks
#   "Restore pages?" instead of restoring, in a bubble no one sees on a hidden window, and
#   saves no session while it waits for an answer: then every later restart loses the
#   tabs, and comes back asking again. Here a restart always restores (--restore-last-
#   session), whatever the last exit was.
# - The theme color, if it has one: set the way Chrome's own "Customize Chrome" color
#   picker stores it, an ARGB integer. A Chrome policy can't do it: policies reach every
#   Chrome on this Mac, mine included.
agent_browser_preferences() {
  local prefs="$PROFILE/Default/Preferences" theme='{}'
  mkdir -p "${prefs:h}"
  [[ -s $prefs ]] || print '{}' >"$prefs"
  if [[ -f $CONFIG/theme-color ]]; then
    local hex=${$(<"$CONFIG/theme-color")//[[:space:]#]/}
    if [[ $hex =~ '^[[:xdigit:]]{6}$' ]]; then
      local -i argb=$(( 0xFF000000 | 16#$hex ))
      (( argb >= 2**31 )) && (( argb -= 2**32 ))
      theme="{\"user_color\": $argb, \"user_color2\": $argb, \"color_variant\": 1, \"color_variant2\": 1}"
    else
      print -u2 -- "agent-browser: $CONFIG/theme-color is not #RRGGBB"
    fi
  fi
  jq --argjson theme "$theme" '.profile += {exit_type: "Normal", exited_cleanly: true} | .browser.theme += $theme' \
    "$prefs" >"$prefs.new" && mv "$prefs.new" "$prefs"
}

# How each Chrome starts.
# --restore-last-session: a Chrome that restarts (an update, a crash) brings back its tabs
# and its session cookies, which is where many single sign-ons keep a session. Its windows
# come back too, which Hammerspoon hides again.
# ForceForegroundPriorityForAllTabs: Chrome drops a hidden tab's renderer to background
# priority, which an M1 Pro runs only on its two efficiency cores. When the Mac is busy,
# those renderers wait a minute or more to answer, and chrome-devtools-mcp, which attaches
# to every tab as it connects, times out. Here every tab is hidden: agents drive them
# from behind.
agent_browser_args() {
  reply=(
    --user-data-dir="$PROFILE"
    --remote-debugging-port=$PORT --remote-debugging-address=127.0.0.1
    --enable-features=ForceForegroundPriorityForAllTabs
    --no-first-run --no-default-browser-check --restore-last-session
  )
}
