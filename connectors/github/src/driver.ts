import { defineDriver, DriverError, type DriverFn } from "@sanoma/workflows";
import { fromTfState, type TfResourceType, toTfState } from "@sanoma/workflows/tfschema";
import { type BridgeLike, type BridgeResource, bridgeErrorOf } from "./bridge.ts";
import { github } from "./index.ts";
import { github_branch_protection, github_repository, github_team_membership, provider } from "./resources.gen.ts";

export type { BridgeLike, Diagnostic, ProviderRef } from "./bridge.ts";

/** Each resource type's provider type, by the connector's name for it. */
export const TYPES = {
  repository: github_repository,
  branch_protection: github_branch_protection,
  team_membership: github_team_membership,
} as const satisfies Record<string, TfResourceType>;

export interface GithubDriverOptions {
  /** The provider bridge, started by the config (`startBridge`). One per tenant: it holds the token once configured. */
  bridge: BridgeLike;
  /** The organization or user whose resources the ids name. Default: the token's own user. */
  owner?: string;
}

/**
 * Reads GitHub resources through the `integrations/github` OpenTofu provider on `bridge`, with
 * the token in `GITHUB_TOKEN`, read on every call. The provider is configured on the first call,
 * and again when the token changes or the provider has exited.
 */
export function githubDriver(options: GithubDriverOptions) {
  return defineDriver(
    github,
    githubOps(options.bridge, () => {
      const token = process.env.GITHUB_TOKEN;
      if (!token) throw new DriverError("github: GITHUB_TOKEN is not set", { retryable: false });
      return { owner: options.owner ?? null, token };
    }),
  );
}

/** The driver's operations over `bridge`, configuring the provider with what `config` returns. The fake passes its own. */
export function githubOps(bridge: BridgeLike, config: () => Record<string, unknown>) {
  const ops = bridgedOps("github", bridge, config);
  return {
    repository: ops(TYPES.repository),
    branch_protection: ops(TYPES.branch_protection),
    team_membership: ops(TYPES.team_membership),
  };
}

/**
 * `import` and `read` for a provider's resource types over the bridge. `import` asks the
 * provider to find the object by its import id (it reads it too). `read` refreshes a state
 * from an earlier call, or, given none, imports first and reads what the import returned.
 * States go out in the resource's shape, with secrets dropped (`fromTfState`), and come back
 * in the provider's (`toTfState`).
 */
function bridgedOps(vendor: string, bridge: BridgeLike, config: () => Record<string, unknown>) {
  let configured: { config: string; done: Promise<unknown> } | undefined;

  async function configure() {
    const json = JSON.stringify(config());
    if (configured?.config !== json) {
      // The bridge refuses another config for a configured provider until it is closed.
      if (configured) {
        configured = undefined;
        await bridge.close(provider);
      }
      const done = bridge.configure(provider, json);
      configured = { config: json, done };
      done.catch(() => {
        if (configured?.done === done) configured = undefined;
      });
    }
    await configured.done;
  }

  /** Runs `fn` on a configured provider, with the bridge's errors as `DriverError`s. */
  async function call<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      await configure();
      return await fn();
    } catch (e) {
      const err = bridgeErrorOf(e);
      if (!err) throw e;
      // The provider process failed or exited: configure it again on the next try.
      if (err.code === "unavailable") configured = undefined;
      const said = err.diagnostics.map((d) => (d.detail ? `${d.summary}: ${d.detail}` : d.summary)).join("; ");
      throw new DriverError(`${vendor}: ${op} failed (${err.code}): ${said || err.message}`, {
        retryable: err.code === "unavailable",
        vendorCode: err.code,
        cause: e,
      });
    }
  }

  return (type: TfResourceType) => {
    const op = (name: string) => `${type.typeName.replace(`${vendor}_`, "")}.${name}`;
    const importOne = async (id: string): Promise<BridgeResource> => {
      const { resources } = await bridge.import(provider, type.typeName, id);
      const found = resources.find((r) => r.typeName === type.typeName);
      if (found) return found;
      throw new DriverError(`${vendor}: ${op("import")} found no ${type.typeName} "${id}"`, {
        retryable: false,
        vendorCode: "not_found",
      });
    };
    const out = (r: BridgeResource) => ({
      state: fromTfState(type.shape, JSON.parse(r.stateJson) as Record<string, unknown>),
      ...(r.private.length > 0 && { private: Buffer.from(r.private).toString("base64") }),
      schemaVersion: r.schemaVersion,
    });

    const importOp: DriverFn<any, any> = ({ id }: { id: string }) =>
      call(op("import"), async () => ({ id, ...out(await importOne(id)) }));

    const readOp: DriverFn<any, any> = (input: {
      id: string;
      state?: Record<string, unknown>;
      private?: string;
      schemaVersion?: number;
    }) =>
      call(op("read"), async () => {
        const from: Omit<BridgeResource, "typeName"> = input.state
          ? {
              stateJson: JSON.stringify(toTfState(type.shape, input.state)),
              private: Buffer.from(input.private ?? "", "base64"),
              schemaVersion: input.schemaVersion ?? type.schemaVersion,
            }
          : await importOne(input.id);
        const reply = await bridge.read(provider, type.typeName, from.stateJson, from.private, from.schemaVersion);
        if (reply.gone || !reply.resource) return { id: input.id, gone: true };
        return { id: input.id, gone: false, ...out(reply.resource) };
      });

    return { import: importOp, read: readOp };
  };
}
