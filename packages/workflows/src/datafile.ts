import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Node } from "./ast.ts";

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
  readonly start: number;
  readonly end: number;
  constructor(name: string, start: number, end: number) {
    this.name = name;
    this.start = start;
    this.end = end;
  }
}

/** A value in a data file: a literal, or a reference to a declared resource. */
export type DataValue = null | boolean | number | string | Reference | DataValue[] | { [field: string]: DataValue };

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
  end: number;
}

/** An `export const name = vendor.type({ … })`. */
export interface DataFileExport {
  name: string;
  /** The local name of the constructors it calls (`github`). */
  vendor: string;
  type: string;
  desired: { [field: string]: DataValue };
  /** The `export const` statement. */
  start: number;
  end: number;
}

export interface DataFile {
  imports: DataFileImport[];
  /** Each `export const` whose value is in the subset. */
  exports: DataFileExport[];
  /** Every name an `export const` declares, its value in the subset or not. */
  declared: string[];
  problems: DataFileProblem[];
}

const RELATIVE = /^\.\.?\//;
/** A connector's constructors entry: a package specifier that ends in `/resources`. */
const CONSTRUCTORS = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*\/resources$/;

const SHAPE =
  "a data file holds only imports, `export const <name> = <vendor>.<type>({ … })` and `export default [ … ]`";
const IMPORTS =
  "import resource constructors from a connector's resources entry " +
  '(`import { github } from "@sanoma/connector-github/resources"`) ' +
  'and resources from other data files (`import { site } from "./github.ts"`)';
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
 *
 * `root` is the directory relative imports must stay in: by default the nearest `resources/`
 * directory above `filename`, else the file's own; without either, they are not checked.
 */
export function readDataFile(
  program: Node,
  filename?: string,
  root: string | undefined = filename === undefined ? undefined : resourcesRoot(filename),
): DataFile {
  const problems: DataFileProblem[] = [];
  const fail = (node: { start: number; end: number }, message: string) =>
    problems.push({ start: node.start, end: node.end, message });
  const imports: DataFileImport[] = [];
  const exports: DataFileExport[] = [];
  // Names a refused import or declaration binds: reported once, where they are bound.
  const refused = new Set<string>();

  // Top-level names first: a reference may name a resource declared further down. An unexported
  // const is refused where it is declared, not again where it is used.
  const declared = new Set<string>();
  for (const s of program.body) {
    const decl = s.type === "ExportNamedDeclaration" ? s.declaration : s;
    if (decl?.type !== "VariableDeclaration") continue;
    for (const d of decl.declarations) {
      if (d.id.type === "Identifier") (decl === s ? refused : declared).add(d.id.name);
    }
  }

  for (const s of program.body) {
    switch (s.type) {
      case "ImportDeclaration":
        readImport(s);
        break;
      case "ExportNamedDeclaration":
        readExport(s);
        break;
      case "ExportDefaultDeclaration":
        readDefault(s);
        break;
      case "ExportAllDeclaration":
        fail(s, `export * is not allowed in a data file: ${SHAPE}`);
        break;
      case "VariableDeclaration": {
        const name = s.declarations[0]?.id?.name;
        fail(
          s,
          name === undefined
            ? `an unexported declaration is not allowed in a data file: ${SHAPE}`
            : `\`${s.kind} ${name}\` is not allowed in a data file: export it as a resource, \`export const ${name} = <vendor>.<type>({ … })\`, or write its value where it is used`,
        );
        break;
      }
      default:
        fail(s, `${describe(s)} is not allowed in a data file: ${SHAPE}`);
    }
  }

  function readImport(s: Node) {
    const spec: string = s.source.value;
    if (s.importKind === "type") {
      fail(s, "`import type` is not allowed in a data file: it holds values only, and the constructors type them");
      return;
    }
    const kind = RELATIVE.test(spec) ? "file" : CONSTRUCTORS.test(spec) ? "constructors" : undefined;
    const refusal =
      kind === undefined
        ? IMPORTS
        : kind === "file" && !spec.endsWith(".ts")
          ? "name the data file with its `.ts` extension"
          : kind === "file" && root !== undefined && !inside(root, join(dirname(filename!), spec))
            ? `it reaches outside ${basename(root)}/; import only other data files`
            : undefined;
    if (refusal) {
      fail(s.source, `import "${spec}" is not allowed in a data file: ${refusal}`);
      for (const sp of s.specifiers) refused.add(sp.local.name);
      return;
    }
    if (!s.specifiers.length) {
      fail(s, `import "${spec}" is not allowed in a data file: it imports nothing, and a data file runs no code`);
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
      imports.push({ kind: kind!, source: spec, imported, local: sp.local.name, start: sp.start, end: sp.end });
    }
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
      fail(s, `${describe(decl)} is not allowed in a data file: ${SHAPE}`);
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
    const init = d.init;
    const callee = init?.type === "CallExpression" ? init.callee : undefined;
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
    const bound = imports.find((i) => i.local === vendor);
    if (refused.has(vendor)) return;
    if (bound?.kind !== "constructors") {
      fail(
        callee.object,
        `${vendor} is not a connector's resource constructors: import it from the connector's resources entry, \`import { ${vendor} } from "@sanoma/connector-${vendor}/resources"\``,
      );
      return;
    }
    const [arg] = init.arguments;
    if (init.arguments.length !== 1 || arg.type !== "ObjectExpression") {
      fail(init, `${vendor}.${type} takes one object literal: \`${vendor}.${type}({ … })\``);
      return;
    }
    const desired = value(arg);
    if (desired !== undefined) {
      exports.push({ name, vendor, type, desired: desired as DataFileExport["desired"], start: s.start, end: s.end });
    }
  }

  function readDefault(s: Node) {
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
        const fields: [string, DataValue][] = [];
        const seen = new Set<string>();
        let ok = true;
        for (const p of node.properties) {
          const field = property(p);
          if (field && seen.has(field[0])) fail(p, `${field[0]} is given twice: give each field once`);
          if (!field || seen.has(field[0])) {
            ok = false;
            continue;
          }
          seen.add(field[0]);
          fields.push(field);
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
    const key = p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" ? String(p.key.value) : undefined;
    if (key === undefined) return refuse(p.key, "write the field's name, or a string");
    const v = value(p.value);
    return v === undefined ? undefined : [key, v];
  }

  function reference(node: Node): Reference | undefined {
    const name: string = node.name;
    if (name === "undefined")
      return refuse(node, "undefined is not allowed in a data file: leave the field out, or write null");
    const imported = imports.find((i) => i.local === name);
    if (imported?.kind === "constructors") {
      return refuse(node, `${name} is a connector's resource constructors, not a resource: name a declared resource`);
    }
    if (imported || declared.has(name)) return new Reference(name, node.start, node.end);
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

  return { imports, exports, declared: [...declared], problems };
}

/** A node's kind, for a message: `a function declaration`, `an if statement`. */
function describe(node: Node): string {
  const words = String(node.type)
    .replace(/^TS/, "TypeScript ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return `${/^[aeiou]/.test(words) ? "an" : "a"} ${words}`;
}

/** The file's nearest `resources/` ancestor directory, else its own directory. */
export function resourcesRoot(filename: string): string {
  for (let dir = dirname(filename); ; dir = dirname(dir)) {
    if (basename(dir) === "resources") return dir;
    if (dirname(dir) === dir) return dirname(filename);
  }
}

/** True when `path` is `dir` or inside it. */
export function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
}
