// `@sanoma-ai/workflows/description`: what `describeConfig` answers, as zod schemas, and its
// types inferred from them. zod only, no Node: a page can parse a description it is sent, and the
// app extends `ConfigDescriptionSchema` with what it adds (`AppConfigSchema`).
import { z } from "zod";
import type { Outline } from "./outline.ts";
import type { ResourceFields } from "./resource.ts";
import { EFFECTS, FIELD_TYPES } from "./shared.ts";

/** A JSON Schema (draft 2020-12), as `jsonSchemaOf` writes one. */
const JsonSchema = z.record(z.string(), z.unknown());

/** Where a declaration is: its file, relative to the root with `/`, and the export that holds it (`default` for a default export). */
export const AtSchema = z.strictObject({ file: z.string(), export: z.string() });
export type At = z.infer<typeof AtSchema>;

/** Something wrong in a file, at a line and column from 1 (UTF-16 code units). */
export const LintProblemSchema = z.strictObject({ line: z.number(), column: z.number(), message: z.string() });
export type LintProblem = z.infer<typeof LintProblemSchema>;

/**
 * Something wrong in a company's files (a data file, an app's `app.ts`, a site's `site.ts`), or in
 * finding them: at a place in the file when an error's stack gives one, else at an export.
 */
export const ResourceProblemSchema = z.strictObject({
  /**
   * The file, relative to the config's root, with `/`: `resources/identity/github.ts`. Absent
   * when the problem is the config's: it has no root.
   */
  file: z.string().optional(),
  /** The export it is about: `website`, or `default`. */
  export: z.string().optional(),
  /** From 1. */
  line: z.number().optional(),
  /** From 1, in UTF-16 code units. */
  column: z.number().optional(),
  message: z.string(),
});
export type ResourceProblem = z.infer<typeof ResourceProblemSchema>;

/** A problem at a file, relative to the root: an app's, a site's. */
const FileProblemSchema = ResourceProblemSchema.extend({ file: z.string() });

/** A declaration's named connection: which grant of its vendor it is applied with. */
const ConnectionRefSchema = z.strictObject({
  $connection: z.string(),
  vendor: z.string(),
  revision: z.string().optional(),
});

/** A resource a data file declares, as loading the file made it. */
export const DeclaredResourceSchema = z.strictObject({
  /** `<file>#<export>`, the file relative to the config's root, with `/`: `resources/identity/github.ts#website`. */
  id: z.string(),
  /** The data file it is declared in, as `id` names it: `resources/identity/github.ts`. */
  file: z.string(),
  vendor: z.string(),
  type: z.string(),
  /** What people call it: its identity, else its export's name. */
  name: z.string(),
  /** The import id that finds it unbound: what its type's `find` makes of its fields; absent when the type has none. */
  identity: z.string().optional(),
  /** The vendor's id of the object the lockfile binds it to (`LOCKFILE`); absent when unbound. */
  binding: z.string().optional(),
  /** Its file and export. */
  at: AtSchema,
  /** Its fields, as its type checked them: each resource it names as that resource's `name`. */
  desired: z.record(z.string(), z.unknown()),
  connection: ConnectionRefSchema.optional(),
  /**
   * Where it names another declared resource: the field's dotted path (a list item's with its
   * index, `teams.0`) to that resource's id.
   */
  refs: z.record(z.string(), z.string()),
});
export type DeclaredResource = z.infer<typeof DeclaredResourceSchema>;

/**
 * A collection `resources/data.ts` declares: where it is, for the Resources page. Its fields are
 * the collection's own (`describeConfig`'s `collections`), from the same file, which the runtime
 * imports.
 */
export const DeclaredCollectionSchema = z.strictObject({
  /** `<file>#<export>`, as a resource's: `resources/data.ts#outbound`. */
  id: z.string(),
  /** `resources/data.ts`, or an app's `apps/<app>/resources/data.ts`. */
  file: z.string(),
  /** The collection's name, its operations' middle segments (`data.<name>.get`): an app's with its app, `crm.contacts`. */
  name: z.string(),
  /** Its file and export. */
  at: AtSchema,
});
export type DeclaredCollection = z.infer<typeof DeclaredCollectionSchema>;

/** A lockfile binding no data file declares, by its key (`<file>#<export>`). */
const OrphanSchema = z.strictObject({
  key: z.string(),
  type: z.string(),
  id: z.string(),
  connection: ConnectionRefSchema.optional(),
});

/** An app: a folder of `apps/`, and what its `app.ts` declares. */
export const AppEntrySchema = z.strictObject({
  /** The folder's name, which prefixes what it declares (`crm.contacts`) and is the app's title. */
  name: z.string(),
  /** The folder, relative to the root, with `/`: `apps/crm`. */
  dir: z.string(),
  /** `defineApp({ source })` in its `app.ts`: the repository it was taken from; absent for the company's own app. */
  source: z.string().optional(),
  /** Its `app.ts`'s default export, when it has the file. */
  at: AtSchema.optional(),
});
export type AppEntry = z.infer<typeof AppEntrySchema>;

/** A call a site's code makes: `<RunForm workflow="…" />`, or a use of `api`. */
export const SiteCallSchema = z.strictObject({
  /** What it calls: a workflow, a collection (`api.data.<name>.<op>`) or an operation (`api.<vendor>.<resource>.<op>`). */
  kind: z.enum(["workflow", "collection", "op"]),
  /**
   * The workflow's name (`RunForm`'s `workflow`, or the workflow whose `apiNameOf` is the name
   * `api` gives; that name itself when none is), the collection's name, or the operation's id.
   */
  target: z.string(),
  /**
   * What it calls of the workflow (`start`, or a read of its runs: `result`, `latest`, …) or the
   * collection (`list`, `save`, …), as written; absent for a workflow called as itself or by
   * `RunForm`, which starts it, and for an operation.
   */
  method: z.string().optional(),
  /** `<RunForm workflow="…" />` or a call on `api`, from `sanoma/site`. */
  via: z.enum(["RunForm", "api"]),
  /** The file, relative to the config's root, with `/`: `sites/sales/routes/index.tsx`. */
  file: z.string(),
  /** From 1. */
  line: z.number(),
  /** From 1, in UTF-16 code units. */
  column: z.number(),
  /**
   * The path of the page the file is, from its `createFileRoute` (or `createLazyFileRoute`) id: groups and pathless
   * segments left out, no trailing slash (`/sites/sales`). Absent for a file that is no page,
   * such as a component's.
   */
  page: z.string().optional(),
});
export type SiteCall = z.infer<typeof SiteCallSchema>;

/** A page of a site: a route file's path, and for a page per content entry the kind it reads. */
export const SitePageSchema = z.strictObject({
  /** As `SiteCall.page` has it: `/sites/www`, `/sites/www/blog/$slug`. */
  path: z.string(),
  /**
   * For a path with one parameter (`$slug`), the content kind whose entries are its pages: the one
   * kind its file reads by that parameter, `content.<kind>.get(params.slug)` (or `slug`,
   * destructured) with `content` from `sanoma/site`.
   */
  content: z.string().optional(),
  /**
   * `false` when its route says `staticData: { sitemap: false }`, written out: the sitemap leaves it
   * out. Its index route's `sitemap` (`true` or `false`) decides over a layout's at its path; a
   * pathless or group layout's says nothing.
   */
  sitemap: z.literal(false).optional(),
});
export type SitePage = z.infer<typeof SitePageSchema>;

/** A site, `sites/<name>/` or an app's `apps/<app>/sites/<name>/`, and what it calls. */
export const SiteEntrySchema = z.strictObject({
  /** Its folder's name, `<app>/<name>` for an app's (`siteKey`): where it is mounted, `/sites/<name>`. */
  name: z.string(),
  /** The app whose folder holds it (`apps/<app>/sites/`); absent for one at the root. */
  app: z.string().optional(),
  /** Its `site.ts`'s default export, when it has the file. */
  at: AtSchema.optional(),
  /** `defineSite({ title })` in its `site.ts`. */
  title: z.string().optional(),
  /** `defineSite({ icon })` in its `site.ts`: a Lucide icon's name, as written. */
  icon: z.string().optional(),
  /** `defineSite({ public: true })`: served to visitors, not people. */
  public: z.literal(true).optional(),
  /** `defineSite({ login })`, the connector whose login half signs visitors in: one that names none is among `problems`. */
  login: z.string().optional(),
  /**
   * `defineSite({ locales })`, a public site's languages, the first its default: kept only when
   * every one is a `LOCALE`, written once, on a public site with no login; else a problem.
   */
  locales: z.array(z.string()).optional(),
  /** The host a public site answers on: set by `startApp` from its `domains`, never by `readSites`. */
  domain: z.string().optional(),
  /** Its pages, by path: one for each path its `routes/` files give (a layout and its index are one). */
  pages: z.array(SitePageSchema),
  /** Its calls, by file and then in the file's order. */
  calls: z.array(SiteCallSchema),
  /**
   * Each call to a workflow, a collection or an operation the config does not have, or to an
   * operation a page may not call directly, or, on a public site, that no policy lets a visitor
   * make, at its file; then what is wrong in its `site.ts`.
   */
  problems: z.array(FileProblemSchema),
  /**
   * On a public site, each page with one parameter whose file reads content the sitemap cannot
   * tie to it (`SitePage.content`), so the sitemap lists none of its pages: at the first read.
   */
  warnings: z.array(LintProblemSchema.extend({ file: z.string() })),
});
export type SiteEntry = z.infer<typeof SiteEntrySchema>;

/** `manual`, or the schedule a workflow starts on (`defineWorkflow`'s `trigger`). */
const TriggerSchema = z.union([
  z.literal("manual"),
  z.strictObject({ schedule: z.string(), timezone: z.string().optional() }),
]);

/** What a workflow is, read from its definition: enough to draw a start form and show what it may call. */
export const WorkflowEntrySchema = z.strictObject({
  /** Its name: `<app>.<name>` for one an app's folder defines. */
  name: z.string(),
  /** The app whose folder defines it (`apps/<app>/workflows/`); absent for one at the root. */
  app: z.string().optional(),
  title: z.string().optional(),
  /** `manual`, or the schedule it starts on (`defineWorkflow`'s `trigger`). */
  trigger: TriggerSchema,
  /**
   * Set for a workflow the runtime adds itself, `drift`, `apply` or `call`, rather than the config: a label. It
   * starts like any other.
   */
  builtin: z.literal(true).optional(),
  /** The input, as JSON Schema (draft 2020-12), from the zod schema. */
  input: JsonSchema,
  /** Operation ids the workflow may call, in the order declared. */
  ops: z.array(z.string()),
  /** Built-ins the workflow may call. */
  builtins: z.array(z.enum(["approval", "sleep", "all"])),
  /** The file that defined it, absolute. */
  file: z.string(),
  /** What its `run` calls, in order, read from its file (`outlineWorkflow`), which the worker holds its runs to. */
  outline: z.custom<Outline>(),
  /**
   * What is wrong in its file, by position: what `lintWorkflow` finds (syntax, an import a
   * workflow may not make, `instanceof` against the runtime's error classes, what the outline
   * cannot draw in each `run`), read the one way the outline is, so a check sees what the
   * worker refuses; and, at 1:1, an outline error that is the file's (it cannot be read, or holds
   * no workflow of this name). A file defining several workflows gives each its problems. Empty
   * for the built-in `drift`, which the package's tests hold to the lint.
   */
  problems: z.array(LintProblemSchema),
  /**
   * The text the outline's spans index into: the workflow's file, with `\n` line endings.
   * Absent only when the outline is `{ error }`. Whole files: a server may keep it from clients.
   */
  source: z.string().optional(),
});
export type WorkflowEntry = z.infer<typeof WorkflowEntrySchema>;

/** What an operation is, read from its connector: enough to badge it and show its contract. */
export const OpEntrySchema = z.strictObject({
  id: z.string(),
  vendor: z.string(),
  resource: z.string(),
  name: z.string(),
  effect: z.enum(EFFECTS),
  idempotent: z.boolean(),
  description: z.string().optional(),
  /** How a scenario's steps name it: Cucumber expressions over its input's fields. */
  phrases: z.strictObject({ given: z.string().optional(), expect: z.string().optional() }).optional(),
  /** Whether it may be called directly, outside a run (`isDirect`): the one rule, read here, never derived again. */
  direct: z.boolean(),
  /** What a call sends, as JSON Schema (`io: "input"`: fields with defaults are optional). */
  input: JsonSchema,
  /** What a call returns once its schema has parsed the vendor's reply (`io: "output"`). */
  output: JsonSchema,
});
export type OpEntry = z.infer<typeof OpEntrySchema>;

/** Who a vendor is, from its connector's `VendorInfo`: enough to name it, show its logo and link to its connector. */
export const VendorEntrySchema = z.strictObject({
  /** The connector's `title`, else the vendor's id. */
  title: z.string(),
  /** The logo as `data:image/svg+xml` URLs, for an `<img>`: `dark` is for dark backgrounds. */
  logo: z.strictObject({ src: z.string(), dark: z.string().optional() }).optional(),
  /** The connector's npm package name. */
  package: z.string().optional(),
  /** The connector package's `homepage` from its package.json: where its code and README are, as an https URL. */
  homepage: z.string().optional(),
  /** Whether the vendor's connector attaches a fake (`withSetup`), for sandbox runs. */
  fake: z.boolean(),
  /**
   * The environment variables its driver declares (`defineDriver`'s `env`), in declared order:
   * each name, its one-line manual and whether it may be unset; never a value or a status
   * (`SanomaClient.credentials` says those). Absent when its driver declares none.
   */
  credentials: z
    .array(
      z.strictObject({ name: z.string(), description: z.string().optional(), optional: z.literal(true).optional() }),
    )
    .optional(),
});
export type VendorEntry = z.infer<typeof VendorEntrySchema>;

/**
 * The contracts a resource type meets, from its spec: `host`, `database` and `wakeup` (`Host`,
 * `Database`, `Wakeup`), and `source` for a type a host's `source` names (the repository it clones).
 */
export const CAPABILITIES = ["host", "database", "wakeup", "source"] as const;

/** A resource type a connector declares with `defineResource`. */
export const ResourceTypeEntrySchema = z.strictObject({
  /** `<vendor>.<type>`, such as `github.repository`. */
  id: z.string(),
  vendor: z.string(),
  type: z.string(),
  title: z.string(),
  /** How a declared resource's identity is made, such as `name` or `repository_id:pattern`; absent when it is found only by its binding. */
  identity: z.string().optional(),
  /** Its flagged fields, by dotted path. */
  fields: z.custom<ResourceFields>(),
  /**
   * Its state, as a read returns it, as JSON Schema (`io: "output"`), with `$id`
   * `sanoma:resource-type/<id>`: the operations' contracts `$ref` it instead of repeating it.
   */
  schema: JsonSchema,
  /** Its operations' ids, sorted: `<id>.import` and `<id>.read`, and for a writable type its change operations. */
  ops: z.array(z.string()),
  /** The contracts it meets (`CAPABILITIES`), in that order; absent when it meets none. */
  capabilities: z.array(z.enum(CAPABILITIES)).optional(),
});
export type ResourceTypeEntry = z.infer<typeof ResourceTypeEntrySchema>;

/** A collection's field as declared: its type, or `{ type, optional }`, or `{ enum, optional }`. */
const FieldSchema = z.union([
  z.enum(FIELD_TYPES),
  z.strictObject({ type: z.enum(FIELD_TYPES), optional: z.literal(true).optional() }),
  z.strictObject({ enum: z.tuple([z.string()], z.string()).readonly(), optional: z.literal(true).optional() }),
]);

/** A collection the config declares (`collection()`). */
export const CollectionEntrySchema = z.strictObject({
  /** Its name: `<app>.<name>` for one an app's `resources/data.ts` declares. */
  name: z.string(),
  /** The app whose folder declares it (`apps/<app>/resources/data.ts`); absent for one at the root. */
  app: z.string().optional(),
  title: z.string().optional(),
  /** The field each record is found by. */
  key: z.string(),
  /** Its fields as declared. */
  fields: z.record(z.string(), FieldSchema),
  /** What `save` accepts, as JSON Schema, with `$id` `sanoma:collection/<name>`. */
  record: JsonSchema,
  /** Its operations' ids: `data.<name>.get`, `.list`, `.save` and `.delete`. */
  ops: z.array(z.string()),
  /** Where `resources/data.ts` declares it, read as the data files are; absent for one declared elsewhere. */
  declared: DeclaredCollectionSchema.optional(),
});
export type CollectionEntry = z.infer<typeof CollectionEntrySchema>;

/**
 * A plain-JSON description of what a config can do: its workflows, the operations they call,
 * and whether a policy gates them. The app server builds it from the config and sends it to the
 * browser, so the UI shows exactly what the worker enforces. Never written by hand.
 */
export const ConfigDescriptionSchema = z.strictObject({
  secrets: z
    .strictObject({
      store: z.string(),
      namespace: z.string(),
      bindings: z.record(
        z.string(),
        z.strictObject({ path: z.string(), management: z.enum(["sanoma", "external"]), store: z.string() }),
      ),
    })
    .optional(),
  connections: z
    .array(
      z.strictObject({
        id: z.string(),
        vendor: z.string(),
        method: z.string(),
        scopes: z.array(z.string()).readonly(),
        account: z.string().optional(),
        default: z.boolean(),
      }),
    )
    .optional(),
  appName: z.string(),
  /** The application version runs started now are stamped with. */
  version: z.string(),
  workflows: z.array(WorkflowEntrySchema),
  ops: z.array(OpEntrySchema),
  /** Every vendor the operations are from, by its id (an `OpEntry`'s `vendor`). */
  vendors: z.record(z.string(), VendorEntrySchema),
  /** The resource types the connectors declare, by `id`. */
  resourceTypes: z.array(ResourceTypeEntrySchema),
  /** The config's collections, by name. */
  collections: z.array(CollectionEntrySchema),
  /**
   * The resources the data files under `resources/` declare, by file and then in file order,
   * less any with a problem and any that names one.
   */
  resources: z.array(DeclaredResourceSchema),
  /** Each binding in the lockfile (`LOCKFILE`) whose key no data file declares, as `loadDataFiles` reports it. */
  orphans: z.array(OrphanSchema),
  /**
   * What is wrong in the data files (`loadDataFiles`) and the apps (a folder of `apps/` that is no
   * app, an `app.ts` that cannot be read, a collection or site at the root named as an app is),
   * each at its file, relative to the root, and its line and column or its export. A workflow's are on its entry.
   */
  problems: z.array(ResourceProblemSchema),
  /** The apps under `apps/` (`readApps`), by name. Each workflow, collection and site an app declares names it (`app`). */
  apps: z.array(AppEntrySchema),
  /**
   * `defined` when the root has `policies/**\/*.cedar` (else the policy is `allowAll`), with their
   * `version`, or while they have `problems` (`policyProblems`), none: then every call and start is
   * refused. `files` are those files as read (`readPolicyFiles`): the root's, then each app's.
   */
  policy: z.strictObject({
    defined: z.boolean(),
    version: z.string().optional(),
    problems: z.array(z.string()).optional(),
    files: z.array(z.strictObject({ file: z.string(), text: z.string() })),
  }),
  /**
   * The sites under `sites/`, by name, with what each calls (`readSites`), and its calls to what
   * the config does not have as its problems; none when the root has no `sites/`.
   */
  sites: z.array(SiteEntrySchema),
});
export type ConfigDescription = z.infer<typeof ConfigDescriptionSchema>;
