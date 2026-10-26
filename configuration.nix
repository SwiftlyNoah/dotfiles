{
  lib,
  user,
  xcode,
  localConfig,
  ...
}:

{
  # Determinate already manages the Nix daemon, so nix-darwin shouldn't.
  nix.enable = false;

  nixpkgs.config.allowUnfree = true;

  users.users.${user}.home = "/Users/${user}";

  system = {
    primaryUser = user;
    stateVersion = 6;
    defaults = {
      NSGlobalDomain = {
        AppleInterfaceStyle = "Dark";
        KeyRepeat = 2; # fast key repeat
        InitialKeyRepeat = 15; # short delay before repeat
        _HIHideMenuBar = true; # auto-hide the menu bar
        AppleShowAllExtensions = true;
      };
      dock = {
        autohide = true;
        orientation = "left";
        tilesize = 44;
        # No "recent apps" section: each agent browser that ran would leave a plain Chrome
        # icon there. Running apps that aren't pinned still show while they run.
        show-recents = false;
        largesize = 128; # magnified icon size
        magnification = false;
        persistent-apps = [
          "/Applications/Google Chrome.app"
        ]
        # The agents' shared browsers, each opened from a launcher (home/bin/agent-browser-launchers)
        ++ map (browser: "/Users/${user}/Applications/${browser.name}.app") localConfig.browsers
        ++ [
          "/System/Applications/App Store.app"
          "/Applications/WezTerm.app"
          "/Applications/1Password.app"
          "/System/Applications/iPhone Mirroring.app"
          "/System/Applications/System Settings.app"
          "/Applications/ColorSlurp.app" # from the App Store, installed by hand
        ];
        persistent-others = [
          {
            folder = {
              path = "/Users/${user}/Downloads";
              arrangement = "date-modified"; # newest first
            };
          }
        ];
      };
      finder = {
        FXPreferredViewStyle = "Nlsv"; # list view by default
        CreateDesktop = false; # clean desktop
        ShowPathbar = true;
      };
      # Bluetooth and Focus stay in Control Center, out of the menu bar.
      controlcenter = {
        Bluetooth = false;
        FocusModes = false;
      };
      trackpad.Clicking = true; # tap to click
      menuExtraClock.ShowSeconds = true;
      screencapture.location = "/Users/${user}/Downloads";

      # Device security, as a security review asks of every laptop that touches company data
      # (FileVault, a screen lock within 5 minutes, prompt updates, a firewall).
      # home/bin/mac-check reports all of them.
      screensaver = {
        askForPassword = true;
        askForPasswordDelay = 0; # the password is asked for the moment the screen locks
      };
      SoftwareUpdate.AutomaticallyInstallMacOSUpdates = true;
      # Full paths: a bare domain here would land in root's own preferences, which
      # macOS never reads for these.
      CustomSystemPreferences = {
        "/Library/Preferences/com.apple.SoftwareUpdate" = {
          AutomaticCheckEnabled = true;
          AutomaticDownload = true;
          CriticalUpdateInstall = true; # security responses and system data files
          ConfigDataInstall = true;
        };
        "/Library/Preferences/com.apple.commerce".AutoUpdate = true; # App Store apps
      };
      CustomUserPreferences = {
        # The alert sound: "Lilac", herdr's agent-needs-me chime (home/.config/herdr/sounds).
        NSGlobalDomain = {
          "com.apple.sound.beep.sound" = "/Users/${user}/Library/Sounds/Lilac.aiff";
        };
        # Maccy's history on ⌃⌘V (key code 9, ⌃⌘ = 4096 + 256). Its default, ⌘⇧C, is
        # Hammerspoon's Claude key, and macOS keeps ⌘⇧Space for the Screenshot app's visual
        # intelligence. It still skips copies that apps mark as passwords.
        "org.p0deje.Maccy" = {
          KeyboardShortcuts_popup = ''{"carbonKeyCode":9,"carbonModifiers":4352}'';
          showInStatusBar = true;
        };

        # The menu bar's order is in home.nix (home.activation.menuBarOrder). Siri,
        # Bluetooth, Focus, Time Machine, AltTab and Hammerspoon stay out of it: all are
        # reached by keyboard, Control Center or System Settings. (LuLu's icon is its own No Icon Mode setting: its
        # system extension keeps the preferences and overwrites edits made from outside.)
        "com.apple.controlcenter" = {
          "NSStatusItem VisibleCC Bluetooth" = false;
          "NSStatusItem VisibleCC FocusModes" = false;
        };
        "com.apple.Siri".StatusMenuVisible = false;
        # Time Machine's item is both of these; SystemUIServer saves its own copy when it
        # quits, so a change made by hand needs `killall -KILL SystemUIServer` to stick.
        "com.apple.systemuiserver" = {
          menuExtras = [ ];
          "NSStatusItem VisibleCC com.apple.menuextra.TimeMachine" = false;
        };
        # AltTab keeps its settings as strings.
        "com.lwouis.alt-tab-macos" = {
          menubarIconShown = "false";
          # The window under the pointer is the one ⌘Tab switches to on release.
          mouseHoverEnabled = "true";
        };
      };
    };
  };

  system.activationScripts.postActivation.text = ''
    # The display sleeps, and so locks, after 5 minutes idle, on battery and on power.
    # (power.sleep.display only sets the power adapter profile.)
    pmset -a displaysleep 5

    # Homebrew's JDK as the system Java, so /usr/bin/java and java_home find it. Homebrew
    # keeps it out of /Library/Java on its own (keg-only).
    ln -sfn /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk /Library/Java/JavaVirtualMachines/openjdk-21.jdk
  '';

  # Touch ID or my Apple Watch for sudo (a double-click of its side button), including
  # inside herdr and other terminal multiplexers. The Watch covers a keyboard without Touch ID.
  security.pam.services.sudo_local = {
    touchIdAuth = true;
    watchIdAuth = true;
    reattach = true;
  };

  # home-manager owns the interactive shell (home.nix). Left on, nix-darwin's /etc/zshrc
  # runs its own compinit with a different fpath, so the two rewrite ~/.zcompdump on
  # every launch (about 1.5s per new shell), and loads a prompt starship then replaces.
  programs.zsh = {
    enableCompletion = false;
    enableBashCompletion = false;
    promptInit = "";
  };

  # Dev servers (Expo, Firebase emulator, Proxyman, Android emulator) all bind
  # listening sockets. Stealth mode keeps them from answering probes on untrusted
  # networks. blockAllIncoming stays false so localhost development still works.
  networking.applicationFirewall = {
    enable = true;
    enableStealthMode = true;
    blockAllIncoming = false;
    allowSigned = true;
    allowSignedApp = true;
  };

  nix-homebrew = {
    enable = true;
    inherit user;
    # Take over a Homebrew installed the normal way instead of erroring out.
    # Harmless on a Mac that has never had Homebrew.
    autoMigrate = true;
  };

  homebrew = {
    enable = true;
    onActivation = {
      # "zap" removes anything not listed below, so this list is the single source of
      # truth: add a new tool here, never with a bare `brew install`, or the next
      # rebuild deletes it.
      cleanup = "zap";
      # A rebuild only installs and removes, so it stays quick. Upgrades happen daily in
      # mac-update (home/bin/mac-update).
      autoUpdate = false;
      upgrade = false;
      extraFlags = [ "--force" ];
    };
    taps = [
      "facebook/fb" # idb-companion
      "cameroncooke/axe" # axe
    ];
    brews = [
      "herdr" # terminal workspace manager for AI coding agents
      "gh" # GitHub CLI
      "age" # encrypts the Claude pool's shared tokens
      "php"
      "cocoapods"
      "fastlane"
      "openjdk@21" # Java toolchain for Android/Gradle builds
      "cameroncooke/axe/axe" # iOS simulator accessibility automation, for app tests
      "ffmpeg" # ffprobe, for video tests
      # gcloud-cli runs on these, but zap doesn't count a cask's formula dependencies and
      # tries to remove them on every rebuild (Homebrew then refuses). Declaring them stops
      # that. Drop either one once `brew uses --installed --cask <name>` no longer lists gcloud.
      "python@3.14"
      "openssl@3"
      "tectonic" # self-contained LaTeX engine
      "poppler" # pdftotext, pdfimages
      "tidy-html5" # HTML checks
      "cliclick" # scripted mouse and keyboard control
      "terminal-notifier" # macOS notifications from scripts (mac-check, mac-update)
    ]
    # These build against the full Xcode app, so a Mac without it yet leaves them out.
    ++ lib.optionals xcode [
      "facebook/fb/idb-companion" # iOS simulator automation, for app tests
    ];
    casks = [
      "wezterm"
      "1password"
      "1password-cli" # op, for saving and reading secrets from scripts
      "google-chrome"
      "visual-studio-code"
      "codex" # OpenAI's coding agent CLI (the `co` alias)
      "xcodes-app"
      "proxyman"
      "gcloud-cli" # Google Cloud CLI
      "alt-tab" # ⌘Tab through every window, so each Chrome profile's window is one key away
      "hammerspoon" # app hotkeys (home/.hammerspoon/init.lua)
      "maccy" # clipboard history on ⌃⌘V
      # Objective-See: an outbound firewall, an alert when something installs itself to run
      # in the background, and an alert when the mic or camera turns on.
      "lulu"
      "blockblock"
      "oversight"
    ];
  };
}
