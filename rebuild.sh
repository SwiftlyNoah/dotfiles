#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Run as your normal user; the sudo below elevates only the switch itself.
if [ "$(id -u)" -eq 0 ]; then
  echo "Do not run rebuild.sh with sudo. Run it as your normal user; it calls sudo itself." >&2
  exit 1
fi
ln -sfn "$DIR" ~/.dotfiles
# "path:" avoids libgit2's "not owned by current user" error: nix-darwin runs the
# switch as root, and root can't fetch this user-owned git repo. See bootstrap.sh.
exec sudo darwin-rebuild switch --flake "path:$DIR#mac"
