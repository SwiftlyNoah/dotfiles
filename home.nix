{
  config,
  lib,
  pkgs,
  user,
  localConfig,
  ...
}:

let
  # Live links into this repo (through the ~/.dotfiles link rebuild.sh maintains), so
  # editing a file here changes the running config at once, with no rebuild.
  live = path: config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.dotfiles/${path}";

  # Every hook name git knows, each pointing at the one dispatcher.
  gitHooks = [
    "applypatch-msg"
    "commit-msg"
    "post-applypatch"
    "post-checkout"
    "post-commit"
    "post-merge"
    "post-rewrite"
    "pre-applypatch"
    "pre-auto-gc"
    "pre-commit"
    "pre-merge-commit"
    "pre-push"
    "pre-rebase"
    "prepare-commit-msg"
    "push-to-checkout"
  ];
  email = "devnoahapps@gmail.com";
in

{
  home = {
    username = user;
    homeDirectory = "/Users/${user}";
    stateVersion = "24.11";

    packages = with pkgs; [
      ripgrep # fast search
      fd # fast find
      fzf # fuzzy finder
      jq # JSON on the command line
      lazygit
      gitleaks # secret scanning, in every repo's pre-commit
      nodejs_24 # Node: the newest LTS line, for every project
      python314 # python3: the newest release
      uv # Python versions and project environments
      maple-mono.NF # the font everything renders in: soft and round, with icons
    ];

    # Commit messages, lazygit and anything else that asks for an editor open VS Code.
    sessionVariables = {
      EDITOR = "code --wait";
      # `npm install -g` can't write into the read-only Nix store, so global CLIs live here.
      # mac-update keeps them at their latest release.
      NPM_CONFIG_PREFIX = "${config.home.homeDirectory}/.npm-global";
    };
    # Where the Claude Code native installer puts `claude` (and claude-pool its own
    # command). Dropping this makes `claude` vanish from every new shell. It lives here
    # because ~/.zshrc is a read-only Nix store link that nothing can append to.
    sessionPath = [
      "${config.home.homeDirectory}/.local/bin"
      "${config.home.homeDirectory}/.dotfiles/home/bin" # mac-check, mac-update, claude-setup
      "${config.home.homeDirectory}/.npm-global/bin"
    ];

    file =
      lib.mapAttrs (_: path: { source = live path; }) {
        ".config/wezterm" = "home/.config/wezterm";
        # The config and our chimes, not the folder: herdr keeps its sockets, logs and
        # sessions beside them, which belong to this Mac, not to the repo.
        ".config/herdr/config.toml" = "home/.config/herdr/config.toml";
        ".config/herdr/sounds" = "home/.config/herdr/sounds";
        # The Mac's alert sound, the same "Lilac" as herdr's agent-needs-me chime (synth.py).
        "Library/Sounds/Lilac.aiff" = "home/Library/Sounds/Lilac.aiff";
        # VS Code writes here when a setting changes in its UI: those land in the repo too.
        "Library/Application Support/Code/User/settings.json" = "home/vscode/settings.json";
        # The file, not the folder: Hammerspoon keeps its Spoons beside it.
        ".hammerspoon/init.lua" = "home/.hammerspoon/init.lua";
        ".claude/settings.json" = "home/.claude/settings.json";
        # One file at a time: herdr-agent-state.sh beside these is herdr's (herdrClaudeHook).
        ".claude/hooks/auto-accept.sh" = "home/.claude/hooks/auto-accept.sh";
        ".claude/hooks/herdr-cc-resume.sh" = "home/.claude/hooks/herdr-cc-resume.sh";
        # Codex and opencode read this directly. Claude reads it through ~/.claude/CLAUDE.md,
        # a file of this Mac's own (see home/bin/claude-setup), which imports it.
        ".codex/AGENTS.md" = "home/AGENTS.md";
        ".config/opencode/AGENTS.md" = "home/AGENTS.md";
      }
      // lib.genAttrs (map (hook: ".config/git/hooks/${hook}") gitHooks) (_: {
        source = live "home/.config/git/hooks/dispatch";
      });
  };

  # The shared browsers' launcher apps, rebuilt when their icons change. On every switch,
  # since the icons live outside this repo (~/.config/agent-browser).
  home.activation.agentBrowserLaunchers = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    run ${config.home.homeDirectory}/.dotfiles/home/bin/agent-browser-launchers
  '';

  # Noah's Mac, the menu bar app (apps/noahs-mac), built from source when it changed and
  # installed to ~/Applications before its launch agent loads.
  home.activation.noahsMac = lib.hm.dag.entryBetween [ "setupLaunchAgents" ] [ "writeBoundary" ] ''
    run ${config.home.homeDirectory}/.dotfiles/apps/noahs-mac/build.sh
  '';

  # herdr's Claude hook (herdr-agent-state.sh), which shows each agent's state in its sidebar.
  # `herdr integration install claude` would also add its own settings.json entry, with this
  # Mac's home folder written out, to the tracked home/.claude/settings.json. So install it
  # into a throwaway home and copy just the script; the tracked entry finds it by $HOME and
  # does nothing until it exists.
  home.activation.herdrClaudeHook = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    herdr=/opt/homebrew/bin/herdr
    if [ -x "$herdr" ]; then
      tmp=$(mktemp -d)
      mkdir "$tmp/.claude" # herdr installs only where Claude Code is
      if HOME="$tmp" "$herdr" integration install claude >/dev/null 2>&1; then
        dest="$HOME/.claude/hooks/herdr-agent-state.sh"
        if ! cmp -s "$tmp/.claude/hooks/herdr-agent-state.sh" "$dest"; then
          run mkdir -p "$HOME/.claude/hooks"
          run install -m 755 "$tmp/.claude/hooks/herdr-agent-state.sh" "$dest"
        fi
      fi
      rm -rf "$tmp"
    fi
  '';

  # VS Code's theme (home/vscode/settings.json picks it). Its own updater keeps it current.
  home.activation.vscodeTheme = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    code=/opt/homebrew/bin/code
    if [ -x "$code" ] && ! "$code" --list-extensions | grep -qx mvllow.rose-pine; then
      run "$code" --install-extension mvllow.rose-pine || true
    fi
  '';

  # The menu bar, left to right: a Time Machine backup's progress while one runs (Hammerspoon),
  # Cisco Secure Client (the VPN), Maccy, Amphetamine, Noah's Mac, Noah's
  # Pool, Now Playing, Wi-Fi, Battery, Control Center, Clock. macOS 27 keeps the order here,
  # as each item's distance from the right edge, and rewrites it when an icon is ⌘-dragged.
  # (configuration.nix can't write it: nix-darwin splits the path at its space.)
  home.activation.menuBarOrder = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    menubar="${config.home.homeDirectory}/Library/Group Containers/com.apple.MenuBar/Library/Preferences/com.apple.MenuBar"
    # The menu bar's group container is another app's data: macOS lets a switch write it only
    # from a terminal with Full Disk Access, which a new Mac's Terminal doesn't have yet. The order
    # is cosmetic, so a refusal is a warning and the next switch from such a terminal applies it.
    run /usr/bin/defaults write "$menubar" TrailingItemPreferredPositions -dict-add \
      module:Clock -float 0 \
      module:BentoBox-0 -float 176.5 \
      module:Battery -float 200 \
      module:WiFi -float 225 \
      module:NowPlaying -float 250 \
      status:NoahsPool::Item-0 -float 300 \
      status:NoahsMac::Item-0 -float 320 \
      status:com.if.Amphetamine::Amphetamine -float 340 \
      status:org.p0deje.Maccy::Item-0 -float 380 \
      status:com.cisco.secureclient.gui::Item-0 -float 700 \
      status:org.hammerspoon.Hammerspoon::backup -float 800 ||
      warnEcho "Menu bar order not set: this terminal has no Full Disk Access (System Settings, Privacy and Security). Run ./rebuild.sh again once it has."
  '';

  launchd.agents =
    lib.mapAttrs
      (name: job: {
        enable = true;
        config = {
          ProgramArguments = [
            "${config.home.homeDirectory}/.dotfiles/home/bin/${job.program or name}"
          ]
          ++ job.args;
        }
        // (
          if job.keepAlive or false then
            {
              RunAtLoad = true;
              KeepAlive = true;
              ProcessType = "Interactive";
            }
          else
            { StartCalendarInterval = [ job.at ]; }
        )
        // {
          StandardOutPath = "${config.home.homeDirectory}/Library/Logs/${name}.log";
          StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/${name}.log";
        };
      })
      (
        {
          # Nightly: the device checks a security review asks for, plus backups and disk
          # space. Silent when everything passes; a notification names whatever fails.
          mac-check = {
            args = [ "--notify" ];
            at = {
              Hour = 21;
              Minute = 0;
            };
          };
          # Hourly: leftovers of builds, browsers and agent sessions that nothing uses any
          # more, and the `copies` in local/config.json to their external disk.
          mac-tidy = {
            args = [ ];
            at.Minute = 15;
          };
          # Daily: every package manager to its latest version, and a notification saying
          # what changed and whether a rebuild is waiting.
          mac-update = {
            args = [ "--scheduled" ];
            at = {
              Hour = 10;
              Minute = 0;
            };
          };
        }
        # Always: each shared browser's Chrome, restarted whenever it exits. main's job keeps
        # the unsuffixed name it had before there were others (home/lib/agent-browser.zsh).
        // lib.listToAttrs (
          map (browser: {
            name = "agent-browser-chrome${lib.optionalString (browser.id != "main") "-${browser.id}"}";
            value = {
              program = "agent-browser-chrome";
              args = [ browser.id ];
              keepAlive = true;
            };
          }) localConfig.browsers
        )
      )
    // {
      # Noah's Mac, the menu bar app, from login on. Quit from its menu stays quit until the
      # next login; a crash starts it again.
      noahs-mac = {
        enable = true;
        config = {
          ProgramArguments = [
            "${config.home.homeDirectory}/Applications/Noah's Mac.app/Contents/MacOS/NoahsMac"
          ];
          RunAtLoad = true;
          KeepAlive.SuccessfulExit = false;
          ProcessType = "Interactive";
          StandardOutPath = "${config.home.homeDirectory}/Library/Logs/noahs-mac.log";
          StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/noahs-mac.log";
        };
      };
    }
    # The menu bar and helper apps, opened in the background at every login, so a new Mac
    # starts them without anyone adding Login Items by hand. `open` leaves one already
    # running alone. Each still asks once for its own permissions (Accessibility, Screen
    # Recording, a network or system extension).
    // lib.listToAttrs (
      map
        (app: {
          name = "login-${lib.toLower (lib.replaceStrings [ " " ] [ "-" ] app)}";
          value = {
            enable = true;
            config = {
              ProgramArguments = [
                "/usr/bin/open"
                "-g"
                "-a"
                app
              ];
              RunAtLoad = true;
            };
          };
        })
        [
          "Hammerspoon" # window and key automation, the Time Machine progress item
          "Maccy" # clipboard history
          "AltTab" # Windows-style window switching
          "LuLu" # outbound firewall
          "OverSight" # camera and microphone alerts
          "ColorSlurp" # color picker (from the App Store)
        ]
    );

  fonts.fontconfig.enable = true;
  # The home-configuration.nix(5) man page. Building it warns on every rebuild (an
  # upstream options.json issue); the same options are searchable online.
  manual.manpages.enable = false;

  programs = {
    zsh = {
      enable = true;
      autosuggestion.enable = true; # ghost text from history
      syntaxHighlighting.enable = true; # commands turn green when valid
      # Owner-only files by default (octal 077) in every zsh: terminals, claude-pool sessions and
      # the agents' shells, and scripts and launchd jobs that run zsh. With the old 022, other
      # users on this Mac (the services' own users) could read what these shells made. Anything
      # meant for another user sets its mode explicitly.
      envExtra = ''
        umask 077
      '';
      initContent = ''
        bindkey '^f' autosuggest-accept

        # Tell the terminal which directory we are in (OSC 7), on every cd.
        # WezTerm needs this to open a repo-relative path like lib/api/requestAPI.ts:142,
        # since otherwise it has no idea what the path is relative to. It pairs with the
        # hyperlink_rules in home/.config/wezterm/wezterm.lua.
        _osc7_cwd() { printf '\e]7;file://%s%s\e\\' "$HOST" "$PWD"; }
        autoload -Uz add-zsh-hook
        add-zsh-hook chpwd _osc7_cwd
        _osc7_cwd

        # Claude Code (`cc <session id>` resumes one): through the shared account pool, with
        # its saved defaults, when home/bin/claude-setup set one up; plain claude otherwise.
        cc() {
          if (( $+commands[claude-pool] )); then claude-pool "$@"; else claude "$@"; fi
        }
      '';
      shellAliases = {
        ".." = "cd ..";
        ga = "git add .";
        gc = "git commit -m";
        gp = "git push";
        pull = "git pull";
        m = "git switch main";
        co = "codex --full-auto";
        stop = "herdr server stop";
      };
    };

    starship = {
      enable = true;
      settings = {
        add_newline = false;
        format = "$directory$git_branch$git_status$cmd_duration$line_break$character";
        character = {
          success_symbol = "[❯](purple)";
          error_symbol = "[❯](red)";
        };
        cmd_duration.format = "[$duration]($style) ";
      };
    };
    git = {
      enable = true;
      lfs.enable = true;
      signing = {
        format = "ssh";
        key = "~/.ssh/id_ed25519.pub";
        signByDefault = true;
      };
      settings = {
        user = {
          name = "SwiftlyNoah";
          inherit email;
        };
        # Written by home/bin/github-setup from this Mac's own key.
        gpg.ssh.allowedSignersFile = "~/.ssh/allowed_signers";
        core.hooksPath = "${config.xdg.configHome}/git/hooks";
        init.defaultBranch = "main";
        pull.rebase = true;
        rebase.autoStash = true;
        push = {
          default = "simple";
          autoSetupRemote = true;
        };
        fetch.prune = true;
        merge.conflictStyle = "zdiff3";
        diff.algorithm = "histogram";
        alias.count-lines = ''!git log --author="$1" --pretty=tformat: --numstat | awk '{ add += $1; subs += $2; loc += $1 - $2 } END { printf "added lines: %s, removed lines: %s, total lines: %s\n", add, subs, loc }' #'';
      };
    };
    # Side-by-side, syntax-highlighted diffs in git and lazygit.
    delta = {
      enable = true;
      enableGitIntegration = true;
      options = {
        navigate = true;
        line-numbers = true;
      };
    };
  };
}
