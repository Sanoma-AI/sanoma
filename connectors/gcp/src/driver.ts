import { defaultBridge, type BridgeError, type ProviderClient } from "@sanoma-ai/bridge";
import {
  AuthenticationError,
  authenticationCredentials,
  DriverError,
  type CallContext,
  type Driver,
} from "@sanoma-ai/workflows";
import { accountOf, federationCredentials, type gcpAuthentication, type GcpIdentity } from "./authentication.ts";
import { gcpTf } from "./connector.ts";
import { constrain, retainKeys } from "./constraints.ts";

/** Fields that name a parent resource: always inside the connection's project. */
const PARENTS = ["id", "key_ring", "crypto_key_id", "service_account_id"];

export function gcpDriver(
  identity: GcpIdentity | undefined,
  method: ReturnType<typeof gcpAuthentication>,
  bridge: ProviderClient = defaultBridge(),
): Driver {
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
          if (!identity || call.authentication?.method !== "workloadIdentity" || !call.connection)
            throw new AuthenticationError("missing");
          if (call.connection.account !== accountOf(identity)) throw new AuthenticationError("wrong_account");
          // This invocation's bundle, read by the runtime after policy; never kept past the call.
          const { bearer } = authenticationCredentials("workloadIdentity", method, call);
          const checked = constrain(operation, input);
          const desired = checked.desired;
          const projects = [identity.project, identity.projectNumber];
          // Resource names (`projects/<p>/...`) and the project-level forms IAM audit configs use
          // (`<p> <service>` to import, `<p>/audit_config/<service>` as state).
          const inProject = (value: string) =>
            projects.some((p) => [`projects/${p}/`, `${p}/`, `${p} `].some((prefix) => value.startsWith(prefix)));
          if (input.id && !inProject(input.id)) throw new AuthenticationError("wrong_account");
          for (const state of [input.state, desired]) {
            if (!state) continue;
            if (state.project != null && !projects.includes(String(state.project)))
              throw new AuthenticationError("wrong_account");
            for (const field of PARENTS)
              if (typeof state[field] === "string" && !inProject(state[field]))
                throw new AuthenticationError("wrong_account");
            // A Cloud Run service's IAM `name` is its full resource name; a short name is the service's own.
            if (typeof state.name === "string" && state.name.startsWith("projects/") && !inProject(state.name))
              throw new AuthenticationError("wrong_account");
          }
          const credentials = federationCredentials(identity, bearer);
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

const IAM_MEMBERS = [
  "google_kms_crypto_key_iam_member",
  "google_service_account_iam_member",
  "google_cloud_run_v2_service_iam_member",
];

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
          IAM_MEMBERS.includes(args[1]) &&
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
