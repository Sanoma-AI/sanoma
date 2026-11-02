import { defaultBridge, type BridgeError, type ProviderClient } from "@sanoma-ai/bridge";
import { AuthenticationError, DriverError, type CallContext, type Driver } from "@sanoma-ai/workflows";
import { accountOf, federationCredentials, identityFor, type GcpIdentities } from "./authentication.ts";
import { gcpTf } from "./connector.ts";
import { constrain, retainKeys } from "./constraints.ts";

export function gcpDriver(identities: GcpIdentities, bridge: ProviderClient = defaultBridge()): Driver {
  return {
    vendor: "gcp",
    authentication: ["workloadIdentity"],
    ops: Object.fromEntries(
      Object.keys(gcpTf.driver(bridge, () => ({})).ops).map((operation) => [
        operation,
        async (
          input: { id?: string; desired?: Record<string, unknown>; state?: Record<string, unknown> },
          call: CallContext,
        ) => {
          if (call.authentication?.method !== "workloadIdentity" || !call.connection)
            throw new AuthenticationError("missing");
          const identity = identityFor(identities, {
            connectionId: call.connection.id,
            vendor: call.connection.vendor,
          });
          if (call.connection.account !== accountOf(identity)) throw new AuthenticationError("wrong_account");
          const checked = constrain(operation, input);
          const desired = checked.desired;
          const projects = [identity.project, identity.projectNumber];
          const inProject = (value: string) => projects.some((project) => value.startsWith(`projects/${project}/`));
          if (input.id && !inProject(input.id)) throw new AuthenticationError("wrong_account");
          for (const state of [input.state, desired]) {
            if (!state) continue;
            if (state.project != null && !projects.includes(String(state.project)))
              throw new AuthenticationError("wrong_account");
            for (const field of ["id", "key_ring", "crypto_key_id", "service_account_id"])
              if (typeof state[field] === "string" && !inProject(state[field]))
                throw new AuthenticationError("wrong_account");
          }
          const credentials = await federationCredentials(identity);
          const driver = gcpTf.driver(
            retainKeys(iamImports(bridge)),
            () => ({ credentials: JSON.stringify(credentials), project: identity.project }),
            undefined,
            undefined,
            { authentication: ["workloadIdentity"] },
          );
          try {
            return await driver.ops[operation]!({ ...input, ...checked }, call);
          } catch (error) {
            // Provider diagnostics may echo credential-source headers or an access token.
            // Keep actionable retryability, never the SDK/provider message, cause or private state.
            throw new DriverError(`gcp: ${operation} failed`, {
              retryable: (error as { retryable?: boolean } | null)?.retryable === true,
            });
          }
        },
      ]),
    ),
  };
}

/** Google 8.7.0 imports read the policy but report an absent member as an error. */
function iamImports(bridge: ProviderClient): ProviderClient {
  return {
    ...bridge,
    import: async (...args) => {
      try {
        return await bridge.import(...args);
      } catch (error) {
        const failure = error as Partial<BridgeError> | null;
        if (
          ["google_kms_crypto_key_iam_member", "google_service_account_iam_member"].includes(args[1]) &&
          failure?.code === "failed_precondition" &&
          Array.isArray(failure.diagnostics) &&
          failure.diagnostics.length === 1
        ) {
          const diagnostic = failure.diagnostics[0];
          if (
            diagnostic?.severity === "error" &&
            diagnostic.detail === "" &&
            diagnostic.attributePath === "" &&
            /^Cannot find binding for "(?:[^"\\]|\\.)*" with role "(?:[^"\\]|\\.)*", member "(?:[^"\\]|\\.)*", and condition title "(?:[^"\\]|\\.)*"$/.test(
              diagnostic.summary,
            )
          )
            return { resources: [], warnings: [] };
        }
        throw error;
      }
    },
  };
}
