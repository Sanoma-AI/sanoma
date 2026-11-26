import { z } from "zod";

// The rules a box's name and hosts are held to, as the Cloud checks them: the backend and the
// fake before they start a box's workflow, and the service on the other side of the connector,
// whose workflows import them from the package root. Zod alone: no driver, no secret.

/** One label of a domain name. */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

/**
 * A box's name, as the app makes one (`sanoma-<company>-<person>`, each escaped): lowercase
 * letters, digits, `-`, `_` and `%XX` escapes, at most 200 characters.
 */
const BoxName = z
  .string()
  .max(200)
  .regex(/^[a-z0-9](?:[a-z0-9_-]|%[0-9A-F]{2})*$/, "is no box name: lowercase letters, digits, - and _");

/**
 * A host a box may reach: a domain name, never an address, or `*.` and a domain of two labels or
 * more, for its subdomains (Copilot's `*.githubcopilot.com`); 253 characters at most.
 */
const BoxHost = z
  .string()
  .max(253)
  .regex(new RegExp(`^(?:\\*\\.)?(?:${LABEL}\\.)+[a-z]{2,63}$`), "is no domain name");

/** What the boxes' workflows take, as the Cloud checks it and the backend before it starts one. */
export const BOX_INPUTS = {
  name: z.object({ name: BoxName }),
  open: z.object({ name: BoxName, hosts: z.array(BoxHost).min(1).max(100) }),
} as const;

/** What is wrong with `input` as `schema` reads it, said for people; undefined when nothing is. */
export function boxProblem(schema: z.ZodType, input: unknown): string | undefined {
  const issues = schema.safeParse(input).error?.issues;
  return issues?.map((i) => `${i.path.join(".") || "the input"} ${i.message}`).join("; ");
}
