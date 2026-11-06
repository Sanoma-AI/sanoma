import { defineConnector, defineResource, vendorInfo } from "@sanoma-ai/workflows";
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

/** A box's defaults: Agent37's smallest shape and its plain Linux template, on its shared CPU in `us`. */
export const DEFAULTS = { size: 2, disk: 10, image: "agent37-base", region: "us", type: "default" } as const;

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
      .describe("The template a box runs: `agent37-base` (the default) or one registered in the workspace"),
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

/** What a declaration asks of a box, its defaults filled. */
export type Wanted = Required<Omit<z.infer<typeof instanceSchema>, "id" | "healthy">>;

/** The shape `size` and `memory` name, the memory following the size when it is not given. */
function shapeOf({ size = DEFAULTS.size, memory }: { size?: number; memory?: number }) {
  return SHAPES.find((s) => s.cpu === size && (memory === undefined || s.memory === memory));
}

/**
 * A declaration's fields with the defaults it leaves out, `image` and `size` given (as `open`
 * takes them; empty and 0 give none) over the declared ones, the memory and disk following a size
 * given that differs from the declared one; throws what Agent37 would refuse.
 */
export function wanted(declared: Record<string, unknown>, given: { image?: string; size?: number } = {}): Wanted {
  const resized = !!given.size && given.size !== (declared.size ?? DEFAULTS.size);
  const { memory: _, disk: __, ...rest } = declared;
  const box = instance.schema.parse({
    ...(resized ? rest : declared),
    ...(given.image && { image: given.image }),
    ...(given.size && { size: given.size }),
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

/** The connector's operations: the instance type's (`read`, `import`, `plan`, `create`, `update`, `delete`). */
export const agent37Ops = defineConnector("agent37", { instance }, vendorInfo(import.meta.url));
