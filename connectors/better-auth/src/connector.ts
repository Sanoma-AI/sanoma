import { defineConnector, defineDriver, vendorInfo } from "@sanoma-ai/workflows";
import { z } from "zod";

/** Better Auth: no operations; its login half is in `login.ts`. */
export const betterAuthOps = defineConnector("better-auth", {}, vendorInfo(import.meta.url));

/** Implements nothing: its `env` puts `BETTER_AUTH_SECRET` on the connector page. */
export const betterAuthDriver = defineDriver(
  betterAuthOps,
  {},
  {
    env: z.object({
      BETTER_AUTH_SECRET: z
        .string()
        .min(32)
        .describe(
          "signs visitors' session cookies: 32 random characters or more, such as the output of openssl rand -base64 32",
        ),
    }),
  },
);
