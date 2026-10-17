import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FormatConfig } from "oxfmt";
import { type Node, parse } from "./ast.ts";
import {
  type DataFileExport,
  type DataFileImport,
  type DataValue,
  isReference,
  keyName,
  readDataFile,
  SECRET_ENTRIES,
} from "./datafile.ts";
import { isSecret } from "./secret.ts";

// The data-file writer: what the app's Adopt, and setting up a company, write into the files
// `datafile.ts` reads. A file is changed in place, one declaration at a time, and everything
// outside that declaration is kept byte for byte; what is written is formatted with oxfmt, under
// the repository's own options, so it reads as if a person had written it and formatted it.

/** A whole data file to render: its imports and its resources, in order. */
export interface DataFileContent {
  imports: readonly Pick<DataFileImport, "source" | "imported" | "local">[];
  exports: readonly Pick<DataFileExport, "name" | "vendor" | "type" | "desired">[];
}

/**
 * oxfmt's options from `<root>/.oxfmtrc.json`, what `oxfmt` itself reads there, less what only
 * its CLI uses (`ignorePatterns`, `overrides`); none, oxfmt's defaults, without the file.
 */
export function formatOptions(root: string): FormatConfig {
  let text: string;
  try {
    text = readFileSync(join(root, ".oxfmtrc.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const { $schema: _, ignorePatterns: __, overrides: ___, ...options } = JSON.parse(text) as Record<string, unknown>;
  return options as FormatConfig;
}

/**
 * `source`, a data file's text, with fields of its resource `exportName` set to new values:
 * `fields` by dotted path, a list item's with its index, as a drift report names them
 * (`required_pull_request_reviews.0.dismiss_stale_reviews`). A field the declaration does not
 * have is added at the end of the object that should hold it. Only that `export const` changes:
 * it is formatted with oxfmt under `options` (`formatOptions`), and every other byte of the file
 * stays as it was.
 *
 * A value naming a secret adds `import { secret } from "sanoma/resources"` after the file's
 * imports when it has none.
 *
 * Throws when the file does not parse, declares no such resource, or a path cannot be set: it
 * runs through a value that is not an object or a list, or ends at a reference to another
 * resource (a person changes a reference; a vendor's value never replaces one).
 */
export async function setFields(
  source: string,
  exportName: string,
  fields: Readonly<Record<string, DataValue>>,
  options: FormatConfig = {},
): Promise<string> {
  let text = source;
  // One field at a time, each against the file as the last left it: no offset goes stale.
  for (const [path, value] of Object.entries(fields)) {
    const { start, end, replacement } = editAt(declarationOf(text, exportName).object, path, value);
    text = text.slice(0, start) + replacement + text.slice(end);
  }
  if (Object.values(fields).some(holdsSecret)) text = withSecretImport(text);
  // The declaration on its own: a top-level statement formats the same in its file as alone.
  const { start, end } = declarationOf(text, exportName).statement;
  const formatted = await format(text.slice(start, end), options);
  return text.slice(0, start) + formatted.trimEnd() + text.slice(end);
}

/** What a data file imports `secret` from when it names one (`readDataFile` lists no such import). */
const SECRET_IMPORT = { source: "sanoma/resources", imported: "secret", local: "secret" };

/**
 * A whole data file: the imports, one per source, then each resource as `export const`, then
 * `export default` naming them all, formatted with oxfmt under `options`. `readDataFile` reads it
 * back as it was given: what `readDataFile` returns renders the file again. A file whose values
 * name a secret also imports `secret` from "sanoma/resources".
 */
export async function renderDataFile({ imports, exports }: DataFileContent, options: FormatConfig = {}) {
  const names = new Map<string, string[]>();
  const hasSecret = imports.some((i) => i.local === SECRET_IMPORT.local);
  const all = !hasSecret && exports.some((e) => holdsSecret(e.desired)) ? [...imports, SECRET_IMPORT] : imports;
  for (const { source, imported, local } of all) {
    const list = names.get(source) ?? [];
    list.push(imported === local ? local : `${imported} as ${local}`);
    names.set(source, list);
  }
  const parts = [
    [...names].map(([source, list]) => `import { ${list.join(", ")} } from ${JSON.stringify(source)};`).join("\n"),
    // The top-level object on lines of its own, so oxfmt keeps it expanded as people write it.
    ...exports.map(({ name, vendor, type, desired }) => {
      const body = Object.entries(desired).map(([key, value]) => `${keyOf(key)}: ${literal(value)},\n`);
      return `export const ${name} = ${vendor}.${type}({${body.length ? `\n${body.join("")}` : ""}});`;
    }),
    `export default [${exports.map((e) => e.name).join(", ")}];`,
  ];
  return format(`${parts.filter(Boolean).join("\n\n")}\n`, options);
}

/** `text` with `secret` imported after its imports, unless it imports it already. */
function withSecretImport(text: string): string {
  const imports = parse("/data-file.ts", text).program.body.filter((s: Node) => s.type === "ImportDeclaration");
  const has = imports.some(
    (s: Node) =>
      SECRET_ENTRIES.has(s.source.value) &&
      s.specifiers.some((sp: Node) => (sp.imported?.name ?? sp.imported?.value) === "secret"),
  );
  if (has) return text;
  const at = imports.at(-1)?.end ?? 0;
  const line = `import { ${SECRET_IMPORT.local} } from ${JSON.stringify(SECRET_IMPORT.source)};`;
  return at ? `${text.slice(0, at)}\n${line}${text.slice(at)}` : `${line}\n${text}`;
}

/** The `export const` of the resource `name` in `text`, and the object literal its constructor takes. */
function declarationOf(text: string, name: string): { statement: Node; object: Node } {
  // The name is never resolved, and a relative import is checked against the file's own directory.
  const filename = "/data-file.ts";
  const { program, errors } = parse(filename, text);
  if (errors.length) throw new Error(`The data file does not parse: ${errors[0]!.message}`);
  const found = readDataFile(program, filename).exports.find((e) => e.name === name);
  if (!found) throw new Error(`The data file declares no resource ${name}`);
  const statement: Node = program.body.find((s) => s.start === found.start);
  return { statement, object: statement.declaration.declarations[0].init.arguments[0] };
}

/**
 * What setting `path` to `value` in `object` replaces, and with what. A key may hold a dot
 * (`metadata: { "app.owner": … }`), and a drift report's path does not say so: at each object,
 * the longest run of the path's segments that names a field is that field.
 */
function editAt(object: Node, path: string, value: DataValue): { start: number; end: number; replacement: string } {
  const keys = path.split(".");
  let node = object;
  for (let i = 0; i < keys.length;) {
    if (node.type === "ObjectExpression") {
      const names = new Map<string, Node>(node.properties.map((p: Node) => [fieldName(p), p]));
      let j = keys.length;
      while (j > i && !names.has(keys.slice(i, j).join("."))) j--;
      if (j === i) return added(node, keys.slice(i), path, value);
      node = names.get(keys.slice(i, j).join("."))!.value;
      i = j;
    } else if (node.type === "ArrayExpression" && /^\d+$/.test(keys[i]!) && node.elements[Number(keys[i])]) {
      node = node.elements[Number(keys[i])];
      i++;
    } else {
      const at = keys.slice(0, i).join(".");
      throw new Error(`Cannot set ${path}: ${at} is not an object or a list with item ${keys[i]}`);
    }
  }
  const named = referenceIn(node);
  if (named) {
    throw new Error(`Cannot set ${path}: it names the resource ${named}; change a reference in the file itself`);
  }
  return { start: node.start, end: node.end, replacement: literal(value) };
}

/** The first resource a value names, itself or anywhere inside it: a vendor's value never replaces one. */
function referenceIn(node: Node): string | undefined {
  if (node.type === "Identifier") return node.name;
  const items =
    node.type === "ArrayExpression" ? node.elements : node.type === "ObjectExpression" ? node.properties : [];
  for (const item of items) {
    const named = item && referenceIn(item.type === "Property" ? item.value : item);
    if (named) return named;
  }
  return undefined;
}

/**
 * The edit that adds `keys` (the first missing, then any under it) with `value` at the end of
 * `object`. Only objects are made under it: a list item's index there is refused.
 */
function added(object: Node, [key, ...under]: string[], path: string, value: DataValue) {
  const index = under.find((k) => /^\d+$/.test(k));
  if (index !== undefined) throw new Error(`Cannot set ${path}: the file has no list to hold item ${index}`);
  const nested = under.reduceRight<DataValue>((v, k) => Object.fromEntries([[k, v]]), value);
  const field = `${keyOf(key!)}: ${literal(nested)}`;
  const last = object.properties.at(-1);
  return last
    ? { start: last.end, end: last.end, replacement: `, ${field}` }
    : { start: object.start, end: object.end, replacement: `{ ${field} }` };
}

/** A property's name, as `readDataFile` reads it. */
const fieldName = (p: Node): string | undefined => (p.type === "Property" && !p.computed ? keyName(p.key) : undefined);

/** A field's name in source: bare when it can be, else a string. */
const keyOf = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key));

/** True when a value names a secret, itself or anywhere inside it. */
const holdsSecret = (value: DataValue): boolean =>
  isSecret(value) ||
  (typeof value === "object" && value !== null && !isReference(value) && Object.values(value).some(holdsSecret));

/** A value in the data-file subset, as source, on one line: oxfmt lays it out. */
function literal(value: DataValue): string {
  if (isReference(value)) return value.name;
  if (isSecret(value)) return `secret(${JSON.stringify(value.$secret)}${value.generate ? ", { generate: true }" : ""})`;
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${value} cannot be written in a data file: write a finite number`);
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const fields = Object.entries(value).map(([key, v]) => `${keyOf(key)}: ${literal(v)}`);
    return fields.length ? `{ ${fields.join(", ")} }` : "{}";
  }
  throw new Error(`${String(value)} cannot be written in a data file: ${typeof value} is not a data value`);
}

/** `text` formatted by oxfmt, loaded only when a file is written. */
async function format(text: string, options: FormatConfig): Promise<string> {
  const oxfmt = await import("oxfmt");
  const { code, errors } = await oxfmt.format("data-file.ts", text, options);
  if (errors.length) throw new Error(`oxfmt could not format the data file: ${errors[0]!.message}`);
  return code;
}
