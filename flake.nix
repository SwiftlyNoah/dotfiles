{
  description = "One Mac, declared: nix-darwin, home-manager and Homebrew";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
    nix-darwin.url = "github:nix-darwin/nix-darwin/nix-darwin-26.05";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";
    home-manager.url = "github:nix-community/home-manager/release-26.05";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
    nix-homebrew.url = "github:zhaofengli/nix-homebrew";
    # Homebrew itself. nix-homebrew pins it too but bumps it only now and then, and an old
    # Homebrew can't upgrade formulae that use newer install steps. The daily update
    # workflow moves this to Homebrew's latest release. (Its store path still says 7.0.4:
    # nix-homebrew names the build after its own pin, whatever source it gets.)
    brew-src = {
      url = "github:Homebrew/brew/7.0.11";
      flake = false;
    };
    nix-homebrew.inputs.brew-src.follows = "brew-src";
  };

  outputs =
    {
      nixpkgs,
      nix-darwin,
      nix-homebrew,
      home-manager,
      ...
    }:
    let
      # The two lines to change for another Mac. bootstrap.sh offers to rewrite `user`.
      user = "noahbrauner";
      system = "aarch64-darwin"; # "x86_64-darwin" on an Intel Mac

      pkgs = nixpkgs.legacyPackages.${system};
      inherit (nixpkgs) lib;

      # Your own settings (home/lib/local-config.zsh): local/config.json, a clone of your
      # private dotfiles-local repo, or the example. rebuild.sh builds from a `path:` flake,
      # which sees local/; CI and other git checkouts don't, and use the example.
      localConfig = builtins.fromJSON (
        builtins.readFile (
          if builtins.pathExists ./local/config.json then ./local/config.json else ./local.example.json
        )
      );

      # One Mac's whole configuration. `xcode = false` leaves out the few tools that need
      # the full Xcode app, for a new Mac's first switch (rebuild.sh picks it then).
      mkMac =
        {
          user,
          system,
          xcode ? true,
        }:
        nix-darwin.lib.darwinSystem {
          specialArgs = { inherit user xcode localConfig; };
          modules = [
            ./configuration.nix
            nix-homebrew.darwinModules.nix-homebrew
            home-manager.darwinModules.home-manager
            {
              nixpkgs.hostPlatform = system;
              home-manager = {
                useGlobalPkgs = true;
                useUserPackages = true;
                extraSpecialArgs = { inherit user localConfig; };
                backupFileExtension = "hm-bak";
                users.${user} = import ./home.nix;
              };
            }
          ];
        };
    in
    {
      # Every Mac comes as <name> and <name>-without-xcode. Another Mac is one more line in
      # this list, with its own user and platform; then HOST=<name> in rebuild.sh there.
      darwinConfigurations = lib.concatMapAttrs (name: args: {
        ${name} = mkMac args;
        "${name}-without-xcode" = mkMac (args // { xcode = false; });
      }) { mac = { inherit user system; }; };

      formatter.${system} = pkgs.nixfmt;

      # `nix flake check` runs this, locally and in CI.
      checks.${system}.lint =
        pkgs.runCommand "lint"
          {
            nativeBuildInputs = with pkgs; [
              deadnix
              gitleaks
              jq
              lua
              nixfmt
              python3
              shellcheck
              statix
              zsh
            ];
          }
          ''
            cd ${./.}
            gitleaks dir . --redact --no-banner --log-level warn
            shellcheck bootstrap.sh rebuild.sh wallpaper/build.sh home/.claude/hooks/*.sh home/.claude/statusline.sh home/.config/git/hooks/dispatch
            for f in home/bin/* home/lib/*.zsh; do zsh -n "$f"; done
            nixfmt --check ./*.nix
            deadnix --fail .
            statix check .
            jq empty home/.claude/settings.json home/lib/agent-browser-mcp/*.json local.example.json
            python3 -c 'import sys, tomllib; [tomllib.load(open(f, "rb")) for f in sys.argv[1:]]' \
              home/.config/herdr/config.toml
            find home -name '*.lua' -exec luac -p {} +
            touch $out
          '';
    };
}
