# dotfiles

My personal Mac setup, managed with nix-darwin and home-manager.
One repo, one command, and a fresh Mac ends up configured the same way every time.

## What you get

Running the switch builds:

- System settings (dark mode, key repeat, dock position/size, Finder, trackpad, menu bar clock)
- Shell (zsh, aliases, starship prompt)
- Editor (Neovim config with the rose-pine moon theme)
- Terminal (WezTerm config with the rose-pine moon theme)
- Agent configs (Claude, Codex, opencode all share one AGENTS.md)

Every program it installs:

**Nix user packages** (`home.nix`)

- `ripgrep` - fast search
- `fd` - fast find
- `fzf` - fuzzy finder
- `jq` - JSON on the command line
- `lazygit` - terminal UI for git
- `neovim` - editor
- `nerd-fonts.hack` - the Hack Nerd Font everything renders in

**Homebrew CLI tools** (`brews` in `configuration.nix`)

- `herdr` - process/log herder
- `cocoapods` - CocoaPods dependency manager
- `fastlane` - iOS/Android build and release automation
- `gh` - GitHub CLI
- `node` - Node.js runtime
- `nvm` - Node version manager
- `php` - PHP runtime

**Homebrew casks / GUI apps** (`casks` in `configuration.nix`)

- `wezterm` - terminal emulator
- `claude-code` - Claude Code
- `1password` - password manager
- `proxyman` - HTTP debugging proxy
- `visual-studio-code` - VS Code editor
- `xcodes-app` - Xcode version manager
- `google-chrome` - web browser

## Prerequisites

- Apple Silicon Mac, by default.
- Intel Mac: change one line.
  In `configuration.nix`, set `nixpkgs.hostPlatform = "x86_64-darwin";` (the comment right there tells you the same thing).

## Fresh-machine setup

On a brand new Mac, from a bare clone of this repo:

```sh
git clone https://github.com/SwiftlyNoah/dotfiles.git
cd dotfiles
```

Before you run it: review "Make it yours" below.
Change the host label or CPU architecture if needed, and read the Homebrew cleanup warning.
`bootstrap.sh` applies the config to your machine, so do this first.

```sh
./bootstrap.sh
```

Run it as your normal user - **not** with `sudo`.
It prompts for your password at the step that needs root, and refuses to start if you run the whole thing as root.
(Under `sudo` it would read your username as `root` and write that into `flake.nix`, and root can't read a repo you own.)

`bootstrap.sh` does four things, in order:

1. Installs Determinate Nix, if it isn't already installed.
2. Symlinks this repo to `~/.dotfiles`.
   This has to happen before the first build, because `home.nix` points at config files through `~/.dotfiles`.
3. Checks the `user` configured in `flake.nix` against your actual macOS username, and offers to fix it for you if they differ.
4. Runs the first `darwin-rebuild switch`.
   It fetches the `darwin-rebuild` tool from the nix-darwin 26.05 release branch, then applies this repo's locked flake config.

After that, `darwin-rebuild` exists and you're on the normal workflow below.

### Why the flake reference says `path:`

Both scripts apply the config with `--flake "path:$DIR#mac"` rather than plain `~/.dotfiles#mac`.

nix-darwin 25.05 and later run the entire switch as root, so root ends up reading this repo - which your user account owns.
Git refuses that by default (the dubious-ownership check added for CVE-2022-24765), and the switch dies with `repository path ... is not owned by current user (libgit2 error code = 7)`.
The `path:` prefix copies the working tree directly instead of going through Git's fetcher, so the ownership check never runs.

This is worth knowing for two reasons:

- It's why you don't need `git config --global --add safe.directory` or any root-owned checkout.
  It's most likely to bite on a managed/corporate Mac, but the fix is unconditional and costs nothing on a personal one.
- Untracked files are picked up without committing first.
  With a Git flake reference, a brand new file is invisible to the build until you `git add` it.
  With `path:`, whatever is on disk is what gets built - convenient day to day, but remember an experiment you forgot to revert is also live.

### Validate without applying

Once Nix is installed (`bootstrap.sh` step 1 handles that), you can check that the config builds without touching your system - handy when you have edited something:

```sh
nix flake check --no-build
nix build .#darwinConfigurations.mac.system --dry-run
```

If you renamed the host label in "Make it yours", substitute your label for `mac` in these commands.

## Daily use

Edit the config files in place, then apply:

```sh
./rebuild.sh
```

That's it.
No separate build-and-copy step.

## Make it yours

This repo is mine.
If you clone it, review these before you run `bootstrap.sh`:

- **Username**: run `./bootstrap.sh` (it detects your macOS username and offers to set it) OR change the single `user = "noahbrauner"` line in `flake.nix`.
  Everything else (`configuration.nix`, `home.nix`, home directory paths) is threaded from that one variable.
- **Host label** `"mac"`, in three places: `flake.nix` (the `darwinConfigurations."mac"` name), `rebuild.sh:12` (the `#mac` at the end of the flake reference), and `bootstrap.sh`'s first-switch command (also `#mac`).
  All three have to match.
- **CPU architecture**, `hostPlatform` in `configuration.nix` (see Prerequisites above).

**Git identity:** this config deliberately does not set your git name or email.
Git will stop your first commit and tell you to set them (`git config --global user.name "Your Name"` and `git config --global user.email you@example.com`).
If you'd rather manage that declaratively, add this back to `home.nix` with your own identity:

```nix
programs.git = {
  enable = true;
  settings.user = {
    name = "Your Name";
    email = "you@example.com";
  };
};
```

**If you already have Homebrew installed:** `configuration.nix` sets `nix-homebrew.autoMigrate = true`.
Without it, the switch stops with `/opt/homebrew seems to contain an existing copy of Homebrew` and makes you choose between uninstalling Homebrew by hand or enabling this setting.
With it, nix-homebrew takes over the existing installation in place rather than erroring out.
On a Mac that has never had Homebrew it does nothing.

**Homebrew cleanup warning:** `configuration.nix` sets `homebrew.onActivation.cleanup = "zap"`.
That means every time you switch, Homebrew removes any package or cask on your machine that isn't listed in the `brews` and `casks` arrays in `configuration.nix`.
If you already have Homebrew stuff installed that isn't in that list, the first switch will uninstall it.
Read through `brews` and `casks` before you run `bootstrap.sh` or `rebuild.sh` for the first time, and add anything you want to keep.

Note that `autoMigrate` does **not** save you here, despite being described as keeping your installed packages.
It preserves them through the migration itself, and then `zap` removes every one you didn't declare, moments later in the same switch.
`brew leaves` lists the packages you installed deliberately (as opposed to dependencies pulled in behind them) - that's the list worth reviewing before the first switch.
`zap` also discards a package's configuration and data, not just its binaries, so back up anything you care about (a `~/.gnupg` keyring, for instance) first.

**If a switch ends with `brew bundle failed! 1 Brewfile dependency failed to install`:** check whether the package actually installed (`brew list --versions <name>`) before assuming the worst.
Homebrew runs `brew cleanup` automatically when it hasn't run in 30 days, and it can do so *during* an install, deleting its own bootsnap compile cache out from under the running process.
That surfaces as `No such file or directory @ rb_file_s_lstat - .../bootsnap/compile-cache-iseq/...` and marks the package as failed even though it poured successfully.
Re-running `./rebuild.sh` clears it, since the cache is gone and gets rebuilt.
To stop it recurring, set `environment.variables.HOMEBREW_NO_INSTALL_CLEANUP = "1";` in `configuration.nix` - at the cost of old versions accumulating until you run `brew cleanup` yourself.

**About `herdr`:** it's in the `brews` list.
It's a real public Homebrew formula (`brew info herdr` finds it in homebrew-core, no tap needed), so it will install fine.
If you don't use it, just remove it from `brews` in your copy.

**No Mac App Store apps in this config:** Homebrew Bundle's `mas` integration (`homebrew.masApps`) turned out to be unreliable here - it tried to reinstall Amphetamine, ColorSlurp, and Dynamic wallpaper even though they were already installed and `mas` was signed in, and `brew bundle install` failed as a result.
Because nix-darwin's activation script runs with `set -e`, that failure aborted the tail end of every `darwin-rebuild switch` before it could mark the build as the current generation - a `mas` install failure would keep breaking every future rebuild, not just the first one.
Install those three (or any other App Store app) manually instead.

**Heads-up:**

- `home/AGENTS.md` is my personal agent policy, and `home.nix` installs it for Claude, Codex, and opencode.
  If you clone this repo, you'd silently inherit my agent instructions - edit or delete `home/AGENTS.md` if you don't want that.
- The `cc` and `co` shell aliases in `home.nix` are high-agency shortcuts: `claude --dangerously-skip-permissions` and `codex --full-auto`.
  They're convenient for me, but know what they do before you use them.

## Repo tour

- `flake.nix` - the entry point.
  Wires up nixpkgs, nix-darwin, home-manager, and nix-homebrew, and declares the `mac` machine.
- `configuration.nix` - system-level config: macOS defaults, Homebrew.
- `home.nix` - user-level config: shell, packages, prompt, and the symlinks described below.
- `rebuild.sh` - re-applies the config after the first switch.
  Run this every time you make a change.
- `home/` - the actual config files that get symlinked into place (Neovim, WezTerm, herdr, Claude settings, the shared `AGENTS.md`).
- `.gitignore` - keeps regenerated runtime junk out of the repo: herdr's own logs/session/socket files, `.DS_Store`, Nix build results (`result`, `result-*`), and this repo's project-local `.claude/` state.

## How the symlinks work

The files under `home/` are the real files - editing them here is editing your live config, no rebuild needed to see the change in your editor.
`home.nix` uses `mkOutOfStoreSymlink` to point paths like `~/.config/nvim` straight at `home/.config/nvim` in this repo, so the two never drift out of sync.
You only run `./rebuild.sh` when you change something that isn't just a symlinked file, like a package list or a system default.

## Notes

The first time you launch `nvim`, it bootstraps [lazy.nvim](https://github.com/folke/lazy.nvim) by cloning plugins from GitHub.
That needs network access once; after that it's offline.
Neovim and WezTerm both use the rose-pine moon theme.
Neovim keeps italics off and uses a transparent background on macOS, Windows, and WSL so it matches the terminal setup.

