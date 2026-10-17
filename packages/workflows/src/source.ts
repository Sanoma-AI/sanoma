// Where a company's files live, and how a change to them is recorded: a git repository on this
// machine, or one a host cloned. The runtime's writers (the app's Adopt, apply's lockfile) change
// files under `root`, then commit them through it. The launcher makes one; a config without one
// writes the files and commits nothing.

/** A company's repository, as the runtime writes to it. */
export interface Source {
  /** The repository's root directory. */
  root: string;
  /**
   * Records the files at `paths`, relative to `root`, as one change by `author` (who made it, as
   * the app names them: a login or a typed name). Its revision; undefined when nothing changed.
   */
  commit(change: {
    paths: string[];
    message: string;
    author: string;
  }): { revision: string } | undefined | Promise<{ revision: string } | undefined>;
  /** The revision `ref` names, the checked-out one by default. */
  head(ref?: string): string | Promise<string>;
  /** Pushes `ref` to the repository at `url`, signed in with `token`. */
  push?(target: { url: string; token: string; ref: string }): void | Promise<void>;
}
