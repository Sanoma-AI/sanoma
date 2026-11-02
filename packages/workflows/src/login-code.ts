import { z } from "zod";
import { defineWorkflow, type WorkflowDefinition } from "./define.ts";
import type { Login } from "./config.ts";
import type { Op } from "./op.ts";
import { openLoginCode } from "./seal.ts";
import type { LOGIN_CODE_WORKFLOW } from "./shared.ts";

// The built-in `login-code` workflow: one mail with a sign-in code, through the config's
// `login.sender`, from its `login.from`. The app starts it as the runtime's agent `login`
// (`LOGIN_AGENT`) with the code sealed (`sealLoginCode`), so neither the run's input nor the
// ledger shows it: the call is recorded with its body as `<text>` (`recorded` in `call.ts`). It
// is a workflow like any other: the call goes through `ctx`, under the policy, in the ledger.

/** An operation on `ctx`. */
type OpCall = (input: unknown) => Promise<unknown>;

/** The workflow's input: to whom, and the code, sealed. */
const LoginCodeInput = z.object({ to: z.string().min(1), code: z.string().min(1) });

/** What a sign-in code is sent as, from `from`, for checks before any is: a sender must take it, and the policy is asked about it. */
export const codeMail = (from: string) => ({
  from,
  to: "person@example.com",
  subject: "Your sign-in code",
  text: "<text>",
});

/** The mail's text: the code, what it is for, and how long it lasts; nothing else, and no link. */
const textOf = (company: string, code: string) =>
  `Your sign-in code for ${company} is ${code}.\n\n` +
  "It works once, for five minutes. If you did not ask for it, ignore this mail.\n";

/** The login-code workflow for a config: it sends through `sender`, from `from`, saying it is `company`'s. */
export function loginCodeWorkflow(
  { sender, from }: Login,
  company: string,
): WorkflowDefinition<readonly Op[], typeof LoginCodeInput> {
  return defineWorkflow({
    // The literal, held to the one name: the outline finds a workflow by a string, or a const of its own file.
    name: "login-code" satisfies typeof LOGIN_CODE_WORKFLOW,
    title: "Send a sign-in code",
    trigger: "manual",
    input: LoginCodeInput,
    uses: [sender],
    run: async (ctx, input) => {
      const { vendor, resource, name } = sender;
      const mail = {
        from,
        to: input.to,
        subject: `Your ${company} sign-in code`,
        text: textOf(company, openLoginCode(input.code, input.to)),
      };
      // `ctx` called directly, so the outline places the call.
      return (ctx as unknown as Record<string, Record<string, Record<string, OpCall>>>)[vendor]![resource]![name]!(
        mail,
      );
    },
  });
}
