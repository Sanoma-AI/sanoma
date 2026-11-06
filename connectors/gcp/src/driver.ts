import { defaultBridge, type BridgeError, type ProviderClient } from "@sanoma-ai/bridge";
import {
  AuthenticationError,
  authenticationCredentials,
  DriverError,
  type CallContext,
  type Driver,
} from "@sanoma-ai/workflows";
import { accountOf, federationCredentials, type gcpAuthentication, type GcpIdentity } from "./authentication.ts";
import { gcpTf, references } from "./connector.ts";
import { constrain, retainKeys } from "./constraints.ts";

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
          const type = operation.slice(0, operation.indexOf("."));
          // The fields naming a parent resource (its full name) are inside the project too.
          const parents = Object.keys(references[type as keyof typeof references] ?? {});
          const inProject = (value: string) => projects.some((p) => value.startsWith(`projects/${p}/`));
          // Every ID is a resource name, or starts with one (IAM members), but an audit config's:
          // `<project> <service>` to import, `<project>/audit_config/<service>` as state.
          const idInProject =
            type === "auditConfig"
              ? (id: string) => projects.some((p) => id.startsWith(`${p} `) || id.startsWith(`${p}/audit_config/`))
              : inProject;
          if (input.id && !idInProject(input.id)) throw new AuthenticationError("wrong_account");
          for (const state of [input.state, desired]) {
            if (!state) continue;
            if (state.project != null && !projects.includes(String(state.project)))
              throw new AuthenticationError("wrong_account");
            if (typeof state.id === "string" && !idInProject(state.id)) throw new AuthenticationError("wrong_account");
            for (const field of parents)
              if (typeof state[field] === "string" && !inProject(state[field]))
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
