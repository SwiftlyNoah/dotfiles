# The shared browsers, sourced by home/bin/agent-browser-chrome and agent-browser-mcp.
#
# Each is its own Chrome, with its own profile and debugging port, so what one is signed in
# to never reaches agents driving the other. They are listed under "browsers" in your local
# config (home/lib/local-config.zsh): an id, the name of its launcher app, its port, and
# optionally "folders", whose sessions use it. "defaultBrowser" (main if unset) takes every
# other session.
#
# The debugging ports listen on 127.0.0.1 only and have no authentication, so any program
# running on this Mac could drive these profiles. That is the accepted price of a browser
# shared by every session.
#
# Optional, per browser, in ~/.config/agent-browser/<name>/ (outside this repo):
#   theme-color   one hex line (#RRGGBB), its Chrome color
#   icon.png      the icon of its launcher app and of the badge on its windows (1024x1024)
#   headless      present: it runs without windows or a Dock icon until I open it from its
#                 launcher (home/bin/agent-browser-mode), and goes back once I'm done
#
# Not a custom icon on Chrome itself: that takes a copy of Chrome.app (the Dock and ⌘Tab
# take the icon from the app bundle), and 1Password refuses any Chrome running from
# outside /Applications ("parent browser was not valid"), icon or not. So each browser gets
# a launcher app with its icon instead (home/bin/agent-browser-launchers).

source "${${(%):-%x}:A:h}/local-config.zsh"

# Every browser's id, main first.
agent_browser_ids() {
  local_config '.browsers[].id'
}

# Sets PORT, STATE, PROFILE, LABEL (the launchd agent that keeps its Chrome running), NAME
# (its launcher app) and CONFIG (its optional settings).
agent_browser_instance() {
  local browser=$(local_config ".browsers[] | select(.id == \"$1\") | \"\\(.port) \\(.name)\"")
  if [[ -z $browser ]]; then
    print -u2 -- "agent-browser: no browser named '$1' (${(j:, :)${(f)"$(agent_browser_ids)"}})"
    return 1
  fi
  PORT=${browser%% *} NAME=${browser#* }
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

# Whether it should run headless right now: it opts in, and I haven't opened it to look.
agent_browser_headless() {
  [[ -e $CONFIG/headless && ! -e $STATE/visible ]]
}

# The running Chrome's process ID, if any.
agent_browser_pid() {
  pgrep -f -- "MacOS/Google Chrome --user-data-dir=$PROFILE( |\$)"
}

# Quits its Chrome the way closing it would, over DevTools: Chrome saves its cookies and
# session first, which a signal doesn't wait for. A Chrome that doesn't answer is killed.
agent_browser_quit() {
  local pid=$(agent_browser_pid)
  [[ -n $pid ]] || return 0
  PATH="/etc/profiles/per-user/$USER/bin:$PATH" node --input-type=module -e '
    const v = await (await fetch(`http://127.0.0.1:${process.argv[1]}/json/version`)).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    setTimeout(() => process.exit(0), 1000);' $PORT 2>/dev/null || true
  for _ in {1..50}; do kill -0 $pid 2>/dev/null || return 0; sleep 0.2; done
  kill $pid 2>/dev/null
  while kill -0 $pid 2>/dev/null; do sleep 0.2; done
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
  agent_browser_color
  return 0
}

# The theme color, set the way Chrome's own "Customize Chrome" color picker stores it: an
# ARGB integer in the profile's Preferences (not one of the signed ones), written while
# this Chrome is not running. A Chrome policy can't do it: policies reach every Chrome on
# this Mac, mine included.
agent_browser_color() {
  [[ -f $CONFIG/theme-color ]] || return 0
  local hex=${$(<"$CONFIG/theme-color")//[[:space:]#]/}
  [[ $hex =~ '^[[:xdigit:]]{6}$' ]] || { print -u2 -- "agent-browser: $CONFIG/theme-color is not #RRGGBB"; return 0; }
  local -i argb=$(( 0xFF000000 | 16#$hex ))
  (( argb >= 2**31 )) && (( argb -= 2**32 ))
  local prefs="$PROFILE/Default/Preferences"
  mkdir -p "${prefs:h}"
  [[ -s $prefs ]] || print '{}' >"$prefs"
  jq --argjson c $argb '.browser.theme += {user_color: $c, user_color2: $c, color_variant: 1, color_variant2: 1}' \
    "$prefs" >"$prefs.new" && mv "$prefs.new" "$prefs"
}

# How each Chrome starts.
# --no-startup-window: Chrome brings itself to the front when it opens its first window,
# which would put the agents' browser over my apps every time one starts. The first window
# now comes from an agent's first page, opened in the background (see background.mjs).
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
    --no-first-run --no-default-browser-check --no-startup-window
  )
  [[ -e $CONFIG/headless ]] || return 0
  # Restarts between headless and windowed (agent-browser-mode) bring back its tabs and
  # its session cookies, which is where many single sign-ons keep a session:
  # without this, each switch would sign it out. Only for these browsers: restoring
  # windows makes a windowed Chrome come to the front every time it starts.
  # (--no-startup-window would stop the restore, and isn't needed: a headless Chrome has no
  # windows, and it only restarts windowed when I've asked to see it.)
  reply=(${reply:#--no-startup-window} --restore-last-session)
  agent_browser_headless || return 0
  # Headless, Chrome tells sites so: "HeadlessChrome" in its user agent, and an 800x600
  # screen. It gets the user agent the windowed Chrome sends (built from the installed
  # version, the way Chrome reduces it) and this Mac's main display, in device pixels with
  # the menu bar's work area, as a windowed Chrome reports them.
  local version=$(defaults read "/Applications/Google Chrome.app/Contents/Info.plist" CFBundleShortVersionString)
  # Its windows get the size a windowed Chrome would give them, nearly the whole screen:
  # headless, Chrome makes them 500x375 in a corner, and that size comes back with the
  # session when I open the browser to look at it.
  local -a display=(${(s: :)"$(osascript -l JavaScript -e 'ObjC.import("AppKit");
    const s = $.NSScreen.screens.objectAtIndex(0), f = s.frame, v = s.visibleFrame, k = s.backingScaleFactor;
    const top = f.size.height - v.size.height - v.origin.y;
    [f.size.width, f.size.height, k, top, v.size.height].join(" ")')"})
  local -i width=${display[1]} height=${display[2]} scale=${display[3]} top=${display[4]} usable=${display[5]}
  reply+=(
    --headless=new
    --user-agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version%%.*}.0.0.0 Safari/537.36"
    --screen-info="{$((width * scale))x$((height * scale)) devicePixelRatio=$scale workAreaTop=$((top * scale))}"
    --window-position=22,$((top + 23)) --window-size=$((width - 44)),$((usable - 30))
  )
}
