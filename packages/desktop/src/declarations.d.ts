// What Forge's Vite plugin defines in the main process for the `start` renderer (forge.config.mts):
// its dev server under `pnpm start`, undefined in a build, and its folder under .vite/renderer.
declare const START_VITE_DEV_SERVER_URL: string | undefined;
declare const START_VITE_NAME: string;
