import type { ConnectionRef } from "./connection.ts";
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { mayDeclarePeople } from "./change.ts";
import { isCollection } from "./collection.ts";
import { COLLECTIONS_FILE } from "./datafile.ts";
import { type Loaded, loadModules, madeOf, madeWith } from "./load.ts";
import { type Binding, type Bindings, LOCKFILE, readLockfile } from "./lockfile.ts";
import type { Connector } from "./op.ts";
import { APPS_DIR, filesUnder, kindDirs } from "./paths.ts";
import { peopleConnector, sanoma } from "./person.ts";
import { wakeupOps } from "./wakeup-type.ts";
import { DECLARED, type Declared, isObject, type Resource, resourceTypesOf } from "./resource.ts";
import { Principal } from "./define.ts";
import { NotAdmittedError } from "./errors.ts";
import {
  AGENTS,
  ANONYMOUS,
  ANONYMOUS_PRINCIPAL,
  type At,
  declaresPeople,
  isVisitor,
  type PeopleResource,
  personOf,
  principalOf,
  problemLine,
  RUNTIME_AGENTS,
  VISITORS,
} from "./shared.ts";

/** A resource a data file declares, as loading the file made it. */
export interface DeclaredResource {
  /** `<file>#<export>`, the file relative to the config's root, with `/`: `resources/identity/github.ts#website`. */
  id: string;
  /** The data file it is declared in, as `id` names it: `resources/identity/github.ts`. */
  file: string;
  vendor: string;
  type: string;
  /** What people call it: its identity, else its export's name. */
  name: string;
  /** The import id that finds it unbound: what its type's `find` makes of its fields; absent when the type has none. */
  identity?: string;
  /** The vendor's id of the object the lockfile binds it to (`LOCKFILE`); absent when unbound. */
  binding?: string;
  /** Its file and export. */
  at: At;
  /** Its fields, as its type checked them: each resource it names as that resource's `name`. */
  desired: Record<string, unknown>;
  connection?: ConnectionRef;
  /**
   * Where it names another declared resource: the field's dotted path (a list item's with its
   * index, `teams.0`) to that resource's id.
   */
  refs: Record<string, string>;
}

/**
 * A collection `resources/data.ts` declares: where it is, for the Resources page. Its fields are
 * the collection's own (`describeConfig`'s `collections`), from the same file, which the runtime
 * imports.
 */
export interface DeclaredCollection {
  /** `<file>#<export>`, as a resource's: `resources/data.ts#outbound`. */
  id: string;
  /** `resources/data.ts`, or an app's `apps/<app>/resources/data.ts`. */
  file: string;
  /** The collection's name, its operations' middle segments (`data.<name>.get`): an app's with its app, `crm.contacts`. */
  name: string;
  /** Its file and export. */
  at: At;
}

/**
 * Something wrong in a company's files (a data file, an app's `app.ts`, a site's `site.ts`), or in
 * finding them: at a place in the file when an error's stack gives one, else at an export.
 */
export interface ResourceProblem {
  /**
   * The file, relative to the config's root, with `/`: `resources/identity/github.ts`. Absent
   * when the problem is the config's: it has no root.
   */
  file?: string;
  /** The export it is about: `website`, or `default`. */
  export?: string;
  /** From 1. */
  line?: number;
  /** From 1, in UTF-16 code units. */
  column?: number;
  message: string;
}

/** What the data files declare: each resource read without problems, the lockfile's bindings, and the problems. */
export interface DataFiles {
  /** By file and then in file order, less any with a problem, and any that names one. */
  resources: DeclaredResource[];
  /** The lockfile's bindings, by key (`<file>#<export>`), as read: none when it is missing or has a problem. */
  bindings: Bindings;
  /** Each binding whose key no data file declares, by key. */
  orphans: (Binding & { key: string })[];
  /** The collections `resources/data.ts` declares, in file order. */
  collections: DeclaredCollection[];
  /** By file, then line and column. */
  problems: ResourceProblem[];
}

/** What the data files declare of the people: the resources `principalOf` takes, and what is wrong in their files. */
export interface DeclaredPeople {
  people: DeclaredResource[];
  /**
   * The problems in each file that declares (or tries to declare) a person, agent or group, and
   * an id two of them share or one of the runtime's own agents (`RUNTIME_AGENTS`) takes. While
   * there are any, nobody is admitted: a broken file never admits more than it says.
   */
  problems: ResourceProblem[];
}

/** The people each load of the people's files declares: the same answer while none of them changed. */
const peopleRead = new WeakMap<Map<string, Loaded>, DeclaredPeople>();

/** The names no data file may give a group: what each is already. */
const RESERVED_GROUPS: ReadonlyMap<string, string> = new Map([
  [AGENTS, "the group every agent is in"],
  [VISITORS, "the group every visitor is in"],
  [ANONYMOUS, "who a public page runs as when nobody is signed in"],
]);

/**
 * A person, agent or group declared in an app's data file: refused, because the people are the
 * company's, so neither the policy (`readPeople`) nor `describeConfig` counts it.
 */
export const inAppPeople = (r: DeclaredResource): boolean =>
  r.vendor === "sanoma" && Object.hasOwn(sanoma, r.type) && r.file.startsWith(`${APPS_DIR}/`);

/**
 * The people, agents and groups the data files under `root` declare (`sanoma.person`, `.agent`,
 * `.group`), as `principalOf` takes them, with what is wrong in their files; none without a root.
 * Only the files that may declare them (`mayDeclarePeople`) are loaded, with the people's and the
 * wakeup's constructors, which the same `sanoma` declares; loaded again only when one of them
 * changed (by its size and time), so a new colleague is admitted once their file is saved, and a
 * request costs a `stat` per file.
 */
export function readPeople(root: string | undefined): DeclaredPeople {
  if (root === undefined) return { people: [], problems: [] };
  const connectors = [peopleConnector, wakeupOps];
  const types = resourceTypesOf(connectors);
  const loaded = loadModules(root, dataFilesOf(root), connectors, { only: mayDeclarePeople, types });
  const cached = peopleRead.get(loaded);
  if (cached) return cached;
  // The people are never bound, so the lockfile is not read.
  const read = declarationsOf(root, loaded, types, { bindings: {}, problems: [] }, true);
  const ofPeople = read.resources.filter((r) => Object.hasOwn(sanoma, r.type));
  const people = ofPeople.filter((r) => !inAppPeople(r));
  const own = read.problems;
  for (const r of ofPeople.filter(inAppPeople)) {
    own.push({
      ...r.at,
      message: `${r.id} declares a ${r.type} in an app: the people are the company's, declared in resources/ at the root`,
    });
  }
  const ids = new Map<string, DeclaredResource>();
  for (const r of people) {
    if (r.type === "group") {
      const reserved = RESERVED_GROUPS.get(r.name);
      if (reserved) own.push({ ...r.at, message: `${r.id} is named "${r.name}", ${reserved}: give it another name` });
      continue;
    }
    const id = r.name;
    const other = ids.get(id);
    if (other || RUNTIME_AGENTS.includes(id) || isVisitor({ id })) {
      own.push({
        ...r.at,
        message: other
          ? `${r.id} has the id "${id}", which ${other.id} has: give each person and agent their own`
          : isVisitor({ id })
            ? `${r.id} has the id "${id}", a visitor's (\`anonymous\` or \`visitor:<login>:<subject>\`): give it another`
            : `${r.id} has the id "${id}", one of the runtime's own agents': give it another`,
      });
    }
    ids.set(id, r);
  }
  const declared = { people, problems: own };
  peopleRead.set(loaded, declared);
  return declared;
}

/**
 * Who `asking` is admitted as, by the people the data files declare (`readPeople`): the declared
 * principal (`principalOf`) of the id it names, a person's or an agent's; for a sign-in
 * (`signIn`), of the person it matches (`personOf`: email, GitHub login, then id), never an agent.
 * While no person is declared, whoever names an id is taken as given. A visitor's id (`isVisitor`)
 * is taken whatever the files say, with the groups stamped here (`visitors`, or none for
 * `anonymous`), never through a sign-in: the staff logins admit no visitor. Throws
 * `NotAdmittedError` for anyone else, and for everyone while the people's files have problems.
 */
export function admit(
  asking: { id?: string; email?: string; github?: string; groups?: string[]; onBehalfOf?: string },
  { people, problems }: { people: readonly PeopleResource[]; problems: readonly ResourceProblem[] },
  signIn = false,
): Principal {
  const who = asking.github ?? asking.id ?? asking.email ?? "This sign-in";
  if (asking.id !== undefined && isVisitor({ id: asking.id })) {
    if (signIn) throw new NotAdmittedError(who);
    return asking.id === ANONYMOUS ? ANONYMOUS_PRINCIPAL : { id: asking.id, groups: [VISITORS] };
  }
  if (problems.length) {
    // The runtime's own agents are declared by no file, so a broken one does not stop them (`check`'s scenarios).
    if (!signIn && asking.id !== undefined && RUNTIME_AGENTS.includes(asking.id)) {
      return principalOf(asking.id, people)!;
    }
    throw new NotAdmittedError(who, problems.map(problemLine));
  }
  if (!declaresPeople(people)) {
    const given = Principal.safeParse(asking).data;
    if (given) return given;
  } else {
    const id = signIn ? personOf(asking, people) : asking.id;
    const admitted = id === undefined ? undefined : principalOf(id, people);
    if (admitted) return admitted;
  }
  throw new NotAdmittedError(who);
}

/**
 * Loads `resources/` under `root`, the config's directory, and each app's: each `.ts` file in it
 * but `*.test.ts`, `*.d.ts` and `node_modules` (`loadModules`), its constructor imports (a
 * connector's `<info.package>/resources`, `sanoma/resources`) served the constructors of
 * `types`. Each export whose value a constructor made is a declaration, `<file>#<export>`, in the
 * file that made it (its non-default name when the file gives two); each resource it names is the
 * declaration that holds that very object.
 *
 * Problems: a file that throws as it loads (a value its type refuses, a type its vendor does not
 * declare, an import of what the config does not serve), at the place its error's stack gives; a
 * resource made but not exported, or exported under two names; one naming a resource no data file
 * exports; a type that is not the config's; and two resources of one type with one identity (and
 * connection). A declaration with a problem is left out, and so is any that names one.
 *
 * The collections `resources/data.ts` declares (`collection()`) are listed by their exports
 * (`collections`), matched to no connector, resource type or lockfile: the runtime imports that
 * file. A collection in another file, or anything else exported from `data.ts`, is a problem.
 *
 * Each declaration is joined to its binding in the lockfile (`readLockfile`) by its key,
 * `<file>#<export>`; a binding no export declares is an orphan, unless its file failed to load.
 * Problems: the lockfile's, a binding of another type than its declaration's, two declarations
 * bound to one object, and several wakeups.
 *
 * `only` loads part of the files: those whose text it passes; in them, a resource of a type
 * outside `types` is left out rather than reported.
 */
export function loadDataFiles(
  root: string | undefined,
  connectors: readonly Connector<any, any>[],
  types: ReadonlyMap<string, Resource> = resourceTypesOf(connectors),
  only?: (text: string) => boolean,
): DataFiles {
  if (root === undefined) {
    const message =
      "The config has no root, so its data files cannot be found: make it with defineConfig, which records its file, or set its `root`";
    return { resources: [], bindings: {}, orphans: [], collections: [], problems: [{ message }] };
  }
  const loaded = loadModules(root, dataFilesOf(root), connectors, { types, ...(only && { only }) });
  return declarationsOf(root, loaded, types, readLockfile(root), only !== undefined);
}

/** What the loaded data files declare, joined to the lockfile's bindings. */
function declarationsOf(
  root: string,
  loaded: Map<string, Loaded>,
  types: ReadonlyMap<string, Resource>,
  lock: { bindings: Bindings; problems: ResourceProblem[] },
  partial: boolean,
): DataFiles {
  const problems: ResourceProblem[] = [...lock.problems];
  const failed = new Set<string>();
  const collectionsFiles = new Set(kindDirs(root, "resources").map((dir) => relOf(root, `${dir}/${COLLECTIONS_FILE}`)));
  const COLLECTIONS_ONLY =
    "resources/data.ts holds collections only, since workflows and the runtime import it: declare a connector's resources in another data file";

  // Each exported value, by identity, to the names it is exported under.
  const names = new Map<Declared, At[]>();
  const exported = new Set<Declared>();
  const collections: DeclaredCollection[] = [];
  for (const [file, l] of loaded) {
    if ("failedIn" in l) {
      failed.add(file);
      continue;
    }
    if ("error" in l) {
      failed.add(file);
      const message = loadProblem(l.error, root, file, partial);
      if (message !== undefined)
        problems.push({ file, ...(l.line !== undefined && { line: l.line, column: l.column ?? 1 }), message });
      continue;
    }
    for (const [name, value] of l.exports) {
      const at = { file, export: name };
      if (isCollection(value)) {
        if (!collectionsFiles.has(file)) {
          problems.push({
            ...at,
            message: `a collection is declared in resources/data.ts, which workflows and the runtime import: move ${name} there`,
          });
        } else {
          collections.push({ id: `${file}#${name}`, file, name: value.name, at });
        }
      } else if (isDeclaredValue(value)) {
        exported.add(value);
        if (collectionsFiles.has(file)) problems.push({ ...at, message: COLLECTIONS_ONLY });
        else names.set(value, [...(names.get(value) ?? []), at]);
      }
    }
  }

  // Each declaration: one name per object, a non-default one over `default`.
  const declarations = new Map<string, { value: Declared; at: At }>();
  const idOf = new Map<Declared, string>();
  for (const [value, ats] of names) {
    const named = ats.filter((at) => at.export !== "default");
    const kept = named.length ? named : ats;
    if (kept.length > 1) {
      const [first, ...rest] = kept.map((at) => `${at.file}#${at.export}`);
      problems.push({
        ...kept[1]!,
        message: `${rest.join(", ")} and ${first} are one ${value[DECLARED]}: export each resource under one name`,
      });
      continue;
    }
    const at = kept[0]!;
    const type = types.get(value[DECLARED]);
    if (type === undefined || madeOf(value) === undefined) {
      if (!partial)
        problems.push({
          ...at,
          message: `${value[DECLARED]} is not a resource type of a connector in the config's \`connectors\`: add the connector, and import from its package's \`/resources\``,
        });
      continue;
    }
    const id = `${at.file}#${at.export}`;
    declarations.set(id, { value, at });
    idOf.set(value, id);
  }
  // A resource made and never exported is declared nowhere: a typo'd export, or one written inline.
  for (const value of madeWith(loaded)) {
    const made = madeOf(value)!;
    if (!isDeclaredValue(value) || exported.has(value) || failed.has(made.file)) continue;
    problems.push({
      file: made.file,
      message: `a ${value[DECLARED]}${value.name === undefined ? "" : ` "${value.name}"`} is made here but not exported: declare each resource as its own \`export const <name> = <vendor>.<type>({ … })\``,
    });
  }

  // Each declaration after the ones it names; one with a problem is left out, and so is any that names it.
  const done = new Map<string, Record<string, string> | undefined>();
  const byName = new Map<string, string>();
  const leaveOut = (id: string, message?: string) => {
    if (message !== undefined) problems.push({ ...declarations.get(id)!.at, message });
    done.set(id, undefined);
  };
  function declare(id: string): Record<string, string> | undefined {
    if (done.has(id)) return done.get(id);
    const { value } = declarations.get(id)!;
    const refs: Record<string, string> = {};
    for (const [path, target] of Object.entries(madeOf(value)!.refers)) {
      const targetId = idOf.get(target);
      if (targetId === undefined) {
        leaveOut(
          id,
          `${path} names a ${target[DECLARED]}${target.name === undefined ? "" : ` "${target.name}"`} that no data file exports: export it from a data file and import it here`,
        );
        return undefined;
      }
      if (!declare(targetId)) return void done.set(id, undefined);
      refs[path] = targetId;
    }
    if (value.name !== undefined) {
      const key = `${value[DECLARED]} ${JSON.stringify(value.name)}${value.connection ? ` (${value.connection.$connection})` : ""}`;
      const first = byName.get(key);
      if (first !== undefined) {
        leaveOut(
          id,
          `${key} is declared twice, also as ${first}: declare each resource once, and import it where it is used`,
        );
        return undefined;
      }
      byName.set(key, id);
    }
    done.set(id, refs);
    return refs;
  }

  // Each binding against its declaration: of its type, and the only one bound to its object.
  const boundBy = new Map<string, string>();
  for (const [id, { value }] of declarations) {
    const binding = lock.bindings[id];
    if (binding === undefined) continue;
    const object = `${binding.type} ${binding.id}${binding.connection ? ` (${binding.connection.$connection})` : ""}`;
    const first = boundBy.get(object);
    const why =
      value.connection !== undefined && binding.connection?.$connection !== value.connection.$connection
        ? `${id} changes the connection of a bound resource: explicitly unbind it before selecting another account`
        : binding.type !== value[DECLARED]
          ? `${id} is bound to a ${binding.type} in ${LOCKFILE}, but declares a ${value[DECLARED]}`
          : first !== undefined
            ? `${id} is bound to the same ${object} as ${first} in ${LOCKFILE}: bind each object once`
            : undefined;
    if (why === undefined) boundBy.set(object, id);
    else leaveOut(id, why);
  }
  // An instance registers with one wakeup: several are each a problem, and left out, as is any that names one.
  const wakeups = [...declarations.keys()].filter((id) => types.get(declarations.get(id)!.value[DECLARED])?.wakeup);
  if (wakeups.length > 1) {
    for (const id of wakeups) {
      leaveOut(
        id,
        `an instance has one wakeup: leave out this one or ${wakeups.filter((other) => other !== id).join(", ")}`,
      );
    }
  }
  // A binding under a file that failed to load is no orphan: what it declares is not known.
  const orphans = Object.entries(lock.bindings)
    .filter(([key]) => !declarations.has(key) && !failed.has(key.slice(0, key.lastIndexOf("#"))))
    .map(([key, binding]) => ({ key, ...binding }));

  const resources: DeclaredResource[] = [];
  for (const [id, { value, at }] of declarations) {
    const refs = declare(id);
    if (!refs) continue;
    const { vendor, type, name: identity, desired, connection } = value;
    const binding = lock.bindings[id]?.id;
    resources.push({
      id,
      file: at.file,
      vendor,
      type,
      name: identity ?? at.export,
      ...(identity !== undefined && { identity }),
      ...(binding !== undefined && { binding }),
      at,
      // A copy: the loaded value is the generation's, read again while no file changes.
      desired: structuredClone(desired) as Record<string, unknown>,
      ...(connection && { connection: { ...connection } }),
      refs,
    });
  }
  problems.sort(
    (a, b) =>
      (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0),
  );
  return { resources, bindings: lock.bindings, orphans, collections, problems };
}

/** A declared resource: what a constructor returns. */
const isDeclaredValue = (value: unknown): value is Declared =>
  isObject(value) && typeof (value as Partial<Declared>)[DECLARED] === "string";

/**
 * What a data file that failed to load is told, on one line: an import Node could not find (a
 * connector the config does not have, a file that is not there), top-level `await`, or the
 * error's own message (a constructor's refusal: `github.repository: no field wiki`). Nothing, when
 * `partial`, for a connector's constructors left out of the load in a file that declares no
 * person, agent or group (`sanoma.wakeup` beside its host's connector).
 */
function loadProblem(error: unknown, root: string, file: string, partial: boolean): string | undefined {
  const { code, message } = isObject(error) ? (error as { code?: unknown; message?: unknown }) : {};
  const text = typeof message === "string" ? message : String(error);
  if (code === "ERR_REQUIRE_ASYNC_MODULE")
    return "a data file is loaded synchronously: leave out top-level `await`, and compute values where they are used";
  if (code === "ERR_MODULE_NOT_FOUND") {
    const missing = /^Cannot find (?:package|module) '([^']+)'/.exec(text)?.[1];
    const source = readFileSync(`${root}/${file}`, "utf8");
    // The specifier as written: Node names a package by its name, a file by its path.
    const written =
      missing &&
      [...source.matchAll(/from\s*["']([^"']+)["']/g)]
        .map((m) => m[1]!)
        .find(
          (spec) =>
            spec === missing ||
            spec.startsWith(`${missing}/`) ||
            (missing.startsWith("/") && missing.endsWith(`/${spec.replace(/^(?:\.\.?\/)+/, "")}`)),
        );
    if (written?.endsWith("/resources") && partial && !/\.\s*(?:person|agent|group)\s*\(/.test(source))
      return undefined;
    if (written?.endsWith("/resources"))
      return `"${written}" is not the resources entry of a connector in the config's \`connectors\`: add the connector, and import from its package's \`/resources\``;
    if (written !== undefined)
      return `"${written}" cannot be found: import a file that is there, or a package the company has`;
  }
  return text.replaceAll(/\s*\n\s*/g, " ");
}

/** A path under `root`, relative to it with `/`. */
const relOf = (root: string, path: string) => relative(root, path).split(sep).join("/");

/** The data files under `root`: the root's `resources/`, then each app's, each sorted. */
const dataFilesOf = (root: string): string[] => kindDirs(root, "resources").flatMap(dataFilesUnder);

/** The data files under `dir`, sorted: regular `.ts` files, less tests, declarations and `node_modules`. */
const dataFilesUnder = (dir: string): string[] =>
  filesUnder(dir, (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"));
