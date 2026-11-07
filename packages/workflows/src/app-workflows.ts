import { z } from "zod";
import type { ApplyInput } from "./apply.ts";
import type { ChatTurnInput, ChatTurnOutput } from "./chat-workflow.ts";
import type { ResolvedConfig, SanomaConfig } from "./config.ts";
import type { SanomaClient } from "./client.ts";
import { defineWorkflow, type Principal, type WorkflowDefinition } from "./define.ts";
import { AtSchema } from "./description.ts";
import {
  type ADOPT_WORKFLOW,
  type CONNECT_EXISTING_WORKFLOW,
  FIELD_NAME,
  type GO_LIVE_HOST_WORKFLOW,
  type GO_LIVE_WORKFLOW,
  type PATCH_WORKFLOW,
  type WorkflowFn,
} from "./shared.ts";
import type { Source } from "./source.ts";

// The app's own actions on the company's repository, as built-in workflows: the app starts each
// (its pages through `api.<name>`, polling `.result`) and the worker runs it, since only the
// worker has the checkout. What each does is the app's, given to the worker as `AppSteps`
// (`WorkerOptions.app`, `@sanoma-ai/app/steps`), and each is called in a step of its own run
// (`app-steps.ts`), its writes to the checkout one at a time per worker. Workflows like any other, held to
// the same lint: no DBOS here, and no operation, so nothing goes through `ctx`.

/** Adopt's input: a drift run, a resource it found drifted, and the fields whose value at the vendor to write into the resource's data file. */
export const AdoptInput = z.object({
  runId: z.string().min(1),
  id: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
});
export type AdoptInput = z.infer<typeof AdoptInput>;

/**
 * A form's Save: a declaration the description names (a resource, a collection, a site or an
 * app, by its `at`), and the fields to set in it, by dotted path as `setFields` takes them, each
 * to a JSON value; the fields to rename or remove (`rename`, as `renameFields` takes them: a path
 * to its new name, or null); and, for a change to a collection's columns, its plan as the app
 * drafted it (`plan`), which the change it opens carries for its review (`ChangeInput.plan`).
 */
export const PatchInput = z
  .object({
    at: AtSchema,
    fields: z.record(z.string().min(1), z.json()),
    rename: z.record(z.string().min(1), z.string().regex(FIELD_NAME).nullable()).optional(),
    plan: z.json().optional(),
  })
  .refine(({ fields, rename = {} }) => Object.keys(fields).length + Object.keys(rename).length > 0, {
    message: "Set a field",
    path: ["fields"],
  });
export type PatchInput = z.infer<typeof PatchInput>;

/**
 * What going live chooses: who holds the repository, the database's region (and size, when it
 * takes one), Supabase's organization for a Supabase project, the host's port.
 */
export const GoLiveInput = z.object({
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, "Choose a GitHub account or organization"),
  /** The repository's name, and the database's and the host's. */
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "Lower case letters, digits and hyphens, starting with a letter or digit"),
  organization: z.string().min(1, "Choose a Supabase organization").optional(),
  region: z.string().min(1, "Choose a region"),
  size: z.string().min(1).optional(),
  /** The database type the page showed (`GoLiveChoices.database`): refused when going live would now choose another. */
  database: z.string().min(1).optional(),
  /** The host type the page showed (`GoLiveChoices.host`): refused when going live would now choose another. */
  host: z.string().min(1).optional(),
  port: z.number().int().min(1024, "A port from 1024").max(65535, "A port up to 65535"),
});
export type GoLiveInput = z.infer<typeof GoLiveInput>;

/** Going live's second half takes nothing: what it pushes and applies is in `infra.ts`. */
export const GoLiveHostInput = z.strictObject({});
export type GoLiveHostInput = z.infer<typeof GoLiveHostInput>;

/** An existing GitHub repository (`owner/name`: the owner is always written) and a Supabase project's ref, either or both. */
export const ConnectExistingInput = z
  .object({
    repository: z
      .string()
      .trim()
      .regex(/^[\w-]+\/(?!\.\.?$)[\w.-]+$/, "Enter a repository as owner/name")
      .optional(),
    project: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+$/, "Enter a project's ref: lowercase letters and digits")
      .optional(),
  })
  .refine((r) => r.repository || r.project, { message: "Enter a repository, a project's ref, or both" });
export type ConnectExistingInput = z.infer<typeof ConnectExistingInput>;

/** A data file written, relative to the root, and its commit, when the worker has a repository. */
export interface Written {
  file: string;
  revision?: string;
}

/** What a Save lands as: the change opened for review (its run id), when the repository has a remote; otherwise the file written. */
export type PatchOutput = { change: string } | Written;

/** What going live's runs answer: the apply run each started (`<run>:apply`), which the page follows. */
export interface GoLiveOutput {
  runId: string;
}

/**
 * What connecting answers: the data file it wrote and its text; its commit, on `branch` (with its
 * `diff`) when the repository has a remote and the change waits for a person to merge it; and the
 * apply run that binds what it declares.
 */
export interface ConnectExistingOutput extends Written {
  text: string;
  branch?: string;
  diff?: string;
  runId: string;
}

/**
 * What an app step is given: the worker's own client (connected on first use, closed when the
 * worker stops), its repository (`WorkerOptions.source`) and the lock its writes there take, the
 * config and its resolution, who started the run (`by`, as `SanomaClient.start` admitted them)
 * and the run's id.
 */
export interface AppStepContext {
  client: SanomaClient;
  source?: Source;
  /**
   * Runs `write` once the worker's write before it has settled (`WorkerState.serially`): what a step
   * holds around reading and writing the checkout and committing, so two never write one file.
   */
  serially<T>(write: () => Promise<T>): Promise<T>;
  config: SanomaConfig;
  resolved: ResolvedConfig;
  by: Principal;
  runId: string;
}

/**
 * What a chat turn's step is given besides an app step's: when to stop (a new message came, or the
 * worker stopped), a way to take the sign-in codes the person pastes for this turn, and whether
 * the turn had begun before, on a worker that restarted under it.
 */
export interface ChatTurnContext extends AppStepContext {
  signal: AbortSignal;
  /** Hands each code pasted for this turn (`SanomaClient.turnCode`) to `listener`, until the function it returns is called. */
  onCode(listener: (code: string) => void): () => void;
  /** The turn had begun (`Chats.begin`) before the worker restarted: it settles what it left, and runs nothing again. */
  resumed: boolean;
}

/**
 * The app's own actions, which a worker runs (`WorkerOptions.app`): one method per built-in
 * workflow of the app's, each called in a DBOS step of its run, its writes to the checkout under
 * `AppStepContext.serially`. A step refuses by throwing: a `SanomaError` with the code the page
 * branches on (`invalid_input` with its `issues`, or a `field`; `not_approver`), else an error
 * whose message the page shows. What a step returns is checkpointed, so it is JSON. One that
 * applies after its write returns what apply plans (`apply`), which its run starts as a child.
 */
export interface AppSteps {
  /** Adopt: what the vendor holds for drifted fields, by the drift run's report, into their data file, committed. */
  adopt(step: AppStepContext, input: AdoptInput): Promise<Written>;
  /** A form's Save: the fields set in the declaration's file, as a change for review with a remote, else written and committed. */
  patch(step: AppStepContext, input: PatchInput): Promise<PatchOutput>;
  /** Going live's first half: `infra.ts` written for the choices and committed; what apply makes first. */
  goLive(step: AppStepContext, input: GoLiveInput): Promise<{ apply: ApplyInput }>;
  /** Going live's second half: `main` pushed to the repository apply made; the host (and its wakeup) to apply. */
  goLiveHost(step: AppStepContext, input: GoLiveHostInput): Promise<{ apply: ApplyInput }>;
  /** An existing repository and/or project declared in `infra.ts` and committed; the apply that only binds them. */
  connectExisting(
    step: AppStepContext,
    input: ConnectExistingInput,
  ): Promise<Omit<ConnectExistingOutput, "runId"> & { apply: ApplyInput }>;
  /**
   * A chat turn: the reply to the person's message, by the chat's engine, written to the chat's
   * transcript and, as it streams, to its chunks (`Chats.append`, then `Chats.end`). It writes its
   * own draft, not the checkout.
   */
  chat(step: ChatTurnContext, input: ChatTurnInput): Promise<ChatTurnOutput>;
}

/** The app's steps an action's run calls (`AppRunner`): all but the chat's turn, which its own workflow runs. */
export type AppAction = Exclude<keyof AppSteps, "chat">;

/** The actions whose step answers what to apply after its write. */
type Applying = {
  [K in AppAction]: Awaited<ReturnType<AppSteps[K]>> extends { apply: ApplyInput } ? K : never;
}[AppAction];

/** What a built-in of the app's runs its work through (`appRunner`, in `app-steps.ts`). */
export interface AppRunner {
  /** The app's step `name` with `input`, in a DBOS step of this run; refused when the worker runs no app steps. */
  step<K extends AppAction>(name: K, input: Parameters<AppSteps[K]>[1]): ReturnType<AppSteps[K]>;
  /**
   * The step, then the apply it answers started as a child run of this one (`<run>:apply`), as its
   * own actor, without waiting for it: what the step answered besides, with that run's id.
   */
  stepThenApply<K extends Applying>(
    name: K,
    input: Parameters<AppSteps[K]>[1],
  ): Promise<Omit<Awaited<ReturnType<AppSteps[K]>>, "apply"> & { runId: string }>;
}

/** The app's built-ins as its pages call them, by api name (`apiNameOf`): started, then their `.result` polled. */
export interface AppApi {
  adopt: WorkflowFn<AdoptInput, Written>;
  patch: WorkflowFn<PatchInput, PatchOutput>;
  goLive: WorkflowFn<GoLiveInput, GoLiveOutput>;
  goLiveHost: WorkflowFn<GoLiveHostInput, GoLiveOutput>;
  connectExisting: WorkflowFn<ConnectExistingInput, ConnectExistingOutput>;
}

/** The built-in workflows of the app's actions, over `runner`: `resolveConfig` adds them to every config. */
export function appWorkflows(runner: AppRunner): WorkflowDefinition<any, any>[] {
  return [
    defineWorkflow({
      // The literal, held to the one name: the outline finds a workflow by a string, or a const of its own file.
      name: "adopt" satisfies typeof ADOPT_WORKFLOW,
      title: "Adopt a vendor's value",
      trigger: "manual",
      input: AdoptInput,
      uses: [],
      run: async (_ctx, input) => runner.step("adopt", input),
    }),
    defineWorkflow({
      name: "patch" satisfies typeof PATCH_WORKFLOW,
      title: "Save a declaration",
      trigger: "manual",
      input: PatchInput,
      uses: [],
      run: async (_ctx, input) => runner.step("patch", input),
    }),
    defineWorkflow({
      name: "go-live" satisfies typeof GO_LIVE_WORKFLOW,
      title: "Go live",
      trigger: "manual",
      input: GoLiveInput,
      uses: [],
      run: async (_ctx, input): Promise<GoLiveOutput> => runner.stepThenApply("goLive", input),
    }),
    defineWorkflow({
      name: "go-live-host" satisfies typeof GO_LIVE_HOST_WORKFLOW,
      title: "Push and run the host",
      trigger: "manual",
      input: GoLiveHostInput,
      uses: [],
      run: async (_ctx, input): Promise<GoLiveOutput> => runner.stepThenApply("goLiveHost", input),
    }),
    defineWorkflow({
      name: "connect-existing" satisfies typeof CONNECT_EXISTING_WORKFLOW,
      title: "Connect an existing repository or database",
      trigger: "manual",
      input: ConnectExistingInput,
      uses: [],
      run: async (_ctx, input): Promise<ConnectExistingOutput> => runner.stepThenApply("connectExisting", input),
    }),
  ];
}
