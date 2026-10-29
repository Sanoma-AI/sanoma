import type { ConnectionRef } from "./connection.ts";
import { basename, dirname, join, relative } from "node:path";
import type { Node } from "./ast.ts";
import { inside, nearestDir, RELATIVE } from "./paths.ts";
import { type Secret, SECRET_NAME } from "./secret.ts";
import { checkCollection, errorMessage } from "./shared.ts";

// The one definition of what a data file may hold, over an ESTree program from oxc: the reader
// (`resources.ts`), `lintResources` (`lint.ts`) and the oxlint plugin (`plugin.ts`) all
// read a file through `readDataFile`. Type imports only, so the plugin, which oxlint hands its
// own tree, never loads oxc-parser.

/** Something a data file may not hold, at UTF-16 offsets into its text. */
export interface DataFileProblem {
  start: number;
  end: number;
  message: string;
}

/** A name in a data file that refers to a declared resource: one imported from a data file, or exported by this one. */
export class Reference {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

const REFERENCE = Symbol.for("sanoma.reference");
Object.defineProperty(Reference.prototype, REFERENCE, { value: true });

/** True for a `Reference`, made by any copy of this package: read by a registered symbol, not `instanceof`. */
export const isReference = (value: unknown): value is Reference =>
  typeof value === "object" && value !== null && REFERENCE in value;

/** What `secret("NAME")` stands for in a data file: its marker, `{ $secret: "NAME", generate?: true }`. */
export type SecretRef = Secret;

/** A value in a data file: a literal, a reference to a declared resource, or a secret's marker. */
export type DataValue =
  | null
  | boolean
  | number
  | string
  | Reference
  | SecretRef
  | DataValue[]
  | { [field: string]: DataValue };

/** An `import { name } from "…"`: of a connector's constructors (`from "…/resources"`), or of another data file's resource. */
export interface DataFileImport {
  kind: "constructors" | "file";
  /** The specifier as written. */
  source: string;
  /** The name the other module exports. */
  imported: string;
  /** The name it has in this file. */
  local: string;
  start: number;
}

/** An `export const name = vendor.type({ … })`. */
export interface DataFileExport {
  name: string;
  /** The local name of the constructors it calls (`github`). */
  vendor: string;
  type: string;
  desired: { [field: string]: DataValue };
  connection?: ConnectionRef;
  /** The `export const` statement. */
  start: number;
  end: number;
}

/** An `export const name = collection({ … })` in `resources/data.ts`, its declaration one `collection()` takes. */
export interface DataFileCollection {
  /** The `export const`'s name. */
  export: string;
  /** The collection's name. */
  name: string;
  /** The `export const` statement. */
  start: number;
  end: number;
}

export interface DataFile {
  imports: DataFileImport[];
  /** Each `export const` whose value is in the subset. */
  exports: DataFileExport[];
  /** Each collection `resources/data.ts` declares (`COLLECTIONS_FILE`); none in any other data file. */
  collections: DataFileCollection[];
  /** Every name an `export const` declares as a resource, its value in the subset or not: none in `resources/data.ts`. */
  declared: string[];
  problems: DataFileProblem[];
}

/** A connector's constructors entry: a package specifier that ends in `/resources`. */
const CONSTRUCTORS = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*\/resources$/;

/**
 * Where a data file imports `secret` from, and `sanoma`, the runtime's own resource constructors
 * (its people: `sanoma.person`, `.agent`, `.group`); checked before `CONSTRUCTORS`, which they match too.
 */
export const SECRET_ENTRIES: ReadonlySet<string> = new Set(["sanoma/resources", "@sanoma-ai/workflows/resources"]);
/** Where `resources/data.ts` imports `collection` from, and the only imports it may make. */
export const DATA_ENTRIES: ReadonlySet<string> = new Set(["sanoma/data", "@sanoma-ai/workflows/data"]);
/**
 * The one data file that holds collections, relative to `resources/`. Workflows and the runtime
 * import it, so it imports only `collection` from "sanoma/data" and holds nothing else.
 */
export const COLLECTIONS_FILE = "data.ts";
const COLLECTION_CALL = '`export const <name> = collection({ name: "…", key: "…", fields: { … } })`';
const COLLECTIONS_ONLY =
  "resources/data.ts holds collections only, since workflows and the runtime import it: " +
  `\`import { collection } from "sanoma/data"\` and ${COLLECTION_CALL}; declare a connector's resources in another data file`;
const SECRET_CALL = '`secret("NAME")` or `secret("NAME", { generate: true })`, NAME upper case (A-Z, 0-9 and _)';

const SHAPE =
  "a data file holds only imports, `export const <name> = <vendor>.<type>({ … })` and `export default [ … ]`";
const IMPORTS =
  "import resource constructors from a connector's resources entry " +
  '(`import { github } from "@sanoma-ai/connector-github/resources"`) ' +
  'and resources from other data files (`import { site } from "./github.ts"`), and `secret` from "sanoma/resources"';
const VALUES = "write a string, number, boolean, null, object or array, or name a declared resource";

/**
 * Reads a data file's program without running it: its imports, each `export const` resource
 * with its fields evaluated, and everything outside the data-file subset as a problem that says
 * what to write instead.
 *
 * The subset: named imports, from a connector's `…/resources` entry or a `.ts` data file;
 * `export const <name> = <vendor>.<type>({ … })`, one per statement, its argument built of
 * strings (template literals without `${}` too), numbers, booleans, null, objects and arrays,
 * and names of resources this file declares or imports; and `export default [a, b]`.
 * `resources/data.ts` (`COLLECTIONS_FILE`) is the exception, the one data file workflows and the
 * runtime import: it imports only `collection` from "sanoma/data", and each `export const` is
 * `collection({ … })` with its values written out (`DataFile.collections`). No other data file
 * declares a collection, and none imports one.
 *
 * `root` is the directory relative imports must stay in: by default the nearest `resources/`
 * directory above `filename`, else the file's own.
 */
export function readDataFile(
  program: Node,
  filename: string,
  root: string = nearestDir(filename, ["resources"]),
): DataFile {
  const problems: DataFileProblem[] = [];
  const fail = (node: { start: number; end: number }, message: string) =>
    problems.push({ start: node.start, end: node.end, message });
  const imports: DataFileImport[] = [];
  const exports: DataFileExport[] = [];
  const collections: DataFileCollection[] = [];
  const collectionsFile = relative(root, filename) === COLLECTIONS_FILE;
  // What the file may hold, for the problems that say so.
  const shape = collectionsFile ? COLLECTIONS_ONLY : SHAPE;
  // Names a refused import or declaration binds: reported once, where they are bound.
  const refused = new Set<string>();
  // The local names of `secret`, and of `collection`.
  const secrets = new Set<string>();
  const collectionCalls = new Set<string>();

  // Imports and top-level names first, each once: imports are hoisted, and a reference may name
  // a resource declared further down. An unexported const is refused where it is declared, not
  // again where it is used.
  const bound = new Set<string>();
  const bind = (id: Node) => {
    if (bound.has(id.name)) fail(id, `${id.name} is declared twice in this file: give each its own name`);
    bound.add(id.name);
  };
  const declared = new Set<string>();
  for (const s of program.body) {
    if (s.type === "ImportDeclaration") {
      for (const sp of s.specifiers) bind(sp.local);
      readImport(s);
      continue;
    }
    const decl = s.type === "ExportNamedDeclaration" ? s.declaration : s;
    if (decl?.type !== "VariableDeclaration") continue;
    for (const d of decl.declarations) {
      if (d.id.type !== "Identifier") continue;
      bind(d.id);
      (decl === s ? refused : declared).add(d.id.name);
    }
  }

  for (const s of program.body) {
    switch (s.type) {
      case "ImportDeclaration":
        break;
      case "ExportNamedDeclaration":
        readExport(s);
        break;
      case "ExportDefaultDeclaration":
        readDefault(s);
        break;
      case "ExportAllDeclaration":
        fail(s, `export * is not allowed in a data file: ${shape}`);
        break;
      case "VariableDeclaration": {
        const name = s.declarations[0]?.id?.name;
        fail(
          s,
          name === undefined
            ? `an unexported declaration is not allowed in a data file: ${shape}`
            : `\`${s.kind} ${name}\` is not allowed in a data file: export it as ${collectionsFile ? `a collection, \`export const ${name} = collection({ … })\`` : `a resource, \`export const ${name} = <vendor>.<type>({ … })\``}, or write its value where it is used`,
        );
        break;
      }
      default:
        fail(s, `${describe(s)} is not allowed in a data file: ${shape}`);
    }
  }

  function readImport(s: Node) {
    const spec: string = s.source.value;
    if (s.importKind === "type") {
      fail(s, "`import type` is not allowed in a data file: it holds values only, and the constructors type them");
      return;
    }
    if (collectionsFile !== DATA_ENTRIES.has(spec)) {
      fail(
        s.source,
        collectionsFile
          ? `import "${spec}" is not allowed in resources/data.ts: ${COLLECTIONS_ONLY}`
          : `import "${spec}" is not allowed here: collections are declared in resources/data.ts, the one data file workflows and the runtime import; move it there`,
      );
      for (const sp of s.specifiers) refused.add(sp.local.name);
      return;
    }
    const refusal = whyRefused(spec);
    if (refusal) {
      fail(s.source, `import "${spec}" is not allowed in a data file: ${refusal}`);
      for (const sp of s.specifiers) refused.add(sp.local.name);
      return;
    }
    if (!s.specifiers.length) {
      fail(s, `import "${spec}" is not allowed in a data file: it imports nothing, and a data file runs no code`);
      return;
    }
    // The one name each of these entries gives a data file.
    const [only, locals] = SECRET_ENTRIES.has(spec)
      ? ["secret", secrets]
      : DATA_ENTRIES.has(spec)
        ? ["collection", collectionCalls]
        : [];
    if (locals) {
      for (const sp of s.specifiers) {
        const imported =
          sp.type === "ImportSpecifier" && sp.importKind !== "type" && (sp.imported.name ?? sp.imported.value);
        if (imported === only) {
          locals.add(sp.local.name);
        } else if (imported === "sanoma" && SECRET_ENTRIES.has(spec)) {
          // The runtime's own constructors, matched to its connector as a connector's are.
          imports.push({ kind: "constructors", source: spec, imported, local: sp.local.name, start: sp.start });
        } else {
          const [names, allowed] = SECRET_ENTRIES.has(spec)
            ? ["`secret` and `sanoma`", `${only}, sanoma`]
            : [`\`${only}\``, only];
          fail(sp, `a data file imports only ${names} from "${spec}": \`import { ${allowed} } from "${spec}"\``);
          refused.add(sp.local.name);
        }
      }
      return;
    }
    for (const sp of s.specifiers) {
      if (sp.type !== "ImportSpecifier") {
        const how = sp.type === "ImportNamespaceSpecifier" ? `import * as ${sp.local.name}` : `import ${sp.local.name}`;
        fail(sp, `${how} is not allowed in a data file: import the names you use, \`import { name } from "${spec}"\``);
        continue;
      }
      if (sp.importKind === "type") {
        fail(sp, "`type` imports are not allowed in a data file: it holds values only, and the constructors type them");
        continue;
      }
      const imported: string = sp.imported.name ?? sp.imported.value;
      const kind = RELATIVE.test(spec) ? "file" : "constructors";
      imports.push({ kind, source: spec, imported, local: sp.local.name, start: sp.start });
    }
  }

  /** Why an import's specifier is not allowed in a data file, or undefined when it is. */
  function whyRefused(spec: string): string | undefined {
    if (!RELATIVE.test(spec)) return CONSTRUCTORS.test(spec) || DATA_ENTRIES.has(spec) ? undefined : IMPORTS;
    if (!spec.endsWith(".ts")) return "name the data file with its `.ts` extension";
    if (join(dirname(filename), spec) === join(root, COLLECTIONS_FILE)) {
      return "resources/data.ts holds collections, which no resource names; import resources from other data files";
    }
    if (!inside(root, join(dirname(filename), spec))) {
      return `it reaches outside ${basename(root)}/; import only other data files`;
    }
    return undefined;
  }

  function readExport(s: Node) {
    const decl = s.declaration;
    if (!decl) {
      fail(
        s,
        s.source
          ? `export … from "${s.source.value}" is not allowed in a data file: import what you reference, and export only resources declared here`
          : "export { … } is not allowed in a data file: export each resource where it is declared, `export const name = <vendor>.<type>({ … })`",
      );
      return;
    }
    if (decl.type !== "VariableDeclaration") {
      fail(s, `${describe(decl)} is not allowed in a data file: ${shape}`);
      return;
    }
    if (decl.kind !== "const") {
      fail(s, `\`export ${decl.kind}\` is not allowed in a data file: use \`export const\``);
      return;
    }
    if (decl.declarations.length !== 1) {
      fail(s, "declare one resource per `export const`");
      return;
    }
    const [d] = decl.declarations;
    if (d.id.type !== "Identifier") {
      fail(d.id, "an `export const` names one resource: `export const name = <vendor>.<type>({ … })`");
      return;
    }
    const name: string = d.id.name;
    // A second declaration of the name was reported where it is bound.
    if (exports.some((e) => e.name === name) || collections.some((c) => c.export === name)) return;
    const init = d.init;
    const callee = init?.type === "CallExpression" ? init.callee : undefined;
    // A name a refused import binds was reported with the import.
    const head = callee?.type === "MemberExpression" ? callee.object : callee;
    if (head?.type === "Identifier" && refused.has(head.name)) return;
    if (collectionsFile) {
      readCollection(s, init, name);
      return;
    }
    if (
      callee?.type !== "MemberExpression" ||
      callee.computed ||
      callee.object.type !== "Identifier" ||
      callee.property.type !== "Identifier"
    ) {
      fail(
        init ?? d,
        `export const ${name} must be a resource constructor call, \`<vendor>.<type>({ … })\`, with <vendor> imported from a connector's resources entry`,
      );
      return;
    }
    const vendor: string = callee.object.name;
    const type: string = callee.property.name;
    if (imports.find((i) => i.local === vendor)?.kind !== "constructors") {
      fail(
        callee.object,
        `${vendor} is not a connector's resource constructors: import it from the connector's resources entry, \`import { ${vendor} } from "@sanoma-ai/connector-${vendor}/resources"\``,
      );
      return;
    }
    const [arg, options] = init.arguments;
    if (init.arguments.length < 1 || init.arguments.length > 2 || arg.type !== "ObjectExpression") {
      fail(init, `${vendor}.${type} takes desired fields and optional { connection: { vendor, $connection } }`);
      return;
    }
    let connection: ConnectionRef | undefined;
    if (options) {
      const parsed = value(options) as { connection?: ConnectionRef } | undefined;
      const ref = parsed?.connection;
      if (
        !parsed ||
        Object.keys(parsed).length !== 1 ||
        !ref ||
        typeof ref.vendor !== "string" ||
        typeof ref.$connection !== "string" ||
        Object.keys(ref).some((k) => k !== "vendor" && k !== "$connection")
      ) {
        fail(options, 'Write { connection: { vendor: "vendor", $connection: "vendor/name" } } with literal values');
        return;
      }
      connection = ref;
    }
    const desired = value(arg);
    if (desired !== undefined) {
      exports.push({
        name,
        vendor,
        type,
        desired: desired as DataFileExport["desired"],
        ...(connection && { connection }),
        start: s.start,
        end: s.end,
      });
    }
  }

  /** An `export const` in resources/data.ts: a collection, its declaration plain values `collection()` takes. */
  function readCollection(s: Node, init: Node | undefined, name: string) {
    if (
      init?.type !== "CallExpression" ||
      init.callee.type !== "Identifier" ||
      !collectionCalls.has(init.callee.name)
    ) {
      fail(init ?? s, `export const ${name} must be a collection: ${COLLECTIONS_ONLY}`);
      return;
    }
    const [arg] = init.arguments;
    if (init.arguments.length !== 1 || arg.type !== "ObjectExpression") {
      fail(init, `collection() takes one object literal: ${COLLECTION_CALL}`);
      return;
    }
    const declaration = value(arg) as { [field: string]: DataValue } | undefined;
    if (declaration === undefined) {
      // What value() refused it reported; the collection is still declared here, which the
      // runtime runs, when its name is written out.
      const named = arg.properties.find(
        (p: Node) => p.type === "Property" && !p.computed && keyName(p.key) === "name",
      )?.value;
      if (named?.type === "Literal" && typeof named.value === "string") {
        collections.push({ export: name, name: named.value, start: s.start, end: s.end });
      }
      return;
    }
    if (Object.keys(declaration).some((k) => !DECLARATION_KEYS.has(k)) || namesDeclaration(declaration)) {
      fail(arg, `collection() takes \`{ name, key, fields, title? }\`, its values written out: ${COLLECTION_CALL}`);
      return;
    }
    try {
      checkCollection(declaration);
    } catch (err) {
      fail(arg, errorMessage(err));
      return;
    }
    collections.push({ export: name, name: declaration.name as string, start: s.start, end: s.end });
  }

  function readDefault(s: Node) {
    if (collectionsFile) {
      fail(s, `export default is not allowed in resources/data.ts: ${COLLECTIONS_ONLY}`);
      return;
    }
    const list = s.declaration;
    if (list.type !== "ArrayExpression") {
      fail(list, "export default must list this file's resources: `export default [a, b]`");
      return;
    }
    for (const el of list.elements) {
      if (el?.type !== "Identifier") {
        fail(el ?? list, "export default must list this file's resources by name: `export default [a, b]`");
      } else if (!declared.has(el.name)) {
        fail(el, `${el.name} is not declared in this file: export default lists this file's resources`);
      }
    }
  }

  /** The value an expression stands for, or undefined (with a problem) when the subset has none. */
  function value(node: Node): DataValue | undefined {
    switch (node.type) {
      case "Literal":
        if (node.regex) return refuse(node, "a regular expression is not allowed in a data file: write it as a string");
        if (node.bigint !== undefined && node.bigint !== null)
          return refuse(node, "a bigint is not allowed in a data file: write a number, or a string");
        return node.value as null | boolean | number | string;
      case "TemplateLiteral":
        if (node.expressions.length) {
          return refuse(node, "a template with `${…}` is not allowed in a data file: write the string out");
        }
        return node.quasis[0].value.cooked as string;
      case "UnaryExpression":
        if (node.operator === "-" && node.argument.type === "Literal" && typeof node.argument.value === "number") {
          return -node.argument.value;
        }
        return refuse(node, `\`${node.operator}\` is not allowed in a data file: write the value out`);
      case "ArrayExpression": {
        const items: DataValue[] = [];
        let ok = true;
        for (const el of node.elements) {
          const item =
            el === null
              ? refuse(node, "an empty array slot is not allowed in a data file: write null")
              : el.type === "SpreadElement"
                ? refuse(el, "a spread is not allowed in a data file: write the items out, so the reader sees each")
                : value(el);
          if (item === undefined) ok = false;
          else items.push(item);
        }
        return ok ? items : undefined;
      }
      case "ObjectExpression": {
        const fields = new Map<string, DataValue>();
        let ok = true;
        for (const p of node.properties) {
          const field = property(p);
          if (field && fields.has(field[0])) fail(p, `${field[0]} is given twice: give each field once`);
          if (!field || fields.has(field[0])) ok = false;
          else fields.set(...field);
        }
        // fromEntries makes each field an own property, even one named `__proto__`.
        return ok ? Object.fromEntries(fields) : undefined;
      }
      case "Identifier":
        return reference(node);
      case "MemberExpression": {
        let base = node;
        while (base.type === "MemberExpression") base = base.object;
        if (base.type === "Identifier" && base.name === "process") {
          return refuse(
            node,
            "process is not allowed in a data file: it is read without running, so it cannot read the environment; write the value out, and leave secrets to drivers",
          );
        }
        return refuse(
          node,
          "member access is not allowed in a data file: write the value out, or name the resource itself (`site`), not one of its fields",
        );
      }
      case "CallExpression":
        if (node.callee.type === "Identifier" && secrets.has(node.callee.name)) return readSecret(node);
        if (node.callee.type === "Identifier" && collectionCalls.has(node.callee.name)) {
          return refuse(node, `a collection is declared at the top of resources/data.ts: ${COLLECTION_CALL}`);
        }
        if (node.callee.type === "Identifier" && node.callee.name === "secret" && !bound.has("secret")) {
          return refuse(node, `import secret to name one: \`import { secret } from "sanoma/resources"\``);
        }
        return refuse(
          node,
          node.callee.type === "MemberExpression" &&
            node.callee.object.type === "Identifier" &&
            imports.some((i) => i.kind === "constructors" && i.local === node.callee.object.name)
            ? "a resource is declared at the top of a data file: give it its own `export const` and name it here"
            : "a call is not allowed in a data file: write the value out; the reader never runs code",
        );
      case "NewExpression":
        return refuse(node, "`new` is not allowed in a data file: write the value out (a date as an ISO 8601 string)");
      case "ArrowFunctionExpression":
      case "FunctionExpression":
        return refuse(
          node,
          "a function is not allowed in a data file: a field holds a value, and code belongs in a workflow",
        );
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSTypeAssertion":
      case "TSNonNullExpression":
        return refuse(
          node,
          "a type assertion is not allowed in a data file: leave it out; the constructor types the value",
        );
      default:
        return refuse(node, `${describe(node)} is not allowed in a data file: ${VALUES}`);
    }
  }

  function property(p: Node): [string, DataValue] | undefined {
    if (p.type === "SpreadElement") {
      return refuse(p, "a spread is not allowed in a data file: write the fields out, so the reader sees each");
    }
    if (p.kind !== "init" || p.method) {
      return refuse(p, "a method or accessor is not allowed in a data file: a field holds a value");
    }
    if (p.computed) return refuse(p.key, "a computed key is not allowed in a data file: write the field's name");
    const key = keyName(p.key);
    if (key === undefined) return refuse(p.key, "write the field's name, or a string");
    if (key === "$secret") return refuse(p.key, `name a secret with ${SECRET_CALL}`);
    const v = value(p.value);
    return v === undefined ? undefined : [key, v];
  }

  /** A `secret(…)` call's marker: literal arguments only. */
  function readSecret(node: Node): SecretRef | undefined {
    const [name, options, ...extra] = node.arguments;
    if (name?.type !== "Literal" || typeof name.value !== "string" || extra.length) {
      return refuse(node, `write the secret's name as a string: ${SECRET_CALL}`);
    }
    if (!SECRET_NAME.test(name.value))
      return refuse(name, `${JSON.stringify(name.value)} is not a secret's name: ${SECRET_CALL}`);
    if (options === undefined) return { $secret: name.value };
    const [generate, ...others] = options.type === "ObjectExpression" ? options.properties : [];
    if (
      others.length ||
      generate?.type !== "Property" ||
      generate.computed ||
      (generate.key.name ?? generate.key.value) !== "generate" ||
      generate.value.type !== "Literal" ||
      typeof generate.value.value !== "boolean"
    ) {
      return refuse(options, `a secret's options are \`{ generate: true }\` or none: ${SECRET_CALL}`);
    }
    return generate.value.value ? { $secret: name.value, generate: true } : { $secret: name.value };
  }

  function reference(node: Node): Reference | undefined {
    const name: string = node.name;
    if (name === "undefined")
      return refuse(node, "undefined is not allowed in a data file: leave the field out, or write null");
    const imported = imports.find((i) => i.local === name);
    if (imported?.kind === "constructors") {
      return refuse(node, `${name} is a connector's resource constructors, not a resource: name a declared resource`);
    }
    if (imported || declared.has(name)) return new Reference(name);
    if (refused.has(name)) return undefined;
    return refuse(
      node,
      `${name} is not a resource this file declares or imports from a data file: write the value out, or import the resource`,
    );
  }

  function refuse(node: { start: number; end: number }, message: string): undefined {
    fail(node, message);
    return undefined;
  }

  return { imports, exports, collections, declared: collectionsFile ? [] : [...declared], problems };
}

/** What `collection()` reads of its declaration. */
const DECLARATION_KEYS: ReadonlySet<string> = new Set(["name", "key", "fields", "title"]);

/** True when a value names a declaration: a collection's declaration is plain values only. */
const namesDeclaration = (v: DataValue): boolean =>
  v instanceof Reference || (typeof v === "object" && v !== null && Object.values(v).some(namesDeclaration));

/** A property's name: an identifier's, or a literal's as a string; undefined for any other key. */
export const keyName = (key: Node): string | undefined =>
  key.type === "Identifier" ? key.name : key.type === "Literal" ? String(key.value) : undefined;

/** A node's kind, for a message: `a function declaration`, `an if statement`. */
function describe(node: Node): string {
  const words = String(node.type)
    .replace(/^TS/, "TypeScript ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return `${/^[aeiou]/.test(words) ? "an" : "a"} ${words}`;
}
