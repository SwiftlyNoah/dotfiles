#!/usr/bin/env bash
# Applies this repo to the Mac. Run it after every change; bootstrap.sh runs it for the
# very first switch too.
set -euo pipefail
# The shells' umask is 077 (home.nix, envExtra), and sudo keeps the stricter of it and its own
# 022: the switch writes system files every user must read, so it runs with 022.
umask 022

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
HOST="mac" # darwinConfigurations.<HOST> in flake.nix

# Run as your normal user: the sudo below elevates only the switch. Under sudo, ~ would
# be root's home and the ~/.dotfiles link would land there.
if [ "$(id -u)" -eq 0 ]; then
  echo "Do not run rebuild.sh with sudo. Run it as your normal user; it calls sudo itself." >&2
  exit 1
fi

# Without a terminal (an agent's shell, a script), sudo can't ask for Touch ID or a password,
# so the switch would fail. Then this runs itself in a new WezTerm window, where sudo can ask,
# and waits: its output shows here as it happens, and its exit code is this one's. The window
# closes once the switch succeeds and stays open when it fails, to read why.
WEZTERM=/Applications/WezTerm.app/Contents/MacOS/wezterm
if [ ! -t 0 ] && [ -z "${REBUILD_IN_WEZTERM:-}" ] && [ -x "$WEZTERM" ]; then
  run="$(mktemp -d -t rebuild)"
  : >"$run/log"
  inner="cd $(printf %q "$DIR") && { REBUILD_IN_WEZTERM=1 ./rebuild.sh 2>&1 | tee -a $(printf %q "$run/log"); code=\${PIPESTATUS[0]}; }
echo \$code >$(printf %q "$run/exit.tmp") && mv $(printf %q "$run/exit.tmp") $(printf %q "$run/exit")
if [ \$code -eq 0 ]; then echo; echo 'Done. This window closes in 5 seconds.'; sleep 5
else echo; echo \"rebuild.sh failed (exit \$code). Press return to close.\"; read -r _; fi"
  echo "rebuild.sh: no terminal here, so it runs in a new WezTerm window. Approve sudo there (Touch ID)." >&2
  # Into the running WezTerm when there is one, or a new one.
  if ! "$WEZTERM" cli spawn --new-window -- /bin/bash -c "$inner" >/dev/null 2>&1; then
    nohup "$WEZTERM" start --always-new-process -- /bin/bash -c "$inner" >/dev/null 2>&1 &
  fi
  tail -n +1 -f "$run/log" &
  tailer=$!
  # Up to an hour: long enough for a first build, and for me to get to the Touch ID prompt.
  for _ in $(seq 3600); do [ -f "$run/exit" ] && break; sleep 1; done
  sleep 1
  kill "$tailer" 2>/dev/null || true
  if [ ! -f "$run/exit" ]; then
    echo "rebuild.sh: the WezTerm window did not finish within an hour; its output is in $run/log" >&2
    exit 1
  fi
  code="$(cat "$run/exit")"
  rm -rf "$run"
  exit "$code"
fi

# home.nix links live config (Neovim, WezTerm, herdr, Claude) through ~/.dotfiles. If that
# path were a real directory, ln would put the link inside it, and every one of those
# links would dangle without the build noticing.
if [ -e ~/.dotfiles ] && [ ! -L ~/.dotfiles ]; then
  echo "$HOME/.dotfiles exists and is not a symlink. Move it aside, then run this again." >&2
  exit 1
fi
ln -sfn "$DIR" ~/.dotfiles

# Some tools build against the full Xcode app. Until it's installed (a new Mac), apply the
# configuration without them, so one missing app can't stop the whole switch.
if [ ! -d /Applications/Xcode.app ] && ! ls -d /Applications/Xcode-*.app >/dev/null 2>&1; then
  echo "Xcode isn't installed yet, so this leaves out the tools that need it (idb-companion)." >&2
  echo "Install Xcode with the Xcodes app, then run ./rebuild.sh again to add them." >&2
  HOST="$HOST-without-xcode"
fi

# "path:" rather than a git flake ref: nix-darwin runs the switch as root, and git refuses
# a repo owned by another user ("repository path ... is not owned by current user").
# A side effect: untracked files are part of the build.
FLAKE="path:$DIR#$HOST"

# sudo resets PATH, so resolve each command to an absolute path first.
if DARWIN_REBUILD="$(command -v darwin-rebuild)"; then
  exec sudo "$DARWIN_REBUILD" switch --flake "$FLAKE"
fi

# First switch: darwin-rebuild isn't installed yet. Run the one this flake.lock pins.
NIX="$(command -v nix)"
exec sudo "$NIX" run --inputs-from "path:$DIR" nix-darwin#darwin-rebuild -- switch --flake "$FLAKE"
