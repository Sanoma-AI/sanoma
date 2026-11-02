import type { DeclaredPeople } from "./resources.ts";

// What the runtime reads from a company's root that a bundle carries where the root's files are
// not: the Cloudflare host's Worker, which serves the public sites without the working tree. Read
// once beside the files (`readRootSnapshot` in `config.ts`), bundled as data, and registered for
// the root it was read from (`useRootSnapshot`); `readPeople`, `readPolicyFiles`, the app's name
// and its versions then answer from it for that root, and never read a file there.

/** A root's people, policies, app name and versions, as read where its files are. */
export interface RootSnapshot {
  /** The app's name, from the root's `package.json` (`sanoma` without one). */
  appName: string;
  /** `ResolvedConfig.version`: a hash of the workflows' source, which a bundle's code is not, so a run it queues is its worker's. */
  version: string;
  /** `ResolvedConfig.changeCode`, for the same reason. */
  changeCode: string;
  /** `readPolicyFiles`: each `.cedar` file under `policies/` (and an app's), by path from the root. */
  policies: { file: string; text: string }[];
  /** `readPeople`: the people, agents and groups the data files declare, with their problems. */
  people: DeclaredPeople;
}

const snapshots = new Map<string, RootSnapshot>();

/** From now on, `root`'s people, policies, app name and versions are `snapshot`'s, not its files'. */
export function useRootSnapshot(root: string, snapshot: RootSnapshot): void {
  snapshots.set(root, snapshot);
}

/** The snapshot registered for `root`, if any. */
export const rootSnapshot = (root: string | undefined): RootSnapshot | undefined =>
  root === undefined ? undefined : snapshots.get(root);

/**
 * Where a bundle says which company file it is evaluating (the Worker's build sets it at the top
 * of each), for `callerFile` where V8's call sites name no file: a workflow's `file`, and a
 * collection's app, are the file's that defined them.
 */
export const BUNDLED_FILE: unique symbol = Symbol.for("sanoma.file") as never;

/** The company file a bundle is evaluating now, if it says. */
export const bundledFile = (): string | undefined => (globalThis as { [BUNDLED_FILE]?: string })[BUNDLED_FILE];
