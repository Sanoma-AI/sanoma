// Electron Forge, from its Vite + TypeScript template. `make` builds the app for this platform's
// arm64 and x64 into out/make: a dmg and a zip on macOS, a Squirrel installer and a zip on Windows.
// desktop-release.yml uploads the Mac ones to a draft GitHub Release. `package` builds the app,
// unpacked, into out/.
import { cpSync } from "node:fs";
import { join } from "node:path";
import { notarize } from "@electron/notarize";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

// On a Mac, the app is signed with the Developer ID that APPLE_SIGNING_IDENTITY names (one in the
// keychain), and notarized, with the dmg, when APPLE_API_KEY is the path of an App Store Connect
// API key (APPLE_API_KEY_ID and APPLE_API_ISSUER say whose): desktop-release.yml sets them all.
// Without them (`start`, the smoke test, a `package` here) it is signed ad hoc.
const identity = process.env.APPLE_SIGNING_IDENTITY;
const notarizeWith =
  identity && process.env.APPLE_API_KEY
    ? {
        appleApiKey: process.env.APPLE_API_KEY,
        appleApiKeyId: required("APPLE_API_KEY_ID"),
        appleApiIssuer: required("APPLE_API_ISSUER"),
      }
    : undefined;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`APPLE_API_KEY is set without ${name}: notarizing needs all three`);
  return value;
}

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
    // A failed signature fails the build. With a Developer ID, under the hardened runtime: Electron's
    // own code keeps @electron/osx-sign's entitlements (Chromium's, which go with the camera and
    // microphone prompts in Electron's Info.plist), and the Node it ships gets
    // node.entitlements.plist. Without one, ad hoc, as Apple silicon reports an app with no
    // signature as damaged: "-" goes to codesign as is (no keychain lookup), and no hardened
    // runtime (library validation rejects ad-hoc frameworks).
    osxSign: identity
      ? {
          identity,
          continueOnError: false,
          optionsForFile: (file) =>
            file.endsWith("/Contents/Resources/node/node")
              ? { entitlements: join(import.meta.dirname, "node.entitlements.plist") }
              : {},
        }
      : {
          identity: "-",
          identityValidation: false,
          continueOnError: false,
          optionsForFile: () => ({ hardenedRuntime: false }),
        },
    // The app, notarized and stapled before the makers pack it (so the zip's is too).
    osxNotarize: notarizeWith,
  },
  hooks: {
    // The Node built for the architecture being packaged (scripts/download-node.ts), beside pnpm.
    packageAfterCopy: async (_config, buildPath, _electronVersion, _platform, arch) => {
      cpSync(join(import.meta.dirname, "stage", `node-${arch}`), join(buildPath, "..", "node"), { recursive: true });
    },
    // The dmg, signed by its maker, is notarized and stapled as well: the download macOS checks
    // first is the image, not the app inside it.
    postMake: async (_config, results) => {
      if (notarizeWith) {
        const dmgs = results.flatMap((result) => result.artifacts).filter((file) => file.endsWith(".dmg"));
        await Promise.all(dmgs.map((dmg) => notarize({ appPath: dmg, ...notarizeWith })));
      }
      return results;
    },
  },
  makers: [
    new MakerDMG(identity ? { additionalDMGOptions: { "code-sign": { "signing-identity": identity } } } : {}),
    new MakerSquirrel({ name: "Sanoma", setupExe: "Sanoma-Setup.exe" }),
    new MakerZIP({}, ["darwin", "win32"]),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main.ts", config: "vite.main.config.mts", target: "main" },
        { entry: "src/preload.ts", config: "vite.main.config.mts", target: "preload" },
        { entry: "src/app-preload.ts", config: "vite.main.config.mts", target: "preload" },
      ],
      // The shell's own pages (start/): the start screen and a company's progress page.
      renderer: [{ name: "start", config: "vite.renderer.config.mts" }],
    }),
    // Set at package time, before signing. The shell runs companies with the Node it ships, never
    // Electron's own (`RunAsNode` off).
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      // On with a Developer ID only. The key lives in a Keychain item tied to the signature: a
      // Developer ID's holds across updates, an ad hoc one changes with every build, so each
      // update would ask for Keychain access (and a denial signs the user out of every company).
      // One-way: a build without it cannot read the cookies one with it wrote.
      [FuseV1Options.EnableCookieEncryption]: Boolean(identity),
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
