// Electron Forge, from its Vite + TypeScript template. `make` builds the app into out/make: a dmg
// and a zip for arm64 and x64 on macOS, and `make:windows` a Squirrel installer for x64 on Windows.
// desktop-release.yml uploads them to a draft GitHub Release. `package` builds the app, unpacked,
// into out/.
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

// APPLE_SIGNING_IDENTITY signs with a Developer ID, APPLE_API_KEY (with its id and issuer)
// notarizes; without them the build is signed ad hoc (README, "Signing and notarization").
// vite.main.config.mts reads APPLE_SIGNING_IDENTITY the same way, for SIGNED_BUILD.
const identity = process.env.APPLE_SIGNING_IDENTITY;
if (process.env.APPLE_API_KEY && !identity) throw new Error("APPLE_API_KEY is set without APPLE_SIGNING_IDENTITY");
const notarizeWith = process.env.APPLE_API_KEY
  ? {
      appleApiKey: process.env.APPLE_API_KEY,
      appleApiKeyId: required("APPLE_API_KEY_ID"),
      appleApiIssuer: required("APPLE_API_ISSUER"),
    }
  : undefined;

// Forge adds the extension for each platform: icon.icns, icon.ico (scripts/icons.ts).
const icon = join(import.meta.dirname, "icons", "icon");
// WINDOWS_SIGN_WITH_PARAMS, signtool's arguments, signs every executable, the app's and the
// installer's; without it the build is unsigned (README, "Signing and notarization"). signtool's
// path and the timestamp server come from @electron/windows-sign's own WINDOWS_SIGNTOOL_PATH and
// WINDOWS_TIMESTAMP_SERVER. vite.main.config.mts reads this variable too, for SIGNED_BUILD.
// `object`, as the type of `hashes` is an enum @electron/windows-sign does not export as a value, and
// Forge's types leave `windowsSign` out of the Squirrel maker's options, though it passes them on.
const windowsSign: object | undefined = process.env.WINDOWS_SIGN_WITH_PARAMS
  ? { signWithParams: process.env.WINDOWS_SIGN_WITH_PARAMS, hashes: ["sha256"] }
  : undefined;
// The test build's inspector (the fuses below) would run anything under Sanoma's signature.
if (process.env.SANOMA_TEST_BUILD && (identity || windowsSign))
  throw new Error("SANOMA_TEST_BUILD is set on a signed build");

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
    icon,
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
    osxSign: {
      continueOnError: false,
      ...(identity
        ? {
            identity,
            optionsForFile: (file: string) =>
              file.endsWith("/Contents/Resources/node/node")
                ? { entitlements: join(import.meta.dirname, "node.entitlements.plist") }
                : {},
          }
        : { identity: "-", identityValidation: false, optionsForFile: () => ({ hardenedRuntime: false }) }),
    },
    // The app, notarized and stapled before the makers pack it (so the zip's is too).
    osxNotarize: notarizeWith,
    windowsSign,
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
    new MakerDMG({
      icon: `${icon}.icns`,
      ...(identity ? { additionalDMGOptions: { "code-sign": { "signing-identity": identity } } } : {}),
    }),
    // `name` is the package id WINDOWS_APP_ID (src/self-update.ts) is made from.
    new MakerSquirrel({
      name: "Sanoma",
      authors: "Sanoma",
      setupExe: "Sanoma-Setup.exe",
      setupIcon: `${icon}.ico`,
      // Programs and Features takes the icon from a URL.
      iconUrl: "https://raw.githubusercontent.com/Sanoma-AI/sanoma/main/packages/desktop/icons/icon.ico",
      windowsSign,
    } as object),
    new MakerZIP({}, ["darwin"]),
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
      // One-way: a build without it cannot read the cookies one with it wrote (`start` and an ad
      // hoc `package` share an installed release's userData), and a Developer ID of another team
      // asks for Keychain access once. On Windows, with a release's signature too: the key is the
      // user's own there (DPAPI), and nothing asks; the same one-way rule holds.
      [FuseV1Options.EnableCookieEncryption]: Boolean(identity || windowsSign),
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      // On only in the build desktop.yml tests (SANOMA_TEST_BUILD): Playwright drives the packaged
      // app through the inspector. A release never sets it.
      [FuseV1Options.EnableNodeCliInspectArguments]: Boolean(process.env.SANOMA_TEST_BUILD),
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
