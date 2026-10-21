import { z } from "zod";
import { defineConnector } from "./op.ts";
import { defineResource } from "./resource.ts";

// Who exists in a company: people, agents and groups, declared in data files like any resource,
// as the runtime's own vendor's types (`sanoma.person`, `sanoma.agent`, `sanoma.group`, imported
// from "sanoma/resources"). They are `vendorless`: the repo is all there is of them, so they have
// no driver and no drift. A membership is written on a group only, its members references to the
// declared people and agents; every agent is in the group `agents` besides. Who a principal is,
// read from them, is `principalOf` (`shared.ts`).

/** An id or a group's name: one word, as a scenario names an approver. */
const WORD = z.string().regex(/^\S+$/, 'is one word, such as "ada"');
const NONE = { immutable: [], vendorOwned: [], writeOnly: [] };

const person = defineResource({
  vendor: "sanoma",
  type: "person",
  title: "Person",
  identity: "id",
  schema: z.object({
    id: WORD,
    name: z.string().optional(),
    /** Matched first by a sign-in that vouches for an email (GitHub's, its verified public one). */
    email: z.email().optional(),
    /** Their GitHub login, which GitHub sign-in matches, ignoring case, when no email does. */
    github: z
      .string()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, "is a GitHub login, such as ada-ortiz")
      .optional(),
  }),
  fields: NONE,
  find: ({ id }) => id,
  vendorless: true,
});

const agent = defineResource({
  vendor: "sanoma",
  type: "agent",
  title: "Agent",
  identity: "id",
  schema: z.object({ id: WORD, name: z.string().optional(), onBehalfOf: WORD.optional() }),
  fields: { ...NONE, references: { onBehalfOf: { type: "sanoma.person" } } },
  find: ({ id }) => id,
  vendorless: true,
});

const group = defineResource({
  vendor: "sanoma",
  type: "group",
  title: "Group",
  identity: "name",
  schema: z.object({ name: WORD, members: z.array(WORD) }),
  fields: {
    ...NONE,
    unordered: ["members"],
    references: { members: { type: ["sanoma.person", "sanoma.agent"] } },
  },
  find: ({ name }) => name,
  vendorless: true,
});

/**
 * What a data file declares the company's people with, imported from "sanoma/resources":
 * `export const ada = sanoma.person({ id: "ada", name: "Ada Ortiz", github: "ada-ortiz" })`,
 * `sanoma.agent({ id: "refund-bot", onBehalfOf: bo })` and
 * `sanoma.group({ name: "finance", members: [ada, refundBot] })`.
 */
export const sanoma = { person, agent, group };

/**
 * The runtime's own connector of the people types: every config's, so its data files may declare
 * them. Its package is `sanoma`, whose `/resources` entry exports `sanoma`.
 */
export const peopleConnector = defineConnector("sanoma", sanoma, { title: "Sanoma", package: "sanoma" });
