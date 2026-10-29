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
        ".config/herdr" = "home/.config/herdr";
        # The Mac's alert sound, the same "Lilac" as herdr's agent-needs-me chime (synth.py).
        "Library/Sounds/Lilac.aiff" = "home/Library/Sounds/Lilac.aiff";
        # VS Code writes here when a setting changes in its UI: those land in the repo too.
        "Library/Application Support/Code/User/settings.json" = "home/vscode/settings.json";
        # The file, not the folder: Hammerspoon keeps its Spoons beside it.
        ".hammerspoon/init.lua" = "home/.hammerspoon/init.lua";
        ".claude/settings.json" = "home/.claude/settings.json";
        # One file at a time: herdr owns ~/.claude/hooks/herdr-agent-state.sh beside these.
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

  # VS Code's theme (home/vscode/settings.json picks it). Its own updater keeps it current.
  home.activation.vscodeTheme = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    code=/opt/homebrew/bin/code
    if [ -x "$code" ] && ! "$code" --list-extensions | grep -qx mvllow.rose-pine; then
      run "$code" --install-extension mvllow.rose-pine || true
    fi
  '';

  # The menu bar, left to right: Cisco Secure Client (the VPN), Maccy, Amphetamine, Noah's
  # Pool, Now Playing, Wi-Fi, Battery, Control Center, Clock. macOS 27 keeps the order here,
  # as each item's distance from the right edge, and rewrites it when an icon is ⌘-dragged.
  # (configuration.nix can't write it: nix-darwin splits the path at its space.)
  home.activation.menuBarOrder = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    menubar="${config.home.homeDirectory}/Library/Group Containers/com.apple.MenuBar/Library/Preferences/com.apple.MenuBar"
    run /usr/bin/defaults write "$menubar" TrailingItemPreferredPositions -dict-add \
      module:Clock -float 0 \
      module:BentoBox-0 -float 176.5 \
      module:Battery -float 200 \
      module:WiFi -float 225 \
      module:NowPlaying -float 250 \
      status:NoahsPool::Item-0 -float 300 \
      status:com.if.Amphetamine::Amphetamine -float 340 \
      status:org.p0deje.Maccy::Item-0 -float 380 \
      status:com.cisco.secureclient.gui::Item-0 -float 700
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
      '';
      shellAliases = {
        ".." = "cd ..";
        ga = "git add .";
        gc = "git commit -m";
        gp = "git push";
        pull = "git pull";
        m = "git switch main";
        # Claude Code through the shared account pool (`cc <session id>` resumes one), with
        # the pool's saved defaults, which home/bin/claude-setup sets.
        cc = "claude-pool";
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
