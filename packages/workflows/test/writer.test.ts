import { readFileSync } from "node:fs";
import { github as githubConnector } from "@sanoma-ai/connector-github";
import { describe, expect, it } from "vitest";
import { loadDataFiles } from "../src/resources.ts";
import { secret } from "../src/secret.ts";
import {
  type DataFileContent,
  type DataValue,
  formatOptions,
  NotLiteral,
  Reference,
  renderDataFile,
  setFields,
} from "../src/writer.ts";
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
  });

  it("keeps the bytes around the declaration, even where the file is not formatted, and counts offsets in UTF-16", async () => {
    const text =
      'import {github} from "@sanoma-ai/connector-github/resources"\n// é 🙂 not formatted\nexport const a = github.repository({ owner: "acme", name: "a",   has_wiki: false })  // after\nexport const   b = github.repository({name: "b"})\n';
    const out = await setFields(text, "a", { has_wiki: true }, options);
    expect(out).toBe(
      'import {github} from "@sanoma-ai/connector-github/resources"\n// é 🙂 not formatted\nexport const a = github.repository({ owner: "acme", name: "a", has_wiki: true });  // after\nexport const   b = github.repository({name: "b"})\n',
    );
  });

  it("refuses a resource the file does not declare, a reference, and a path through a value", async () => {
    const company = readFileSync(new URL("./fixtures/company/resources/identity/github.ts", import.meta.url), "utf8");
    await expect(setFields(company, "nope", { name: "x" })).rejects.toThrow("declares no resource nope");
    await expect(setFields(company, "websiteMain", { repository_id: "R_1" })).rejects.toThrow(
      new NotLiteral("the value of repository_id is computed in the file", "repository_id"),
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
    await expect(setFields(named, "b", { teams: ["T_1", "T_2"] })).rejects.toThrow(
      "the value of teams is computed in the file",
    );
    await expect(setFields(named, "b", { by: null })).rejects.toThrow("the value of by is computed in the file");
    // A list made under a field the file lacks.
    await expect(setFields(company, "docs", { "rules.0.x": true })).rejects.toThrow(
      "Cannot set rules.0.x: the file has no list to hold item 0",
    );
  });

  it("writes the object a default export or a definition takes: a site, a collection in data.ts", async () => {
    const site =
      'import { defineSite } from "sanoma/site";\n\nexport default defineSite({ title: "Shop", public: true });\n';
    expect(await setFields(site, "default", { title: "Acme Shop", icon: "store" })).toBe(
      'import { defineSite } from "sanoma/site";\n\nexport default defineSite({ title: "Acme Shop", public: true, icon: "store" });\n',
    );
    const app = 'export default { source: "https://github.com/acme/crm" };\n';
    expect(await setFields(app, "default", { source: "https://github.com/acme/crm2" })).toBe(
      'export default { source: "https://github.com/acme/crm2" };\n',
    );
    const data = readFileSync(new URL("./fixtures/outbound/resources/data.ts", import.meta.url), "utf8");
    const titled = await setFields(data, "outbound", { title: "Prospects", "fields.seats.optional": false }, options);
    expect(titled).toBe(
      replacedOnce(
        replacedOnce(data, 'title: "Outbound"', 'title: "Prospects"'),
        'seats: { type: "number", optional: true }',
        'seats: { type: "number", optional: false }',
      ),
    );
  });

  it("refuses what the file computes, saying why: a name, a call, a spread, a value that is no object literal", async () => {
    const text = `import { s } from "a/resources";
const base = { tier: "pro" };
const NAME = "x";
export const named = s.t({ name: NAME, tags: ["a", ...more()], meta: { ...base, owner: "ops" }, at: \`\${NAME}.test\` });
export const spread = s.t({ ...base, name: "y" });
export const made = s.t(make());
export const plain = NAME;
export default [named, spread];
`;
    const refused = async (exportName: string, fields: Record<string, DataValue>) =>
      (await setFields(text, exportName, fields).catch((err: unknown) => err)) as NotLiteral;
    for (const [exportName, fields, reason] of [
      ["named", { name: "y" }, "the value of name is computed in the file"],
      ["named", { "tags.0": "b" }, "the value of tags is computed in the file"],
      ["named", { tags: ["b"] }, "the value of tags is computed in the file"],
      ["named", { "meta.owner": "x" }, "the value of meta is computed in the file"],
      ["named", { at: "y.test" }, "the value of at is computed in the file"],
      ["spread", { name: "z" }, "the value of name is computed in the file"],
      ["spread", { tier: "free" }, "the value of tier is computed in the file"],
      ["made", { name: "z" }, "made is not an object literal: edit it in code"],
      ["plain", { name: "z" }, "plain is not an object literal: edit it in code"],
      ["default", { name: "z" }, "default is not an object literal: edit it in code"],
    ] satisfies [string, Record<string, DataValue>, string][]) {
      const err = await refused(exportName, fields);
      expect(err, `${exportName} ${JSON.stringify(fields)}`).toBeInstanceOf(NotLiteral);
      expect(err.reason).toBe(reason);
      // The field, for the form that asked to lock it; none when the declaration is not a literal.
      expect(err.field).toBe(/^the value of (\S+) is computed/.exec(reason)?.[1]);
    }
    // A literal beside them is written, and a secret's call is a literal.
    expect(await setFields(text, "named", { "meta2.x": 1 })).toContain("meta2: { x: 1 }");
    const withSecret = 'import { s } from "a/resources";\nexport const x = s.t({ token: secret("A_TOKEN") });\n';
    expect(await setFields(withSecret, "x", { token: secret("B_TOKEN") })).toContain('token: secret("B_TOKEN")');
  });

  it("reads a key that holds a dot as one field, the longest that the object has", async () => {
    const text =
      'import { s } from "a/resources";\nexport const x = s.t({ metadata: { "app.owner": "a", app: { tier: 1 } } });\n';
    expect(await setFields(text, "x", { "metadata.app.owner": "b", "metadata.app.tier": 2 })).toBe(
      'import { s } from "a/resources";\nexport const x = s.t({ metadata: { "app.owner": "b", app: { tier: 2 } } });\n',
    );
  });

  it("writes a secret as secret(), importing it after the file's imports once", async () => {
    const text = 'import { s } from "a/resources";\nexport const x = s.t({ name: "x" });\n';
    const out = await setFields(text, "x", { password: secret("X_PASSWORD") });
    expect(out).toBe(
      'import { s } from "a/resources";\nimport { secret } from "sanoma/resources";\nexport const x = s.t({ name: "x", password: secret("X_PASSWORD") });\n',
    );
    const again = await setFields(out, "x", { token: secret("X_TOKEN", { generate: true }) });
    expect(again.split('import { secret } from "sanoma/resources";')).toHaveLength(2);
    expect(again).toContain('token: secret("X_TOKEN", { generate: true }),');
  });
});

describe("renderDataFile", () => {
  it("renders a file that loads back as given, formatted", async () => {
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
  });

  it("writes a secret as secret(), importing it from sanoma/resources", async () => {
    const content: DataFileContent = {
      imports: [{ source: "@sanoma-ai/connector-supabase/resources", imported: "supabase", local: "supabase" }],
      exports: [
        {
          name: "db",
          vendor: "supabase",
          type: "project",
          desired: {
            name: "acme",
            database_password: secret("SUPABASE_DB_PASSWORD", { generate: true }),
            hooks: [{ token: secret("HOOK_TOKEN") }],
          },
        },
      ],
    };
    const text = await renderDataFile(content, options);
    expect(text).toBe(`import { supabase } from "@sanoma-ai/connector-supabase/resources";
import { secret } from "sanoma/resources";

export const db = supabase.project({
  name: "acme",
  database_password: secret("SUPABASE_DB_PASSWORD", { generate: true }),
  hooks: [{ token: secret("HOOK_TOKEN") }],
});

export default [db];
`);
    // Rendered again, the secret import given: the import once.
    const again = {
      ...content,
      imports: [...content.imports, { source: "sanoma/resources", imported: "secret", local: "secret" }],
    };
    expect(await renderDataFile(again, options)).toBe(text);
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

  it("renders sanoma-ops' GitHub file from what loading it declares, as it is", async () => {
    // Its Stripe file, from before Stripe's ids were the vendor's to set, no longer loads.
    const root = tree("sanoma-ops", { "resources/github.ts": github });
    const { resources, problems } = loadDataFiles(root, [githubConnector]);
    expect(problems).toEqual([]);
    const content: DataFileContent = {
      imports: [{ source: "@sanoma-ai/connector-github/resources", imported: "github", local: "github" }],
      exports: resources.map((r) => ({
        name: r.at.export,
        vendor: r.vendor,
        type: r.type,
        desired: r.desired as Record<string, DataValue>,
      })),
    };
    // Its comments aside: loading keeps no comments.
    const withoutComments = github.replaceAll(/^\/\/.*\n(?:\/\/.*\n)*\n/gm, "");
    expect(await renderDataFile(content, options)).toBe(withoutComments);
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
