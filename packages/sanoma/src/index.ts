// Node's types come with `sanoma`: tsc resolves this from sanoma's own location, where its
// dependencies (`@types/node` among them) are under any installer, and any file importing
// `sanoma` brings them into the program. `preserve` keeps it in `dist/index.d.ts`.
/// <reference types="node" preserve="true" />
// What a company repo imports, from one package: what the lint lets a workflow import
// (`allowImportNames` in `@sanoma-ai/workflows`'s `oxlint.json`: the author surface and `z`), and
// what `sanoma.config.ts` needs besides its connectors (`defineConfig`, the ledger stores, and
// `defineSteps` for the company's own scenario steps), `defineApp` for an app's `app.ts`, with the types those use. Everything else (the client, the worker) stays in `@sanoma-ai/workflows`
// and the bin.
export {
  type AppDefinition,
  type ApprovalRequest,
  type ApprovalResult,
  type ApprovalState,
  type Approver,
  type Builtin,
  type Connector,
  type Ctx,
  defineApp,
  defineConfig,
  defineSteps,
  defineWorkflow,
  type Driver,
  errorCode,
  type ErrorCode,
  type Expect,
  jsonlLedger,
  type LedgerRecord,
  type LedgerStore,
  mayDecide,
  memoryLedger,
  postgresLedger,
  type Principal,
  type RunView,
  type Seed,
  type SanomaConfig,
  type SleepRequest,
  type StepOptions,
  type Steps,
  type Trigger,
  type Use,
  type WorkflowDefinition,
} from "@sanoma-ai/workflows";
export { z } from "zod";
export {
  type SecretConfiguration,
  type SecretBinding,
  type SecretStore,
  type SecretStoreCapabilities,
  type SecretAddress,
  type SecretValue,
  type Authentication,
  defineAuthentication,
} from "@sanoma-ai/workflows";

export {
  defineConnection,
  defineConnectionRule,
  connectionRef,
  type ConnectionRef,
  type ConnectionDefinition,
  type ConnectionRule,
} from "@sanoma-ai/workflows";
