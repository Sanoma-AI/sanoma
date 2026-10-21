import { defineSteps } from "@sanoma-ai/workflows";
import { resendOps } from "./connector.ts";

const { create, send } = resendOps.broadcast;
const email = resendOps.emails.send;

/**
 * Resend's steps for Gherkin tests: a draft broadcast before the run (named `broadcast`, so an
 * operation's own test can use `$broadcast.id`), Resend failing the next send, a broadcast the
 * run sent, found by its subject among those seeded and created, and an email the run sent to an
 * address, alone or in its list.
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
        .made(create)
        .filter((c) => c.input.subject === subject)
        .map((c) => c.output.id);
      if (ids.length === 0) return `no Resend broadcast "${subject}" was created`;
      if (run.calls(send).some((c) => ids.includes(c.input.id))) return undefined;
      return `the Resend broadcast "${subject}" (${ids.join(", ")}) was not sent`;
    },
  }));
  then("a Resend email to {string} is sent", (to: string) => ({
    op: email,
    called: true,
    check: (run) => {
      const sent = run.calls(email).map((c) => c.input.to);
      if (sent.some((addresses) => [addresses].flat().includes(to))) return undefined;
      return `no Resend email to ${to} was sent${sent.length ? `; the run sent to ${JSON.stringify(sent)}` : ""}`;
    },
  }));
});
