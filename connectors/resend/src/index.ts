import { defineConnector } from "@sanoma/workflows";
import { z } from "zod";

/** Resend Broadcasts API: https://resend.com/docs/api-reference/broadcasts */
export const resend = defineConnector("resend", {
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
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), status: z.enum(["queued", "sent"]) }),
    },
  },
});
