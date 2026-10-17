import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "../src/ast.ts";
import { readDataFile, Reference } from "../src/datafile.ts";
import { type DataFileContent, formatOptions, renderDataFile, setFields } from "../src/writer.ts";
import { tree } from "./tree.ts";

// The repository's own oxfmt options, which the fixtures are formatted with.
const options = formatOptions(new URL("../../..", import.meta.url).pathname);
const fixture = (name: string) => readFileSync(new URL(`./fixtures/sanoma-ops/${name}`, import.meta.url), "utf8");
// sanoma-ops' data files at 95da814, copied as they are.
const github = fixture("github.ts");
const stripe = fixture("stripe.ts");

/** `text` with the one occurrence of `from` replaced: the expected file, byte for byte. */
function replacedOnce(text: string, from: string, to: string): string {
  expect(text.split(from)).toHaveLength(2);
  return text.replace(from, to);
}

const read = (text: string) => readDataFile(parse("/resources/x.ts", text).program, "/resources/x.ts");

describe("setFields", () => {
  it("changes only the field it sets, in sanoma-ops' files", async () => {
    // The second of two declarations alike: the first keeps its value.
    const out = await setFields(github, "sanoma", { has_wiki: true }, options);
    const at = github.indexOf("export const sanoma");
    expect(out).toBe(github.slice(0, at) + replacedOnce(github.slice(at), "has_wiki: false", "has_wiki: true"));

    const described = await setFields(stripe, "driftTestProduct", { description: "Read by the tests." }, options);
    expect(described).toBe(
      replacedOnce(
        stripe,
        'description: "A test-mode product Sanoma reads in its tests."',
        'description: "Read by the tests."',
      ),
    );
  });

  it("sets a list item, a field of an object, and a whole list, in one write", async () => {
    const out = await setFields(stripe, "driftTestProduct", { "metadata.owner": "ops", active: false }, options);
    expect(out).toBe(
      replacedOnce(
        replacedOnce(stripe, 'metadata: { owner: "sanoma" }', 'metadata: { owner: "ops" }'),
        "active: true",
        "active: false",
      ),
    );
    const events = await setFields(stripe, "driftTestWebhook", { "enabled_events.0": "product.created" }, options);
    expect(events).toBe(replacedOnce(stripe, '["product.updated"]', '["product.created"]'));
    const both = await setFields(
      stripe,
      "driftTestWebhook",
      { enabled_events: ["product.updated", "product.deleted"] },
      options,
    );
    expect(both).toBe(replacedOnce(stripe, '["product.updated"]', '["product.updated", "product.deleted"]'));
  });

  it("formats the value as the file is formatted: a long one wraps", async () => {
    const description = "A".repeat(130);
    const out = await setFields(github, "providerBridge", { description }, options);
    const before = github.match(/description:\n {4}"Go sidecar[^\n]*",/)![0];
    expect(out).toBe(replacedOnce(github, before, `description:\n    "${description}",`));
  });

  it("adds a field the declaration does not have, at the end of the object that holds it", async () => {
    const out = await setFields(stripe, "driftTestProduct", { "metadata.tier": "pro", url: "https://x.test" }, options);
    expect(out).toBe(
      replacedOnce(
        replacedOnce(stripe, 'metadata: { owner: "sanoma" }', 'metadata: { owner: "sanoma", tier: "pro" }'),
        'metadata: { owner: "sanoma", tier: "pro" },\n});',
        'metadata: { owner: "sanoma", tier: "pro" },\n  url: "https://x.test",\n});',
      ),
    );
    const nested = await setFields('import { s } from "a/resources";\nexport const x = s.t({});\n', "x", {
      "a.b-c": [1, null],
    });
    expect(nested).toBe('import { s } from "a/resources";\nexport const x = s.t({ a: { "b-c": [1, null] } });\n');
    expect(read(nested).exports[0]!.desired).toEqual({ a: { "b-c": [1, null] } });
  });

  it("keeps the bytes around the declaration, even where the file is not formatted, and counts offsets in UTF-16", async () => {
    const text =
      'import {github} from "@sanoma-ai/connector-github/resources"\n// é 🙂 not formatted\nexport const a = github.repository({ name: "a",   has_wiki: false })  // after\nexport const   b = github.repository({name: "b"})\n';
    const out = await setFields(text, "a", { has_wiki: true }, options);
    expect(out).toBe(
      'import {github} from "@sanoma-ai/connector-github/resources"\n// é 🙂 not formatted\nexport const a = github.repository({ name: "a", has_wiki: true });  // after\nexport const   b = github.repository({name: "b"})\n',
    );
  });

  it("refuses a resource the file does not declare, a reference, and a path through a value", async () => {
    const company = readFileSync(new URL("./fixtures/company/resources/identity/github.ts", import.meta.url), "utf8");
    await expect(setFields(company, "nope", { name: "x" })).rejects.toThrow("declares no resource nope");
    await expect(setFields(company, "websiteMain", { repository_id: "R_1" })).rejects.toThrow(
      "it names the resource website",
    );
    await expect(setFields(company, "website", { "name.first": "x" })).rejects.toThrow(
      "Cannot set name.first: name is not an object or a list with item first",
    );
    await expect(setFields(company, "website", { "topics.5": "x" })).rejects.toThrow("with item 5");
    await expect(setFields(company, "website", { name: Number.NaN })).rejects.toThrow("write a finite number");
    await expect(setFields("export const = ;", "x", {})).rejects.toThrow("does not parse");
    // A reference anywhere in what would be replaced: a list holding one, or an object.
    await expect(setFields(company, "websiteMain", { required_pull_request_reviews: null })).resolves.toContain(
      "required_pull_request_reviews: null,",
    );
    const named =
      'import { s } from "a/resources";\nexport const a = s.t({});\nexport const b = s.t({ teams: [a], by: { x: a } });\n';
    await expect(setFields(named, "b", { teams: ["T_1", "T_2"] })).rejects.toThrow("it names the resource a");
    await expect(setFields(named, "b", { by: null })).rejects.toThrow("it names the resource a");
    // A list made under a field the file lacks.
    await expect(setFields(company, "docs", { "rules.0.x": true })).rejects.toThrow(
      "Cannot set rules.0.x: the file has no list to hold item 0",
    );
  });

  it("reads a key that holds a dot as one field, the longest that the object has", async () => {
    const text =
      'import { s } from "a/resources";\nexport const x = s.t({ metadata: { "app.owner": "a", app: { tier: 1 } } });\n';
    expect(await setFields(text, "x", { "metadata.app.owner": "b", "metadata.app.tier": 2 })).toBe(
      'import { s } from "a/resources";\nexport const x = s.t({ metadata: { "app.owner": "b", app: { tier: 2 } } });\n',
    );
  });
});

describe("renderDataFile", () => {
  it("renders a file readDataFile reads back as given, formatted", async () => {
    const content: DataFileContent = {
      imports: [
        { source: "@sanoma-ai/connector-github/resources", imported: "github", local: "github" },
        { source: "./other.ts", imported: "site", local: "other" },
      ],
      exports: [
        {
          name: "repo",
          vendor: "github",
          type: "repository",
          desired: { name: "acme-ops", visibility: "private", topics: ["ops"], "x-y": { z: null } },
        },
        {
          name: "rule",
          vendor: "github",
          type: "branch_protection",
          desired: { repository_id: new Reference("repo") },
        },
        { name: "empty", vendor: "github", type: "repository", desired: {} },
      ],
    };
    const text = await renderDataFile(content, options);
    expect(text).toBe(`import { github } from "@sanoma-ai/connector-github/resources";
import { site as other } from "./other.ts";

export const repo = github.repository({
  name: "acme-ops",
  visibility: "private",
  topics: ["ops"],
  "x-y": { z: null },
});

export const rule = github.branch_protection({
  repository_id: repo,
});

export const empty = github.repository({});

export default [repo, rule, empty];
`);
    const back = read(text);
    expect(back.problems).toEqual([]);
    expect(back.imports.map(({ source, imported, local }) => ({ source, imported, local }))).toEqual(content.imports);
    expect(back.exports.map(({ name, vendor, type, desired }) => ({ name, vendor, type, desired }))).toEqual(
      content.exports,
    );
  });

  it("writes a reference made by another copy of the package", async () => {
    // What another copy's Reference is: its own class, with the registered symbol on its prototype.
    class Other {
      readonly name: string;
      constructor(name: string) {
        this.name = name;
      }
    }
    Object.defineProperty(Other.prototype, Symbol.for("sanoma.reference"), { value: true });
    const exports = [{ name: "rule", vendor: "s", type: "t", desired: { of: new Other("repo") as Reference } }];
    expect(await renderDataFile({ imports: [], exports })).toContain("of: repo,");
  });

  it("renders sanoma-ops' files from what readDataFile reads, as they are", async () => {
    // Their comments aside: the reader keeps no comments.
    for (const text of [github, stripe]) {
      const rendered = await renderDataFile(read(text), options);
      const withoutComments = text.replaceAll(/^\/\/.*\n(?:\/\/.*\n)*\n/gm, "");
      expect(rendered).toBe(withoutComments);
    }
  });
});

describe("formatOptions", () => {
  it("reads .oxfmtrc.json less what only the CLI uses, and none without it", () => {
    const root = tree("oxfmtrc", {
      ".oxfmtrc.json": JSON.stringify({ $schema: "x", printWidth: 80, ignorePatterns: ["a"], overrides: [] }),
    });
    expect(formatOptions(root)).toEqual({ printWidth: 80 });
    expect(formatOptions(tree("none"))).toEqual({});
  });
});
