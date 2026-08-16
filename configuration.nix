{ user, ... }:

{
  # Determinate already manages the Nix daemon, so nix-darwin shouldn't.
  nix.enable = false;

  nixpkgs.config.allowUnfree = true;
  nixpkgs.hostPlatform = "aarch64-darwin"; # use x86_64-darwin for Intel CPU

  system.primaryUser = user;
  users.users.${user} = {
    home = "/Users/${user}";
  };
  system.stateVersion = 6;
  system.defaults = {
    NSGlobalDomain = {
      AppleInterfaceStyle = "Dark";
      KeyRepeat = 2;          # fast key repeat
      InitialKeyRepeat = 15;  # short delay before repeat
      _HIHideMenuBar = true;  # auto-hide the menu bar
      AppleShowAllExtensions = true;
    };
    dock = {
      autohide = true;
      orientation = "left";     # dock on the left edge
      tilesize = 44;
      largesize = 128;          # magnified icon size
      magnification = false;
    };
    finder = {
      FXPreferredViewStyle = "Nlsv";  # list view by default
      CreateDesktop = false;          # clean desktop
      ShowPathbar = true;
    };
    trackpad.Clicking = true;              # tap to click
    menuExtraClock.ShowSeconds = true;
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
    # Take ownership of a Homebrew that was installed the normal way, instead of
    # erroring out. It replaces the existing installation but keeps the packages
    # already installed. Harmless on a machine that has never had Homebrew.
    autoMigrate = true;
  };
  homebrew = {
    enable = true;
    # "zap" removes anything not listed below. That makes this list the single
    # source of truth, so ANY new tool must be added here rather than installed
    # with a bare `brew install` - otherwise the next rebuild deletes it.
    onActivation.cleanup = "zap";
    onActivation.autoUpdate = true;
    onActivation.extraFlags = [ "--force" ];
    taps = [
      "facebook/fb"  # provides idb-companion
    ];
    brews = [
      "herdr"
      "cocoapods"
      "fastlane"
      "gh"
      "node"
      "nvm"
      "php"
      # --- reconciled 2026-08-16: installed on request but previously undeclared,
      #     so `zap` would have removed them on the next rebuild.
      "openjdk@21"                  # Java toolchain for Android/Gradle builds
      "tectonic"                    # self-contained LaTeX engine
      "poppler"                     # pdftotext/pdfimages CLI utilities
      "cliclick"                    # scripted mouse/keyboard control
      "facebook/fb/idb-companion"   # iOS device/simulator automation
    ];
    casks = [
      "wezterm"
      "claude-code"
      "1password"
      "proxyman"
      "visual-studio-code"
      "xcodes-app"
      "google-chrome"
      "gcloud-cli"  # reconciled 2026-08-16: controls the red-black GCE solver fleet
    ];
  };
}
