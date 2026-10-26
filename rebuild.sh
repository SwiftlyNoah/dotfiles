#!/usr/bin/env bash
# Applies this repo to the Mac. Run it after every change; bootstrap.sh runs it for the
# very first switch too.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
HOST="mac" # darwinConfigurations.<HOST> in flake.nix

# Run as your normal user: the sudo below elevates only the switch. Under sudo, ~ would
# be root's home and the ~/.dotfiles link would land there.
if [ "$(id -u)" -eq 0 ]; then
  echo "Do not run rebuild.sh with sudo. Run it as your normal user; it calls sudo itself." >&2
  exit 1
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
