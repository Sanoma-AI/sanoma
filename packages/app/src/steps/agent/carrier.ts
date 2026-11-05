import { join } from "node:path";
import { type Box, draftBranch, type Source } from "@sanoma-ai/workflows";
import { errorMessage } from "@sanoma-ai/workflows/shared";

// Git between the live instance and a person's box: before a turn, the draft's branch carried into
// the box's clone as a git bundle (its commits since the head the box last had); after it, the
// box's new commits carried back the same way and fetched into the draft's checkout, where the
// checks and the diff run. A bundle holds commits and a branch's name alone, so nothing of the
// repository's remote, its token or the company's secrets enters the box. One turn at a time in a
// box, which is opened for the turn and stopped at its end.

/** The draft's clone in a box, relative to its home: one per box, on the branch of the turn's draft. */
export const CLONE = "repo";
/** Where a bundle waits in a box, relative to its home, on its way in or out. */
const BUNDLE = ".sanoma-draft.bundle";
/** Beside the clone's git files (gone with the clone, out of an agent's reach), relative to the clone: the box's head the instance last knew of, and the lockfile last installed. */
const HEAD_FILE = ".git/sanoma-head";
const LOCK_FILE = ".git/sanoma-lockfile";

/** What a turn refused while another runs in the same box is told. */
export const BOX_BUSY = "A turn is already running in your box: wait for it to end, then send this again";

/** The boxes a turn runs in now, by name. */
const busy = new Set<string>();

/**
 * Runs `use` in the box `name`, opened for it (`open`) and stopped at its end however it ends,
 * alone: a second turn in the same box while one runs is refused (`BOX_BUSY`).
 */
export async function boxTurn<T>(name: string, open: () => Promise<Box>, use: (box: Box) => Promise<T>): Promise<T> {
  if (busy.has(name)) throw new Error(BOX_BUSY);
  busy.add(name);
  try {
    const box = await open();
    try {
      return await use(box);
    } finally {
      await box.stop();
    }
  } finally {
    busy.delete(name);
  }
}

/** A repository that carries drafts to a box and back. */
type Carrying = Source & Required<Pick<Source, "bundle" | "unbundle">>;

function carrying(source: Source | undefined): Carrying {
  if (!source?.bundle || !source.unbundle) throw new Error("This instance's repository cannot carry a draft to a box");
  return source as Carrying;
}

/**
 * Brings the draft `id` into `box` (whose home is `home`): its branch bundled since the head the
 * box last had (the whole of it the first time), fetched into the box's clone (made the first
 * time) and checked out there as the instance has it, whatever a turn that died left behind; then
 * `pnpm install --frozen-lockfile` when the lockfile differs from the one last installed, so the
 * install stays in the box. An install that fails is logged and tried again next turn: the turn
 * goes on, since its agent cannot run one. `signal` stops it. The clone's path, the agent's
 * working directory, and the head given.
 */
export async function carryIn(
  box: Box,
  source: Source | undefined,
  id: string,
  { home, signal }: { home: string; signal?: AbortSignal },
): Promise<{ root: string; head: string }> {
  const known = await box.read(`${CLONE}/${HEAD_FILE}`);
  const { bytes, head } = await carrying(source).bundle(id, {
    ...(known && { since: new TextDecoder().decode(known).trim() }),
  });
  const bundle = bytes.length ? BUNDLE : "";
  try {
    if (bundle) await box.write(bundle, bytes);
    await inBox(box, IN, { BRANCH: draftBranch(id), HEAD: head, BUNDLE: bundle }, signal);
  } catch (err) {
    throw new Error(`The draft could not be brought into your box (${errorMessage(err)})`, { cause: err });
  }
  try {
    // Never longer than this, whatever the registry does.
    const stop = AbortSignal.timeout(INSTALL_TIMEOUT_MS);
    await inBox(box, INSTALL, {}, signal ? AbortSignal.any([signal, stop]) : stop);
  } catch (err) {
    if (!signal?.aborted) console.error(`sanoma app: the install in the box ${box.id} failed:`, errorMessage(err));
  }
  return { root: join(home, CLONE), head };
}

/** How long the clone's install may take. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** The box's side of `carryIn`, in its home: the clone at the draft's head, clean (a lock a turn that died left, too). */
const IN = `set -eu
mkdir -p ${CLONE}
cd ${CLONE}
[ -d .git ] || git init --quiet
if [ -n "$BUNDLE" ]; then
  git fetch --quiet --no-tags "$HOME/$BUNDLE" "refs/heads/$BRANCH"
  rm -f "$HOME/$BUNDLE"
fi
rm -f .git/index.lock
git checkout --quiet --force -B "$BRANCH" "$HEAD"
git clean --quiet --force -d
printf %s "$HEAD" > ${HEAD_FILE}`;

/** The clone's install, when its lockfile is not the one last installed: no script of the repository's runs (the agent wrote them, and may run none). */
const INSTALL = `set -eu
cd ${CLONE}
[ -f pnpm-lock.yaml ] || exit 0
lock=$(git hash-object pnpm-lock.yaml)
[ "$lock" = "$(cat ${LOCK_FILE} 2>/dev/null || true)" ] && exit 0
pnpm install --frozen-lockfile --ignore-scripts
printf %s "$lock" > ${LOCK_FILE}`;

/**
 * Brings what the turn changed in `box`'s clone back to the draft `id`: committed there as `author`
 * with `message`, bundled since `since` (the head `carryIn` gave), and fetched into the draft's
 * checkout as a fast-forward (`Source.unbundle`). Whether it brought any commit. Never stopped by
 * the turn's signal: a stopped turn's edits are kept too. When it fails (a box that stopped
 * mid-turn, a draft that moved meanwhile), the turn's edits are lost, and it says so: the next turn
 * starts again from the draft.
 */
export async function carryOut(
  box: Box,
  source: Source | undefined,
  id: string,
  { since, message, author }: { since: string; message: string; author: string },
): Promise<boolean> {
  const repository = carrying(source);
  let bytes: Uint8Array | null;
  try {
    // Committed as the person, through Sanoma; the box has no git identity of its own.
    const as = `${author} via Sanoma`;
    const said = await inBox(box, OUT, {
      BRANCH: draftBranch(id),
      SINCE: since,
      MESSAGE: message,
      GIT_AUTHOR_NAME: as,
      GIT_COMMITTER_NAME: as,
      GIT_AUTHOR_EMAIL: NO_EMAIL,
      GIT_COMMITTER_EMAIL: NO_EMAIL,
    });
    if (said.split("\n").at(-1) !== "bundled") return false;
    bytes = await box.read(BUNDLE);
    if (!bytes) throw new Error(`${BUNDLE} is gone`);
  } catch (err) {
    throw lost("from your box, which may have stopped mid-turn", err);
  }
  try {
    await repository.unbundle(id, bytes);
  } catch (err) {
    throw lost("into the draft", err);
  }
  return true;
}

/** What a turn whose edits could not be brought back `where` fails with. */
const lost = (where: string, err: unknown) =>
  new Error(
    `The agent's edits could not be brought back ${where}, so they are lost; the next turn starts again from the draft (${errorMessage(err)})`,
    { cause: err },
  );

/** The email of a commit made in a box: none of a person's, which the box never holds. */
const NO_EMAIL = "noreply@sanoma.invalid";

/**
 * The box's side of `carryOut`, in its home: a bundle only when the branch moved, said so, and its
 * new head kept as the one the instance knows of (were the instance to lack it, its next bundle is
 * the whole branch).
 */
const OUT = `set -eu
rm -f ${BUNDLE}
cd ${CLONE}
git add --all
git diff --cached --quiet || git commit --quiet --no-verify -m "$MESSAGE"
head=$(git rev-parse "refs/heads/$BRANCH")
[ "$head" = "$SINCE" ] && exit 0
git bundle create --quiet "$HOME/${BUNDLE}" "refs/heads/$BRANCH" "^$SINCE"
printf %s "$head" > ${HEAD_FILE}
echo bundled`;

/**
 * Git's settings in a box: none of its home's, where the agent may write (a hook, an fsmonitor or a
 * filter there would run its commands), nor the system's.
 */
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

/** Runs `script` in `box`'s home with `env`: what it printed, trimmed; an error with its exit code and the end of its output, unless it exits 0. */
async function inBox(box: Box, script: string, env: Record<string, string>, signal?: AbortSignal): Promise<string> {
  const ran = await box.run(script, { cwd: ".", env: { ...GIT_ENV, ...env }, ...(signal && { signal }) });
  const [out, err, { exitCode }] = await Promise.all([
    new Response(ran.stdout).text(),
    new Response(ran.stderr).text(),
    ran.wait(),
  ]);
  if (exitCode === 0) return out.trim();
  const said = `${out}\n${err}`.trim().split("\n").slice(-5).join("\n");
  throw new Error(`exit code ${exitCode}${said ? `: ${said}` : ""}`);
}
