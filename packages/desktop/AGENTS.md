# Working on @sanoma-ai/desktop

This package is the desktop shell (private, never published): an Electron app that opens a company folder, runs that repo's own `node_modules/sanoma` launcher with the Node it ships, and shows the app in a window. The [README](README.md) says what it does.

- `src/main.ts` is wiring only (windows, menu, IPC, single instance, quit) and the one module that imports `electron`, with `src/preload.cts` (the start window's bridge; CommonJS, as a sandboxed preload must be). Everything else is a plain Node module tested on its own: `launcher.ts` (process groups, ready detection, the launcher's environment), `session.ts` (shims, install, launch), `events.ts`, `companies.ts`, `links.ts`, `shims.ts`, `logs.ts`, `places.ts`, `runtime.ts`. Keep logic out of `main.ts`.
- The shell never adds a runtime concept: no flag, header or User-Agent tells the app it is inside the shell. What the shell needs from the launcher goes through its command line and `SANOMA_EVENTS` lines (#286 L1), with the 0.6.0 fallbacks kept while older launchers are in use.
- No runtime dependencies (`electron` and `electron-builder` are devDependencies; Node and pnpm are staged into `stage/` by `scripts/stage.ts` and copied into the app's resources). The start window is plain HTML and JavaScript in `start/`.
- A company window gets no preload and stays sandboxed; links follow `linkTarget` in `src/links.ts`.

Run `pnpm vitest run packages/desktop`: the process manager against a fake launcher (`test/fixtures/launcher.mjs`) and a fake pnpm, and the pure modules. Electron itself is started only by the smoke test, `pnpm --filter @sanoma-ai/desktop run test:e2e` (`test/e2e`, Playwright; after `build` and `stage:resources`), which CI runs in `desktop.yml` for changes here. To try the shell, `pnpm --filter @sanoma-ai/desktop start <company folder>`.
