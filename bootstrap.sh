#!/usr/bin/env bash
# Takes a fresh Mac from nothing to this configuration. Safe to run again.
# After it finishes, use ./rebuild.sh for every later change.
#
# On a brand-new Mac (no git yet), run it straight from GitHub; it clones the repo itself:
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/SwiftlyNoah/dotfiles/main/bootstrap.sh)"
set -euo pipefail

readonly REPO_URL="https://github.com/SwiftlyNoah/dotfiles.git"
readonly CLONE="$HOME/github/SwiftlyNoah/dotfiles"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" && pwd -P)"

# Under sudo, whoami would say "root" (breaking step 2) and ~ would be root's home.
# This script asks for your password at the points that need root.
if [ "$(id -u)" -eq 0 ]; then
  echo "Do not run bootstrap.sh with sudo. Run it as your normal user:" >&2
  echo "    ./bootstrap.sh" >&2
  echo "It will prompt for your password when it needs root." >&2
  exit 1
fi

if xcode-select -p >/dev/null 2>&1; then
  [ -n "${BOOTSTRAP_CONTINUED:-}" ] || echo "==> 0. Xcode Command Line Tools: installed"
else
  echo "==> 0. Xcode Command Line Tools (git, and the compilers Homebrew needs)"
  # The way Homebrew's installer does it: no dialog, so it also works over SSH. This
  # file makes softwareupdate offer the tools.
  touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  label=$(softwareupdate --list 2>/dev/null |
    sed -nE 's/^[*] Label: (Command Line Tools for Xcode.*)$/\1/p' | sort -V | tail -n1)
  if [ -z "$label" ]; then
    echo "    softwareupdate offers no Command Line Tools. Run xcode-select --install, then this again." >&2
    exit 1
  fi
  sudo softwareupdate --install "$label" --verbose
  rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
fi

# Run from a clone. Started from GitHub (no repo around this script), clone and go on there.
if [ ! -f "$DIR/flake.nix" ]; then
  if [ -d "$CLONE/.git" ]; then
    # --autostash keeps local edits, such as the user line step 2 sets.
    git -C "$CLONE" pull --rebase --autostash
  else
    mkdir -p "$(dirname "$CLONE")"
    git clone "$REPO_URL" "$CLONE"
  fi
  echo "==> Continuing from $CLONE"
  BOOTSTRAP_CONTINUED=1 exec "$CLONE/bootstrap.sh"
fi

echo "==> 1. Determinate Nix"
if command -v nix >/dev/null 2>&1; then
  echo "    already installed"
else
  curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix |
    sh -s -- install --no-confirm
  # shellcheck disable=SC1091
  . /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
fi

echo "==> 2. Username in flake.nix"
REAL_USER="$(whoami)"
FLAKE_USER="$(sed -nE 's/^[[:space:]]*user = "([^"]+)";.*/\1/p' "$DIR/flake.nix" | head -n1)"
if [ -z "$FLAKE_USER" ]; then
  echo "    Could not find the \"user = \" line in flake.nix. Set it by hand, then run this again." >&2
  exit 1
elif [ "$FLAKE_USER" != "$REAL_USER" ]; then
  echo "    flake.nix is set up for \"$FLAKE_USER\", but you are \"$REAL_USER\"."
  read -r -p "    Change it to \"$REAL_USER\"? [y/N] " REPLY
  if [ "$REPLY" = "y" ] || [ "$REPLY" = "Y" ]; then
    sed -i '' -E "s/^([[:space:]]*user = \")[^\"]+(\";.*)/\1${REAL_USER}\2/" "$DIR/flake.nix"
    echo "    Done. Review it with: git diff flake.nix"
  else
    echo "    Set the \"user = \" line in flake.nix yourself, then run this again." >&2
    exit 1
  fi
else
  echo "    already \"$REAL_USER\""
fi

echo "==> 3. First switch"
"$DIR/rebuild.sh"

echo "==> 4. Claude Code"
# The official installer, not a Homebrew cask: claude updates itself in place, which a
# zap-managed cask would fight. It installs to ~/.local/bin, which the switch just put
# on PATH for new shells. This shell predates the switch, so add it here too, or the
# installer would tell you to edit ~/.zshrc (a read-only Nix store link).
export PATH="$HOME/.local/bin:$PATH"
if command -v claude >/dev/null 2>&1; then
  echo "    already installed ($(claude --version 2>/dev/null || echo 'version unknown'))"
else
  curl -fsSL https://claude.ai/install.sh | bash
fi

echo "==> 5. GitHub (this Mac's SSH key, sign-in, the signing key, and your own settings)"
if ! "$DIR/home/bin/github-setup"; then
  echo "    Not finished: fix what it reported above, then run home/bin/github-setup." >&2
fi

# Your own settings: local/, a clone of your private dotfiles-local repo if you have one
# (local.example.json shows the format). The first switch ran on the example, so a newly
# cloned one needs another to take effect.
if [ -d "$DIR/local/.git" ]; then
  git -C "$DIR/local" pull --rebase --autostash || true
  echo "    local/: up to date"
elif gh auth status >/dev/null 2>&1 &&
  LOCAL_REPO="$(gh api user --jq .login)/dotfiles-local" &&
  gh repo view "$LOCAL_REPO" >/dev/null 2>&1; then
  gh repo clone "$LOCAL_REPO" "$DIR/local"
  "$DIR/rebuild.sh"
elif [ ! -f "$DIR/local/config.json" ]; then
  echo "    local/: none, so local.example.json (copy it to local/config.json to make your own)"
fi

echo "==> 6. Claude setup (account pool, session defaults, shared browser)"
# Needs a GitHub sign-in, since the pool lives in a private repo.
if ! "$DIR/home/bin/claude-setup"; then
  echo "    Not finished: fix what it reported above, then run home/bin/claude-setup." >&2
fi

echo "==> 7. Latest versions of everything else (Homebrew, npm CLIs, Python)"
"$DIR/home/bin/mac-update" --packages

echo "==> 8. Wallpaper"
# Rendered here rather than stored, since it's a few megabytes of pixels.
if [ ! -f ~/Pictures/Wallpapers/lilac-moon-dynamic.heic ] && ! "$DIR/wallpaper/build.sh"; then
  echo "    Not finished: fix what it reported above, then run wallpaper/build.sh." >&2
fi

echo "==> 9. Screen lock"
# macOS turns the screen lock on only with your password, so no setting can do it.
if sysadminctl -screenLock status 2>&1 | grep -q immediate; then
  echo "    on"
elif [ -t 0 ]; then
  echo "    Turning it on: enter your Mac password."
  sysadminctl -screenLock immediate -password - || true
fi

# What's left needs a person: a password, a browser sign-in, or a drive plugged in.
todo=()
gh auth status >/dev/null 2>&1 || todo+=("Sign in to GitHub: home/bin/github-setup, then home/bin/claude-setup")
[ -d /Applications/Xcode.app ] || ls -d /Applications/Xcode-*.app >/dev/null 2>&1 ||
  todo+=("Install Xcode with the Xcodes app (Apple ID), then ./rebuild.sh to add idb-companion")
fdesetup status | grep -q "FileVault is On" ||
  todo+=("Turn on FileVault (System Settings > Privacy & Security), and save the recovery key in 1Password")
sysadminctl -screenLock status 2>&1 | grep -q immediate ||
  todo+=("Turn on the screen lock: sysadminctl -screenLock immediate -password -")
tmutil destinationinfo 2>/dev/null | grep -q "^Name" ||
  todo+=("Add your Time Machine drives (Encrypt backups on), and keep the passwords in 1Password")
todo+=("Install the App Store apps by hand: Amphetamine, ColorSlurp")
[ -n "$(jq -r '.workRepos[]?' "$DIR/local/config.json" 2>/dev/null)" ] &&
  todo+=("Set up your work repos: work-bootstrap")

echo "==> Done. Open a new terminal, then use ./rebuild.sh for every later change. Still to do:"
for item in "${todo[@]}"; do echo "    - $item"; done
echo "    Check the result any time with mac-check."
