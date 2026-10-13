import { defineSteps } from "@sanoma/workflows";
import { resendOps } from "./connector.ts";

const { create, send } = resendOps.broadcast;

/**
 * Resend's steps for Gherkin tests: a draft broadcast before the run (named `broadcast`, so an
 * operation's own test can use `$broadcast.id`), Resend failing the next send, and a broadcast
 * the run sent, found by its subject among those it created.
 */
export const resendSteps = defineSteps("resend", ({ given, then }) => {
  given("a Resend broadcast {string}", (subject: string) => ({
    op: create,
    input: { subject, from: "Sanoma <news@example.com>" },
    as: "broadcast",
  }));
  given("Resend fails to send once", () => ({ op: send, fault: "failNext" }));
  then("the Resend broadcast {string} is sent", (subject: string) => ({
    op: send,
    called: true,
    check: (run) => {
      const ids = run
        .calls(create)
        .filter((c) => (c.input as { subject: string }).subject === subject)
        .map((c) => (c.output as { id: string }).id);
      if (ids.length === 0) return `no Resend broadcast "${subject}" was created`;
      if (run.calls(send).some((c) => ids.includes((c.input as { id: string }).id))) return undefined;
      return `the Resend broadcast "${subject}" (${ids.join(", ")}) was not sent`;
    },
  }));
});
