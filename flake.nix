{
  description = "dsh-chrome — the DeepSeek Harness web GUI in its own window";

  inputs = {
    # Pinned by flake.lock for reproducibility; move forward with
    # `nix flake update`.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # Where `dsh` comes from: the harness package whose frontend dist carries the
    # launcher icon installed below. Its nixpkgs is deliberately not overridden —
    # the lockfile is kept on the same llm-agents revision the rest of the lab
    # builds, which is what keeps this input in the cache instead of rebuilding
    # the harness here.
    llm-agents.url = "github:numtide/llm-agents.nix";
  };

  outputs =
    {
      self,
      nixpkgs,
      llm-agents,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];

      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f (import nixpkgs { inherit system; }));

      # One version, read from the manifest Electron loads anyway, so the two
      # cannot drift.
      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          inherit (pkgs) lib;
          dsh = llm-agents.packages.${pkgs.stdenv.hostPlatform.system}.dsh;
        in
        rec {
          dsh-chrome = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "dsh-chrome";
            inherit version;

            # node_modules, dist and the `result` symlink belong to whoever last
            # built this checkout, not to the build.
            src = lib.cleanSourceWith {
              src = ./.;
              filter =
                path: _type:
                !(builtins.elem (baseNameOf path) [
                  "node_modules"
                  "dist"
                  "result"
                ]);
            };

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src;
              inherit (pkgs) pnpm;
              # 4 is what pnpm 11 and newer require; 3 is rejected outright.
              fetcherVersion = 4;
              hash = "sha256-7F+TLtKSzq3b3Qpf7cBhpiBtwI5qfxMkjNJi7BBFI+c=";
            };

            nativeBuildInputs = with pkgs; [
              librsvg
              makeWrapper
              nodejs
              pnpm
              pnpmConfigHook
            ];
            buildInputs = [ pkgs.electron ];

            strictDeps = true;

            # electron is here for its TypeScript types; its installer must not
            # fetch a second binary to sit beside the one nix provides.
            env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

            buildPhase = ''
              runHook preBuild
              pnpm build
              runHook postBuild
            '';

            # The unit suite is hermetic — hosts, attach cadence and the ssh
            # command line are pure functions — so a build that compiles is also
            # a build that has run it. The e2e suite needs a display and stays
            # out of the sandbox.
            doCheck = true;
            checkPhase = ''
              runHook preCheck
              HOME=$TMPDIR pnpm test
              runHook postCheck
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p $out/share/dsh-chrome
              cp -r dist package.json $out/share/dsh-chrome/

              # The harness mark, from the same frontend dist that serves it as the
              # web app's favicon. Upstream ships it twice: favicon.svg is the black
              # glyph for light surfaces, favicon-dark.svg the white one for dark. A
              # launcher icon cannot follow the theme, and this desktop is dark, so
              # install the dark-surface variant at every size a taskbar may ask for.
              icon_svg=${dsh}/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon-dark.svg
              for size in 16 32 48 64 128 256; do
                install -d $out/share/icons/hicolor/''${size}x''${size}/apps
                rsvg-convert -w "$size" -h "$size" \
                  -o $out/share/icons/hicolor/''${size}x''${size}/apps/dsh-chrome.png "$icon_svg"
              done
              install -Dm644 "$icon_svg" $out/share/icons/hicolor/scalable/apps/dsh-chrome.svg
              # the same art beside the app for dist/main.js's window-level icon option
              install -m644 $out/share/icons/hicolor/256x256/apps/dsh-chrome.png \
                $out/share/dsh-chrome/icon.png
              # ...and beside the pages, which is where the titlebar's mark points (the
              # page loads ./icon.png, and a broken image is hidden rather than shown).
              # The mark is 16px, so the 32px rendering covers a hi-dpi display.
              install -m644 $out/share/icons/hicolor/32x32/apps/dsh-chrome.png \
                $out/share/dsh-chrome/dist/renderer/icon.png

              # Same opt-in as the browser wrappers: only take the Wayland path when the
              # session asked for it, so an X11 session still gets X11.
              makeWrapper ${lib.getExe pkgs.electron} $out/bin/dsh-chrome \
                --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform-hint=auto --enable-wayland-ime=true}}" \
                --add-flags "$out/share/dsh-chrome"

              install -Dm644 dsh-chrome.desktop $out/share/applications/dsh-chrome.desktop

              runHook postInstall
            '';

            meta = {
              description = "DeepSeek Harness web GUI in its own window";
              mainProgram = "dsh-chrome";
              platforms = lib.platforms.linux;
            };
          });

          default = dsh-chrome;
        }
      );

      # `nix run` — the wrapper already knows which app directory to hand
      # Electron.
      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.dsh-chrome}/bin/dsh-chrome";
          meta.description = "Run dsh-chrome against this machine's dsh-web service";
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            electron
            nodejs
            pnpm
            xvfb-run # headless `pnpm test:e2e`
          ];

          env = {
            # The devDependency is here for its TypeScript types only; a second
            # Electron binary beside nixpkgs' one is never wanted.
            ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
            # What tests/e2e drives, so the suite never picks up the tarball.
            DSH_ELECTRON = pkgs.lib.getExe pkgs.electron;
          };

          shellHook = ''
            echo "dsh-chrome dev shell"
            echo "  node     $(node --version)"
            echo "  pnpm     $(pnpm --version)"
            echo "  electron $DSH_ELECTRON"
          '';
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);

      checks = forAllSystems (pkgs: {
        inherit (self.packages.${pkgs.stdenv.hostPlatform.system}) dsh-chrome;
      });

      # So a consuming flake can take the package without knowing how this
      # flake's systems are laid out.
      overlays.default = final: _prev: {
        dsh-chrome = self.packages.${final.stdenv.hostPlatform.system}.dsh-chrome;
      };
    };
}
