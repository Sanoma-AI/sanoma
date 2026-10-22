import { defineConnector, vendorInfo } from "@sanoma-ai/workflows";
import { z } from "zod";

/**
 * Resend's Broadcasts API (https://resend.com/docs/api-reference/broadcasts) and its one-email send
 * (https://resend.com/docs/api-reference/emails/send-email).
 */
export const resendOps = defineConnector(
  "resend",
  {
    broadcast: {
      create: {
        effect: "write",
        description: "Create a broadcast to an audience. Nothing is sent.",
        input: z.object({
          audience: z.string().min(1),
          from: z.string().optional(),
          subject: z.string().min(1),
          html: z.string(),
        }),
        output: z.object({ id: z.string() }),
      },
      send: {
        effect: "send",
        description: "Send a broadcast to every contact in its audience. Cannot be undone.",
        phrases: { expect: "broadcast {id} is sent" },
        input: z.object({ id: z.string() }),
        output: z.object({ id: z.string(), status: z.enum(["queued", "sent"]) }),
      },
    },
    emails: {
      send: {
        effect: "send",
        description: "Send one email to an address, or to a list of up to 50. Cannot be undone.",
        input: z
          .object({
            to: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(50)]),
            from: z.string().optional(),
            subject: z.string().min(1),
            html: z.string().optional(),
            text: z.string().optional(),
          })
          .refine((email) => Boolean(email.html || email.text), {
            message: "an email needs `html`, `text` or both, not empty",
          }),
        output: z.object({ id: z.string() }),
      },
    },
  },
  vendorInfo(import.meta.url),
);
