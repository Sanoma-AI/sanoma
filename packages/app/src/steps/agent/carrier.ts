import { join } from "node:path";
import { type Box, draftBranch, type SandboxBackend, type Source } from "@sanoma-ai/workflows";
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
/** The head the box and the instance both have, beside the clone's git files (gone with the clone, out of an agent's reach). */
const KNOWN = `${CLONE}/.git/sanoma-head`;

/** What a turn refused while another runs in the same box is told. */
export const BOX_BUSY = "A turn is already running in your box: wait for it to end, then send this again";

/** The boxes a turn runs in now, by name. */
const busy = new Set<string>();

/**
 * Runs `use` in the box `box.name` of `backend`, opened for it and stopped at its end however it
 * ends, alone: a second turn in the same box while one runs is refused (`BOX_BUSY`).
 */
export async function boxTurn<T>(
  backend: SandboxBackend,
  box: Parameters<SandboxBackend["open"]>[0],
  use: (box: Box) => Promise<T>,
): Promise<T> {
  if (busy.has(box.name)) throw new Error(BOX_BUSY);
  busy.add(box.name);
  try {
    const opened = await backend.open(box);
    try {
      return await use(opened);
    } finally {
      await opened.stop();
    }
  } finally {
    busy.delete(box.name);
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
 * install stays in the box. The clone's path, the agent's working directory, and the head given.
 */
export async function carryIn(
  box: Box,
  source: Source | undefined,
  id: string,
  home: string,
): Promise<{ root: string; head: string }> {
  const known = await box.read(KNOWN);
  const { bytes, head } = await carrying(source).bundle(id, {
    ...(known && { since: new TextDecoder().decode(known).trim() }),
  });
  try {
    if (bytes.length) await box.write(BUNDLE, bytes);
    await inBox(box, IN, { BRANCH: draftBranch(id), HEAD: head, BUNDLE: bytes.length ? BUNDLE : "" });
  } catch (err) {
    throw new Error(`The draft could not be brought into your box (${errorMessage(err)})`, { cause: err });
  }
  return { root: join(home, CLONE), head };
}

/** The box's side of `carryIn`, in its home. */
const IN = `set -eu
mkdir -p "${CLONE}"
cd "${CLONE}"
[ -d .git ] || git init --quiet
if [ -n "$BUNDLE" ]; then
  git fetch --quiet --no-tags "$HOME/$BUNDLE" "refs/heads/$BRANCH"
  rm -f "$HOME/$BUNDLE"
fi
git checkout --quiet --force -B "$BRANCH" "$HEAD"
git clean --quiet --force -d
printf %s "$HEAD" > .git/sanoma-head
if [ -f pnpm-lock.yaml ]; then
  lock=$(git hash-object pnpm-lock.yaml)
  if [ "$lock" != "$(cat .git/sanoma-lockfile 2>/dev/null || true)" ]; then
    pnpm install --frozen-lockfile
    printf %s "$lock" > .git/sanoma-lockfile
  fi
fi`;

/**
 * Brings what the turn changed in `box`'s clone back to the draft `id`: committed there as `author`
 * with `message`, bundled since `since` (the head `carryIn` gave), and fetched into the draft's
 * checkout as a fast-forward (`Source.unbundle`). Whether it brought any commit. A box that fails
 * on the way (one that stopped mid-turn) loses the turn's edits, and says so: the next turn starts
 * again from the draft.
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
    await inBox(box, OUT, {
      BRANCH: draftBranch(id),
      SINCE: since,
      BUNDLE,
      MESSAGE: message,
      GIT_AUTHOR_NAME: as,
      GIT_COMMITTER_NAME: as,
      GIT_AUTHOR_EMAIL: NO_EMAIL,
      GIT_COMMITTER_EMAIL: NO_EMAIL,
    });
    bytes = await box.read(BUNDLE);
  } catch (err) {
    throw new Error(
      `The agent's edits could not be brought back from your box, which may have stopped mid-turn, so they are lost; the next turn starts again from the draft (${errorMessage(err)})`,
      { cause: err },
    );
  }
  if (!bytes) return false;
  const { head } = await repository.unbundle(id, bytes);
  await box.write(KNOWN, new TextEncoder().encode(head));
  return true;
}

/** The email of a commit made in a box: none of a person's, which the box never holds. */
const NO_EMAIL = "noreply@sanoma.invalid";

/** The box's side of `carryOut`, in its home: a bundle only when the branch moved. */
const OUT = `set -eu
rm -f "$BUNDLE"
cd "${CLONE}"
git add --all
git diff --cached --quiet || git commit --quiet --no-verify -m "$MESSAGE"
[ "$(git rev-parse "refs/heads/$BRANCH")" = "$SINCE" ] && exit 0
git bundle create --quiet "$HOME/$BUNDLE" "refs/heads/$BRANCH" "^$SINCE"`;

/** Runs `script` in `box` with `env`; an error with its exit code and the end of what it printed, unless it exits 0. */
async function inBox(box: Box, script: string, env: Record<string, string>): Promise<void> {
  const ran = await box.run(script, { env });
  const [out, err, { exitCode }] = await Promise.all([
    new Response(ran.stdout).text(),
    new Response(ran.stderr).text(),
    ran.wait(),
  ]);
  if (exitCode === 0) return;
  const said = `${out}\n${err}`.trim().split("\n").slice(-5).join("\n");
  throw new Error(`exit ${exitCode}${said ? `: ${said}` : ""}`);
}
