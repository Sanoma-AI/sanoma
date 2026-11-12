import { z } from "zod";
import type { ApplyInput } from "./apply.ts";
import type { ChatTurnInput, ChatTurnOutput } from "./chat-workflow.ts";
import type { ResolvedConfig, SanomaConfig } from "./config.ts";
import type { SanomaClient } from "./client.ts";
import { defineWorkflow, type Principal, type WorkflowDefinition } from "./define.ts";
import { reported } from "./errors.ts";
import type { recordsOps } from "./collection.ts";
import type { ChangeReshaped } from "./change.ts";
import { AtSchema, TableChangePlanSchema } from "./description.ts";
import type { Op } from "./op.ts";
import {
  type ADOPT_WORKFLOW,
  CLOUD_SLUG,
  CLOUD_SLUG_RULE,
  COMMIT_ID,
  type CONNECT_EXISTING_WORKFLOW,
  DRAFT_ID,
  FIELD_NAME,
  type GO_LIVE_CLOUD_WORKFLOW,
  type GO_LIVE_HOST_WORKFLOW,
  type GO_LIVE_WORKFLOW,
  type PATCH_WORKFLOW,
  reshapeOf,
  type SAVE_DRAFT_WORKFLOW,
  undoDraftOf,
  type WorkflowFn,
} from "./shared.ts";
import type { RepoRef, Source } from "./source.ts";

// The app's own actions on the company's repository, as built-in workflows: the app starts each
// (its pages through `api.<name>`, polling `.result`) and the worker runs it, since only the
// worker has the checkout. What each does is the app's, given to the worker as `AppSteps`
// (`WorkerOptions.app`, `sanoma/app/steps`), and each is called in a step of its own run
// (`app-steps.ts`), its writes to the checkout one at a time per worker. Workflows like any other, held to
// the same lint: no DBOS here, and their operations through `ctx`: `patch`'s `sanoma.records.reshape`,
// and the one going live on Sanoma Cloud makes the company's repository with.

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
 * drafted it (`plan`, of the collection at `at`, each change a field it edits), which the change it
 * opens carries for its review and its merge (`ChangeInput.plan`), and which, written without a
 * remote, brings the records along at once (`sanoma.records.reshape`).
 */
export const PatchInput = z
  .object({
    at: AtSchema,
    fields: z.record(z.string().min(1), z.json()),
    rename: z.record(z.string().min(1), z.string().regex(FIELD_NAME).nullable()).optional(),
    plan: TableChangePlanSchema.optional(),
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

/**
 * Going live on a host in its vendor's account (Sanoma Cloud's), as `infra.ts` declares it: the
 * company's address (its slug, `<address>.sanoma.work`) when the person changed it from the one
 * declared, which the run writes into the file first (`CLOUD_SLUG`).
 */
export const GoLiveCloudInput = z.strictObject({
  address: z.string().regex(CLOUD_SLUG, `An address is ${CLOUD_SLUG_RULE}`).optional(),
});
export type GoLiveCloudInput = z.infer<typeof GoLiveCloudInput>;

/**
 * What going live on a host in its vendor's account found, ready to go: the company's slug, the
 * operation that makes its repository there (the host type's `account.repository`), and whether
 * `origin` names the repository already, which nothing then makes.
 */
export interface CloudReady {
  slug: string;
  account: string;
  origin: boolean;
}

/** What the push of going live on a host in its vendor's account is given: the repository made there, when `origin` named none. */
export interface PushCloudInput {
  repository?: RepoRef;
}

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

/**
 * A chat's draft saved (`SanomaClient.saveDraft`): the draft `id`, the title its commit or change
 * takes, the draft's commit the person saw (`head`: refused once the draft has moved on), and the
 * change's page, which its pull request's status links. With `undo`, a commit the person's
 * `chat` saved undone instead: reverted in its own draft (`undoDraftOf`, which `id` must be), then
 * saved the same way.
 */
export const SaveDraftInput = z
  .object({
    id: z.string().regex(DRAFT_ID),
    title: z.string().min(1),
    head: z.string().regex(COMMIT_ID).optional(),
    undo: z.string().regex(COMMIT_ID).optional(),
    chat: z.string().regex(DRAFT_ID).optional(),
    page: z.string().url().optional(),
  })
  .refine(({ id, undo }) => undo === undefined || id === undoDraftOf(undo), {
    message: "An undo is saved from its own draft",
    path: ["id"],
  })
  .refine(({ undo, chat }) => (undo === undefined) === (chat === undefined), {
    message: "An undo names the chat that saved the commit, and only an undo does",
    path: ["chat"],
  });
export type SaveDraftInput = z.infer<typeof SaveDraftInput>;

/**
 * What a save lands as: the change opened (its run id), when the repository's remote is one a
 * connector reviews changes on; else the commit on `main`, the files it changed (relative to the
 * root), whether the instance runs it now (`running`: its worker started again on it; false where
 * nothing can, until the instance starts again), and, when the repository has an `origin` that did
 * not take `main`, why (`notPushed`): the save stands here.
 */
export type SaveDraftOutput =
  | { change: string }
  | { revision: string; files: string[]; running: boolean; notPushed?: string };

/** A data file written, relative to the root, and its commit, when the worker has a repository. */
export interface Written {
  file: string;
  revision?: string;
}

/**
 * What a Save lands as: the change opened for review (its run id), when the repository has a
 * remote; otherwise the file written. Written with a column change's `plan`, also what became of the
 * records (`reshaped`: `sanoma.records.reshape`'s counts, or why it failed, the file written all
 * the same; none when the plan brings no record along) and whether the instance runs the new
 * declaration now (`running`: its worker and app started again on it; false where nothing can,
 * until the instance starts again).
 */
export type PatchOutput = { change: string } | (Written & { reshaped?: ChangeReshaped; running?: boolean });

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
  /**
   * Loads the company's files again and runs them, a moment after it is asked
   * (`WorkerOptions.reload`): what a save without a remote asks once it merged. Absent where nothing
   * can, as on a worker run alone.
   */
  reload?: () => void;
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
  /**
   * Going live on a host in its vendor's account, first: what must hold (`infra.ts` declares it,
   * its host unbound, the vendor's token stored), and the address written when it changed.
   */
  goLiveCloud(step: AppStepContext, input: GoLiveCloudInput): Promise<CloudReady>;
  /** Then: `origin` set to the repository made there, when given, and `main` pushed; the database and the host to apply. */
  pushCloud(step: AppStepContext, input: PushCloudInput): Promise<{ apply: ApplyInput }>;
  /** An existing repository and/or project declared in `infra.ts` and committed; the apply that only binds them. */
  connectExisting(
    step: AppStepContext,
    input: ConnectExistingInput,
  ): Promise<Omit<ConnectExistingOutput, "runId"> & { apply: ApplyInput }>;
  /** A chat's draft saved: merged into `main` and run, without a remote; its change opened, with one. */
  saveDraft(step: AppStepContext, input: SaveDraftInput): Promise<SaveDraftOutput>;
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
   * Starts the worker (and the app) again on the company's files, a moment later
   * (`AppStepContext.reload`), in a step of its own (`app:reload`): whether it will, false on a
   * worker that cannot (`reload` absent).
   */
  reload(): Promise<boolean>;
  /**
   * The step, then the apply it answers started as a child run of this one (`<run>:apply`), as its
   * own actor, without waiting for it: what the step answered besides, with that run's id.
   */
  stepThenApply<K extends Applying>(
    name: K,
    input: Parameters<AppSteps[K]>[1],
  ): Promise<Omit<Awaited<ReturnType<AppSteps[K]>>, "apply"> & { runId: string }>;
  /**
   * `apply` started as a child run of this one (`<run>:apply`), as its own actor, and waited for
   * (an approval it waits on included): its run id once every step of it is done; a failure,
   * saying which did not, when the apply failed or was cancelled, left one undone, or made no
   * step for a resource `only` names (its plan failed).
   */
  applyAndWait(apply: ApplyInput): Promise<GoLiveOutput>;
}

/** The app's built-ins as its pages call them, by api name (`apiNameOf`): started, then their `.result` polled. */
export interface AppApi {
  adopt: WorkflowFn<AdoptInput, Written>;
  patch: WorkflowFn<PatchInput, PatchOutput>;
  goLive: WorkflowFn<GoLiveInput, GoLiveOutput>;
  goLiveHost: WorkflowFn<GoLiveHostInput, GoLiveOutput>;
  goLiveCloud: WorkflowFn<GoLiveCloudInput, GoLiveOutput>;
  connectExisting: WorkflowFn<ConnectExistingInput, ConnectExistingOutput>;
  saveDraft: WorkflowFn<SaveDraftInput, SaveDraftOutput>;
}

/**
 * The built-in workflows of the app's actions, over `runner` and `records` (`recordsOps`, whose
 * reshape `patch` calls): `resolveConfig` adds them to every config, with the operations of the
 * config's hosts' accounts that make a repository (`HostSpec.account.repository`), which going
 * live on such a host calls.
 */
export function appWorkflows(
  runner: AppRunner,
  records: typeof recordsOps,
  repositories: readonly Op[] = [],
): WorkflowDefinition<any, any>[] {
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
      uses: [records.records.reshape],
      // Written without a remote, a column change brings the records along at once, then the
      // instance starts again on the new declaration, which saves are then checked against.
      run: async (ctx, input): Promise<PatchOutput> => {
        let output = await runner.step("patch", input);
        if (!("change" in output) && input.plan !== undefined) {
          const reshaping = reshapeOf(input.plan);
          const reshaped = reshaping && (await ctx.sanoma.records.reshape(reshaping).catch(reported));
          output = { ...output, ...(reshaped && { reshaped }), running: await runner.reload() };
        }
        return output;
      },
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
      name: "go-live-cloud" satisfies typeof GO_LIVE_CLOUD_WORKFLOW,
      title: "Go live on Sanoma Cloud",
      trigger: "manual",
      input: GoLiveCloudInput,
      uses: repositories,
      run: async (ctx, input): Promise<GoLiveOutput> => {
        const { slug, account, origin } = await runner.step("goLiveCloud", input);
        // The repository, made in the vendor's account unless `origin` names one: through `ctx`,
        // so the policy decides it and the ledger records it.
        const [vendor, group, name] = account.split(".") as [string, string, string];
        const repository = origin ? undefined : ((await ctx[vendor]![group]![name]!({ slug })) as RepoRef);
        const { apply } = await runner.step("pushCloud", { ...(repository && { repository }) });
        return runner.applyAndWait(apply);
      },
    }),
    defineWorkflow({
      name: "connect-existing" satisfies typeof CONNECT_EXISTING_WORKFLOW,
      title: "Connect an existing repository or database",
      trigger: "manual",
      input: ConnectExistingInput,
      uses: [],
      run: async (_ctx, input): Promise<ConnectExistingOutput> => runner.stepThenApply("connectExisting", input),
    }),
    defineWorkflow({
      name: "save-draft" satisfies typeof SAVE_DRAFT_WORKFLOW,
      title: "Save a draft",
      trigger: "manual",
      input: SaveDraftInput,
      uses: [],
      run: async (_ctx, input) => runner.step("saveDraft", input),
    }),
  ];
}
