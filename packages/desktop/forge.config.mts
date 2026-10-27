// Electron Forge, from its Vite + TypeScript template. `make` builds the app for this platform's
// arm64 and x64 into out/make (a dmg and a zip on macOS; on Windows, once the shell runs there (#419), a Squirrel installer and a zip);
// desktop-release.yml uploads them to a draft GitHub Release. `package` builds it, unpacked, into out/.
import { cpSync } from "node:fs";
import { join } from "node:path";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

const config: ForgeConfig = {
  packagerConfig: {
    appBundleId: "ai.sanoma.desktop",
    appCategoryType: "public.app-category.business",
    asar: true,
    // stage/ is filled by scripts/stage.ts: pnpm, the same for every architecture, goes in here;
    // the pinned Node goes in per architecture (`packageAfterCopy`).
    extraResource: [join(import.meta.dirname, "stage", "pnpm")],
    extendInfo: {
      // The Node it ships needs macOS 13.5; Electron alone would open on 13.0.
      LSMinimumSystemVersion: "13.5",
      // A folder dropped on the Dock icon, or `open -a Sanoma <folder>`, reaches the app (`open-file`).
      CFBundleDocumentTypes: [
        { CFBundleTypeName: "Folder", CFBundleTypeRole: "Viewer", LSItemContentTypes: ["public.folder"] },
      ],
    },
    // Unsigned preview, signed ad hoc: Apple silicon reports an app with no signature as damaged.
    // "-" goes to codesign as is (no keychain lookup), a failed signature fails the build, and the
    // hardened runtime waits for a Developer ID (library validation rejects ad-hoc frameworks).
    osxSign: {
      identity: "-",
      identityValidation: false,
      continueOnError: false,
      optionsForFile: () => ({ hardenedRuntime: false }),
    },
  },
  hooks: {
    // The Node built for the architecture being packaged (scripts/download-node.ts), beside pnpm.
    packageAfterCopy: async (_config, buildPath, _electronVersion, _platform, arch) => {
      cpSync(join(import.meta.dirname, "stage", `node-${arch}`), join(buildPath, "..", "node"), { recursive: true });
    },
  },
  makers: [
    new MakerDMG(),
    new MakerSquirrel({ name: "Sanoma", setupExe: "Sanoma-Setup.exe" }),
    new MakerZIP({}, ["darwin", "win32"]),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main.ts", config: "vite.main.config.mts", target: "main" },
        { entry: "src/preload.ts", config: "vite.main.config.mts", target: "preload" },
      ],
      // The shell's own pages (start/): the start window and a company window's progress page.
      renderer: [{ name: "start", config: "vite.renderer.config.mts" }],
    }),
    // Set at package time, before signing. The shell runs companies with the Node it ships, never
    // Electron's own (`RunAsNode` off).
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      // Off while the app is signed ad hoc: the key lives in a Keychain item tied to the signature,
      // which changes with every build, so each update would ask for Keychain access (and a denial
      // signs the user out of every company). Turn it on with the Developer ID; it is one-way.
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
