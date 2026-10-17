import { allow, approve, approvedFor, definePolicy } from "sanoma";

const EDITOR = "editor";

/**
 * Checked before every call a workflow makes: `allow()`, `deny(reason)` (the run fails) or
 * `approve(who)` (the run waits until that person approves).
 *
 * Anything that publishes or sends needs the editor; everything else is allowed. A call passes
 * when the editor approved an approval in this run that was addressed to them and covers it
 * (`approvedFor`); otherwise it is held until they approve it.
 *
 * Deterministic: the decision depends on the call alone (no clock, randomness or network), so
 * a replayed run decides the same way.
 */
export default definePolicy(({ op, effect, run }) => {
  if (effect !== "publish" && effect !== "send") return allow();
  return approvedFor(run.approvals, op.id, EDITOR) ? allow() : approve(EDITOR);
});
