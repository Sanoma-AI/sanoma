import { defineConnector, defineResource, type OpSpec, vendorInfo } from "sanoma/workflows";
import { z } from "zod";

/*
 * Agent37 Cloud (https://www.agent37.com/docs), whose instances are persistent Linux computers:
 * the boxes a coding agent works in. No SDK exists, so the calls are `fetch` (`api.ts`). The
 * schema is a cut of Agent37's own field names, by hand.
 */

/** Agent37's shapes, vCPUs and memory in GB, with the largest disk each takes in GB. */
const SHAPES = [
  { cpu: 2, memory: 4, disk: 12 },
  { cpu: 4, memory: 8, disk: 20 },
  { cpu: 4, memory: 16, disk: 40 },
  { cpu: 4, memory: 32, disk: 80 },
] as const;

/**
 * A box's defaults: Agent37's smallest shape on its shared CPU in `us`. Its image, when none is
 * declared, is Sanoma's box image of this release (`backend.ts`), else `BASE`.
 */
export const DEFAULTS = { size: 2, disk: 10, region: "us", type: "default" } as const;

/** Agent37's plain Linux template: a box's when Sanoma's box image cannot be had. */
export const BASE = "agent37-base";

const instanceSchema = z
  .object({
    size: z
      .union([z.literal(2), z.literal(4)])
      .optional()
      .describe("Each box's vCPUs, 2 (the default) or 4; a box that exists keeps its shape"),
    memory: z
      .number()
      .int()
      .optional()
      .describe("Each box's memory in GB: 4 with 2 vCPUs, 8 (the default), 16 or 32 with 4"),
    disk: z.number().int().min(2).optional().describe("Each box's disk in GB, billed in every state; default 10"),
    image: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The template a box runs: by default Sanoma's box image of this release, registered in the workspace; or `agent37-base`, or another template of the workspace",
      ),
    region: z
      .enum(["us", "eu", "ap-south"])
      .optional()
      .describe("Where boxes run, `us` (the default); `eu` and `ap-south` run `vm` and `performance` boxes only"),
    type: z
      .enum(["default", "vm", "performance"])
      .optional()
      .describe("`default` (shared CPU, the default), `vm` (a kernel of its own) or `performance` (cores held for it)"),
    id: z.string().optional().describe("What the declaration is bound by: boxes are made as people open them"),
    healthy: z.boolean().optional().describe("Whether the key lists the workspace's instances"),
  })
  .refine(
    (box) => shapeOf(box) !== undefined,
    "Agent37's shapes are 2 vCPUs with 4 GB, and 4 vCPUs with 8, 16 or 32 GB",
  )
  .refine((box) => (box.disk ?? DEFAULTS.disk) <= (shapeOf(box)?.disk ?? Infinity), {
    message: "the disk is larger than the shape takes (12 GB with 2 vCPUs; 20, 40 or 80 GB with 4)",
    path: ["disk"],
  })
  .refine((box) => (box.region ?? DEFAULTS.region) === "us" || (box.type ?? DEFAULTS.type) !== "default", {
    message: "only `us` runs the `default` type: `eu` and `ap-south` run `vm` and `performance`",
    path: ["type"],
  });

/** What a declaration asks of a box, its defaults filled: its image only when declared or given. */
export type Wanted = Required<Omit<z.infer<typeof instanceSchema>, "id" | "healthy" | "image">> & { image?: string };

/** The shape `size` and `memory` name, the memory following the size when it is not given. */
function shapeOf({ size = DEFAULTS.size, memory }: { size?: number; memory?: number }) {
  return SHAPES.find((s) => s.cpu === size && (memory === undefined || s.memory === memory));
}

/**
 * A declaration's fields with the defaults it leaves out, `image` and `size` given (as `open`
 * takes them) over the declared ones, the memory and disk following a size given that differs
 * from the declared one; throws what Agent37 would refuse.
 */
export function wanted(declared: Record<string, unknown>, given: { image?: string; size?: number } = {}): Wanted {
  const resized = given.size !== undefined && given.size !== (declared.size ?? DEFAULTS.size);
  const { memory: _, disk: __, ...rest } = declared;
  const box = instance.schema.parse({
    ...(resized ? rest : declared),
    ...(given.image && { image: given.image }),
    ...(given.size !== undefined && { size: given.size }),
  });
  const size = box.size ?? DEFAULTS.size;
  return { ...DEFAULTS, ...box, size, memory: box.memory ?? shapeOf({ size })!.memory };
}

/**
 * `agent37.instance({ size?, memory?, disk?, image?, region?, type? })`: the boxes coding agents
 * work in, one Agent37 instance each, which meets the `Sandbox` contract. The declaration is a
 * record: apply makes nothing at Agent37, and a box is made when someone first opens it
 * (`ConnectorSetup.sandbox`), from the shape declared then. Its state is the declaration's binding
 * and whether the key lists the workspace's instances.
 */
export const instance = defineResource({
  vendor: "agent37",
  type: "instance",
  title: "Instance",
  schema: instanceSchema,
  fields: { immutable: [], vendorOwned: ["id", "healthy"], writeOnly: [] },
  // Nothing at Agent37 holds a declaration to compare with: a change reaches the next box made.
  normalize: () => ({}),
  writable: true,
  sandbox: {
    capabilities: { snapshot: true, pause: true, port: true },
    inputs: { image: "image", size: "size" },
    outputs: (state) => ({ id: String(state.id), healthy: state.healthy === true }),
  },
});

const boxName = z.string().min(1).describe("The box's name, which it is found by");
const groupName = z.string().min(1).describe("The group the box is labelled with, such as the company it is for");
const ttl = z
  .number()
  .int()
  .min(60)
  .max(604_800)
  .describe("How long the link works, in seconds: 60 to 604800 (7 days). It cannot be revoked sooner");
/** A signed link to one port of a box: it needs no key until it expires. */
const link = {
  url: z.string().describe("The link: the port's URL with its token in `a37_token`"),
  expiresAt: z.iso.datetime().describe("When the link stops working, ISO 8601"),
};
const ids = z.object({ ids: z.array(z.string()).describe("The instances it acted on") });
const byName = ({ name }: { name: string }) => name;
const byGroup = ({ group }: { group: string }) => `group/${group}`;

/**
 * Boxes opened by a caller that holds the key for someone who must not (Sanoma's control plane, for
 * a company's own instance): each open or expose hands back a signed link, which reaches one port
 * of the box with no key. A box is found by its name in its metadata, as the sandbox half finds one.
 */
const boxSpecs = {
  open: {
    // It makes or wakes a box, and mints a link that reaches it.
    effect: "access",
    // A retry finds the box made; each try mints another link. Opens of one name wait for each
    // other in one process, not across processes.
    idempotent: true,
    description:
      "Open the box `name` (find it or make it, labelled with `group`, wake it, start Sanoma's runner and put pnpm in it) and mint a signed link to its runner's port. A box of that name in another group, or in none, is refused. Opens of one name at once in two processes can make two boxes",
    input: z.object({
      name: boxName,
      group: groupName,
      network: z
        .array(z.string().min(1))
        .min(1)
        .max(100)
        .optional()
        .describe(
          "The domains and addresses a new box may reach, up to 100; anywhere when left out. A box that exists keeps its own",
        ),
      ttl,
    }),
    output: z.object({
      id: z.string().describe("The box's instance"),
      ...link,
      protocol: z.number().int().describe("The runner protocol of this release, which the box's runner now speaks"),
    }),
    target: byName,
    // A link that opens the box: the ledger records that there was one, not what it was.
    opaque: ["url"],
  },
  expose: {
    effect: "access",
    idempotent: true,
    description: "Mint a signed link to another port of the box `name`, such as an agent's bridge",
    input: z.object({ name: boxName, port: z.number().int().min(1).max(65_535).describe("The port"), ttl }),
    output: z.object(link),
    target: byName,
    opaque: ["url"],
  },
  sleep: {
    effect: "write",
    idempotent: true,
    description: "Put the box `name` to sleep, its memory kept; nothing when there is none",
    input: z.object({ name: boxName }),
    output: ids,
    target: byName,
  },
  discard: {
    effect: "write",
    // A box gone already is done.
    idempotent: true,
    description: "Delete the box `name`, or every box labelled with `group`",
    input: z
      .object({ name: boxName.optional(), group: groupName.optional() })
      .refine(({ name, group }) => (name === undefined) !== (group === undefined), "give `name` or `group`, not both"),
    output: ids,
    target: ({ name, group }: { name?: string; group?: string }) => name ?? `group/${group}`,
  },
  list: {
    effect: "read",
    idempotent: true,
    description: "The boxes labelled with `group`",
    input: z.object({ group: groupName }),
    output: z.object({
      boxes: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          awake: z
            .boolean()
            .describe("It is neither asleep, stopped nor failed: it counts toward the workspace's limit"),
        }),
      ),
    }),
    target: byGroup,
  },
} satisfies Record<string, OpSpec>;

/**
 * The connector's operations: the instance type's (`read`, `import`, `plan`, `create`, `update`,
 * `delete`), and the boxes' (`box.open`, `.expose`, `.sleep`, `.discard`, `.list`).
 */
export const agent37Ops = defineConnector("agent37", { instance, box: boxSpecs }, vendorInfo(import.meta.url));
