import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parsed } from "./ast.ts";
import {
  type DataFile,
  type DataFileExport,
  type DataValue,
  readDataFile,
  Reference,
  SECRET_ENTRIES,
} from "./datafile.ts";
import { type Binding, type Bindings, LOCKFILE, readLockfile } from "./lockfile.ts";
import { type Connector, VENDOR } from "./op.ts";
import { filesUnder } from "./paths.ts";
import { peopleConnector, sanoma } from "./person.ts";
import { wakeupOps } from "./wakeup-type.ts";
import type { Span } from "./outline.ts";
import { type Declared, type Resource, resourceTypesOf } from "./resource.ts";
import { Principal } from "./define.ts";
import { NotAdmittedError } from "./errors.ts";
import {
  AGENTS,
  ANONYMOUS,
  ANONYMOUS_PRINCIPAL,
  declaresPeople,
  isVisitor,
  type PeopleResource,
  personOf,
  principalOf,
  problemLine,
  RUNTIME_AGENTS,
  VISITORS,
} from "./shared.ts";

/** A resource a data file declares, as read from the file without running it. */
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
  /** Its `export const` statement, as UTF-16 offsets into the file's text. */
  span: Span;
  /** Its fields, as its type checked them: each resource it names as that resource's `name`. */
  desired: Record<string, unknown>;
  /**
   * Where it names another declared resource: the field's dotted path (a list item's with its
   * index, `teams.0`) to that resource's id.
   */
  refs: Record<string, string>;
}

/**
 * A collection `resources/data.ts` declares, as read without running it: where it is, for the
 * Resources page. Its fields are the collection's own (`describeConfig`'s `collections`), from
 * the same file, which the runtime imports.
 */
export interface DeclaredCollection {
  /** `<file>#<export>`, as a resource's: `resources/data.ts#outbound`. */
  id: string;
  /** `resources/data.ts`. */
  file: string;
  /** The collection's name, its operations' middle segment (`data.<name>.get`). */
  name: string;
  /** Its `export const` statement, as UTF-16 offsets into the file's text. */
  span: Span;
}

/** Something wrong in the data files, or in finding them. */
export interface ResourceProblem {
  /**
   * The data file, relative to the config's root, with `/`: `resources/identity/github.ts`.
   * Absent, with `line` and `column`, when the problem is the config's: it has no root.
   */
  file?: string;
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
  /** By file, line and column. */
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

/** A file that imports the runtime's constructors, `sanoma` (by any local name): the files `readPeople` reads. */
export const DECLARES_PEOPLE = /\{[^}]*\bsanoma\b[^}]*\}\s*from\s*["'](?:sanoma|@sanoma-ai\/workflows)\/resources["']/;
/** The last read of the people under each root, by what its data files were then (`filesStamp`). */
const peopleRead = new Map<string, { stamp: string; read: DeclaredPeople }>();

/** Each data file under `root` with its size and modification time: unchanged while the files are. */
const filesStamp = (root: string) =>
  dataFilesUnder(join(root, "resources"))
    .map((path) => {
      // Gone since it was listed (an editor's save by rename): stamped as such, and read next time.
      const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
      return `${path} ${stat?.size} ${stat?.mtimeNs}`;
    })
    .join("\n");

/** The names no data file may give a group: what each is already. */
const RESERVED_GROUPS: ReadonlyMap<string, string> = new Map([
  [AGENTS, "the group every agent is in"],
  [VISITORS, "the group every visitor is in"],
  [ANONYMOUS, "who a public page runs as when nobody is signed in"],
]);

/**
 * The people, agents and groups the data files under `root` declare (`sanoma.person`, `.agent`,
 * `.group`), read without running them, as `principalOf` takes them, with what is wrong in their
 * files; none without a root. Read again only when a data file changed (by its size and time),
 * so a new colleague is admitted once their file is saved, and a request costs a `stat` per file.
 */
export function readPeople(root: string | undefined): DeclaredPeople {
  if (root === undefined) return { people: [], problems: [] };
  const stamp = filesStamp(root);
  const cached = peopleRead.get(root);
  if (cached?.stamp === stamp) return cached.read;
  // With the wakeup's type, which the same constructors declare: read, and only the people's kept.
  const read = readDataFiles(root, [peopleConnector, wakeupOps], undefined, (source) => DECLARES_PEOPLE.test(source));
  const people = read.resources.filter((r) => Object.hasOwn(sanoma, r.type));
  // The people are never bound, so the lockfile's problems are not theirs.
  const own = read.problems.filter((p) => p.file !== LOCKFILE);
  const ids = new Map<string, DeclaredResource>();
  for (const r of people) {
    if (r.type === "group") {
      const reserved = RESERVED_GROUPS.get(r.name);
      if (reserved)
        own.push({ file: r.file, message: `${r.id} is named "${r.name}", ${reserved}: give it another name` });
      continue;
    }
    const id = r.name;
    const other = ids.get(id);
    if (other || RUNTIME_AGENTS.includes(id) || isVisitor({ id })) {
      own.push({
        file: r.file,
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
  peopleRead.set(root, { stamp, read: declared });
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

interface FileEntry {
  /** Relative to the config's root, with `/`. */
  rel: string;
  data: DataFile;
  /** Records a problem at an offset into the file. */
  problem: (offset: number, message: string) => void;
}

/**
 * Reads `resources/` under `root`, the config's directory: each `.ts` file in it but
 * `*.test.ts`, `*.d.ts` and `node_modules`, parsed with oxc and held to the data-file subset
 * (`readDataFile`). A constructor import (`@sanoma-ai/connector-github/resources`) is matched to the
 * connector whose `info.package` it names, never imported; each resource is checked by calling
 * its type, as running the file would, with each resource it names given as that resource.
 *
 * Problems: anything outside the subset, a constructor or data file the config does not know, a
 * type the connector does not declare, a value the type refuses (a reference where its type
 * takes none among them), a reference cycle, and two resources of one type with one identity.
 *
 * The collections `resources/data.ts` declares are listed as they are read (`collections`),
 * never matched to a connector, a resource type or the lockfile: the runtime imports that file.
 *
 * Each declaration is joined to its binding in the lockfile (`readLockfile`) by its key,
 * `<file>#<export>`; a binding no export declares is an orphan. Problems: the lockfile's, a
 * binding of another type than its declaration's, and two declarations bound to one object.
 *
 * `partial` reads part of the files: only those whose source it passes, and in them, an import of
 * a connector not in `connectors`, or of a file left out, is left unread rather than reported.
 */
export function readDataFiles(
  root: string | undefined,
  connectors: readonly Connector<any, any>[],
  types: ReadonlyMap<string, Resource> = resourceTypesOf(connectors),
  partial?: (source: string) => boolean,
): DataFiles {
  const problems: ResourceProblem[] = [];
  if (root === undefined) {
    problems.push({
      message:
        "The config has no root, so its data files cannot be found: make it with defineConfig, which records its file, or set its `root`",
    });
    return { resources: [], bindings: {}, orphans: [], collections: [], problems };
  }
  const lock = readLockfile(root);
  problems.push(...lock.problems);

  const files = new Map<string, FileEntry>();
  const left = new Set<string>();
  for (const path of dataFilesUnder(join(root, "resources"))) {
    const rel = relative(root, path).split(sep).join("/");
    const source = readFileSync(path, "utf8");
    if (partial && !partial(source)) {
      left.add(path);
      continue;
    }
    const { program, problems: syntax, at } = parsed(source, path);
    const data = readDataFile(program, path, join(root, "resources"));
    const problem = (offset: number, message: string) => problems.push({ file: rel, ...at(offset), message });
    for (const p of syntax) problems.push({ file: rel, ...p });
    for (const p of data.problems) problem(p.start, p.message);
    files.set(path, { rel, data, problem });
  }

  // Each connector's constructors entry, `<info.package>/resources`, to its vendor.
  const entries = new Map<string, string>();
  for (const connector of connectors) {
    const { id, info } = connector[VENDOR];
    if (info?.package) entries.set(`${info.package}/resources`, id);
  }
  // The runtime's own (`peopleConnector`, package `sanoma`) is imported from either name of its entry.
  if (entries.get("sanoma/resources") === "sanoma") for (const entry of SECRET_ENTRIES) entries.set(entry, "sanoma");

  // What each file's names stand for, and every resource read by its id.
  const vendors = new Map<FileEntry, Map<string, string>>();
  const named = new Map<FileEntry, Map<string, string>>();
  const declarations = new Map<string, { file: FileEntry; exp: DataFileExport }>();
  for (const [path, file] of files) {
    const fileVendors = new Map<string, string>();
    const fileNamed = new Map<string, string>();
    for (const imp of file.data.imports) {
      if (imp.kind === "constructors") {
        const vendor = entries.get(imp.source);
        if (vendor === undefined && partial) continue;
        if (vendor === undefined) {
          file.problem(
            imp.start,
            `"${imp.source}" is not the resources entry of a connector in the config's \`connectors\`: add the connector, and import from its package's \`/resources\``,
          );
        } else if (imp.imported !== vendor) {
          file.problem(
            imp.start,
            `"${imp.source}" exports its constructors as ${vendor}: \`import { ${vendor} } from "${imp.source}"\``,
          );
        } else {
          fileVendors.set(imp.local, vendor);
        }
        continue;
      }
      const target = resolve(dirname(path), imp.source);
      const other = files.get(target);
      if (!other && left.has(target)) continue;
      if (!other) {
        file.problem(imp.start, `"${imp.source}" is not a data file under resources/`);
      } else if (!other.data.declared.includes(imp.imported)) {
        file.problem(imp.start, `${imp.imported} is not a resource ${other.rel} declares`);
      } else if (other.data.exports.some((e) => e.name === imp.imported)) {
        fileNamed.set(imp.local, `${other.rel}#${imp.imported}`);
      }
      // Else its value was refused, and reported in its file: a reference to it fails quietly.
    }
    for (const exp of file.data.exports) {
      const id = `${file.rel}#${exp.name}`;
      fileNamed.set(exp.name, id);
      declarations.set(id, { file, exp });
    }
    vendors.set(file, fileVendors);
    named.set(file, fileNamed);
  }

  // Each resource after the ones it names, which it is given as they are declared.
  const done = new Map<string, { declared: Declared; refs: Record<string, string> } | undefined>();
  const visiting: string[] = [];
  const byName = new Map<string, string>();
  function declare(id: string) {
    if (done.has(id)) return done.get(id);
    const { file, exp } = declarations.get(id)!;
    if (visiting.includes(id)) {
      file.problem(exp.start, `${id} refers to itself: ${[...visiting.slice(visiting.indexOf(id)), id].join(" → ")}`);
      return undefined;
    }
    visiting.push(id);
    const result = build(file, exp);
    visiting.pop();
    if (result?.declared.name !== undefined) {
      const { vendor, type, name } = result.declared;
      const key = `${vendor}.${type} ${JSON.stringify(name)}`;
      const first = byName.get(key);
      if (first === undefined) byName.set(key, id);
      else {
        file.problem(
          exp.start,
          `${key} is declared twice, also as ${first}: declare each resource once, and import it where it is used`,
        );
        done.set(id, undefined);
        return undefined;
      }
    }
    done.set(id, result);
    return result;
  }

  function build(file: FileEntry, exp: DataFileExport) {
    // An unknown constructors import was reported with the import.
    const vendor = vendors.get(file)!.get(exp.vendor);
    if (vendor === undefined) return undefined;
    const resource = types.get(`${vendor}.${exp.type}`);
    if (!resource) {
      const known = [...types.values()].filter((r) => r.vendor === vendor).map((r) => r.type);
      file.problem(exp.start, `${vendor} has no resource type ${exp.type}: its types are ${known.join(", ")}`);
      return undefined;
    }
    const refs: Record<string, string> = {};
    let ok = true;
    // The fields with each name of a resource as that resource, and where each is named.
    const given = (v: DataValue, at: string): unknown => {
      if (v instanceof Reference) {
        // A name that did not resolve was reported where it is bound.
        const target = named.get(file)!.get(v.name);
        const declared = target === undefined ? undefined : declare(target)?.declared;
        if (!declared) ok = false;
        else refs[at] = target!;
        return declared;
      }
      if (Array.isArray(v)) return v.map((item, i) => given(item, `${at}.${i}`));
      if (v === null || typeof v !== "object") return v;
      return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, given(item, at ? `${at}.${k}` : k)]));
    };
    const fields = given(exp.desired, "");
    if (!ok) return undefined;
    try {
      // Checked as running the file would: by the resource type, which allows a resource only where its `fields.references` say.
      return { declared: resource(fields as never), refs };
    } catch (e) {
      // One line per problem: zod's own spans lines.
      file.problem(exp.start, `export const ${exp.name}: ${(e as Error).message.replaceAll(/\s*\n\s*/g, " ")}`);
      return undefined;
    }
  }

  // Each binding against its declaration: of its type, and the only one bound to its object.
  const boundBy = new Map<string, string>();
  for (const [id, { file, exp }] of declarations) {
    const binding = lock.bindings[id];
    // An unknown constructors import was reported with the import.
    const vendor = vendors.get(file)!.get(exp.vendor);
    if (binding === undefined || vendor === undefined) continue;
    const type = `${vendor}.${exp.type}`;
    const object = `${binding.type} ${binding.id}`;
    const first = boundBy.get(object);
    const why =
      binding.type !== type
        ? `${id} is bound to a ${binding.type} in ${LOCKFILE}, but declares a ${type}`
        : first !== undefined
          ? `${id} is bound to the same ${object} as ${first} in ${LOCKFILE}: bind each object once`
          : undefined;
    if (why === undefined) boundBy.set(object, id);
    else {
      // Left out, as any declaration with a problem, and so is any that names it.
      file.problem(exp.start, why);
      done.set(id, undefined);
    }
  }
  // An instance registers with one wakeup: several are each a problem, and left out, as is any that names one.
  const wakeups = [...declarations].filter(
    ([, { file, exp }]) => types.get(`${vendors.get(file)!.get(exp.vendor)}.${exp.type}`)?.wakeup,
  );
  if (wakeups.length > 1) {
    for (const [id, { file, exp }] of wakeups) {
      const others = wakeups.filter(([other]) => other !== id).map(([other]) => other);
      file.problem(exp.start, `an instance has one wakeup: leave out this one or ${others.join(", ")}`);
      done.set(id, undefined);
    }
  }
  const keys = new Set([...files.values()].flatMap((f) => f.data.declared.map((name) => `${f.rel}#${name}`)));
  const orphans = Object.entries(lock.bindings)
    .filter(([key]) => !keys.has(key))
    .map(([key, binding]) => ({ key, ...binding }));

  const resources: DeclaredResource[] = [];
  for (const [id, { file, exp }] of declarations) {
    const result = declare(id);
    if (!result) continue;
    const { vendor, type, name: identity, desired } = result.declared;
    const binding = lock.bindings[id]?.id;
    resources.push({
      id,
      file: file.rel,
      vendor,
      type,
      name: identity ?? exp.name,
      ...(identity !== undefined && { identity }),
      ...(binding !== undefined && { binding }),
      span: [exp.start, exp.end],
      desired,
      refs: result.refs,
    });
  }
  const collections = [...files.values()].flatMap(({ rel, data }) =>
    data.collections.map((c) => ({
      id: `${rel}#${c.export}`,
      file: rel,
      name: c.name,
      span: [c.start, c.end] as Span,
    })),
  );
  problems.sort(
    (a, b) =>
      (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0),
  );
  return { resources, bindings: lock.bindings, orphans, collections, problems };
}

/** The data files under `dir`, sorted: regular `.ts` files, less tests, declarations and `node_modules`. */
const dataFilesUnder = (dir: string): string[] =>
  filesUnder(dir, (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"));
