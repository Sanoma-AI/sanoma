import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { sanoma } from "../src/constructors.ts";
import { admit, describeConfig, readPeople } from "../src/describe.ts";
import {
  approverOf,
  declaresPeople,
  defineWorkflow,
  personOf,
  principalOf,
  resolveConfig,
  type SanomaConfig,
  visitorPrincipal,
} from "../src/index.ts";
import { problemLine } from "../src/shared.ts";
import { failure, waitFor } from "./harness.ts";

// People, agents and groups: vendorless resource types of the runtime's own vendor, declared in
// data files like any resource; `principalOf` and `approverOf` read who they are, and the client
// refuses whoever is not declared. The client's part needs Postgres: `pnpm db:up`.

const ada = sanoma.person({ id: "ada", name: "Ada Ortiz", email: "ada@acme.test", github: "Ada-Ortiz" });
const bo = sanoma.person({ id: "bo" });
const refundBot = sanoma.agent({ id: "refund-bot", onBehalfOf: bo });
const finance = sanoma.group({ name: "finance", members: [ada, bo] });
const sales = sanoma.group({ name: "sales", members: [bo, refundBot] });
const people = [ada, bo, refundBot, finance, sales];

describe("the people types", () => {
  it("declare plain values, a group's members and an agent's person by reference", () => {
    expect(sales.desired).toEqual({ name: "sales", members: ["bo", "refund-bot"] });
    expect(refundBot.desired).toEqual({ id: "refund-bot", onBehalfOf: "bo" });
  });

  it.each([
    [() => sanoma.person({ id: "ada ortiz" }), 'is one word, such as "ada"'],
    [() => sanoma.person({ id: "ada", groups: ["admin"] } as never), "no field groups"],
    [() => sanoma.person({ id: "ada", github: "not a login" }), "is a GitHub login"],
    [() => sanoma.agent({ id: "bot", onBehalfOf: refundBot as never }), "names a resource of type sanoma.person"],
    [() => sanoma.group({ name: "finance", members: [finance as never] }), "sanoma.person or sanoma.agent"],
  ])("refuse what is not well formed: %#", (make, message) => {
    expect(make).toThrow(message);
  });

  it("have no operations, so no driver, and add no drift or apply to a config", () => {
    expect([sanoma.person, sanoma.agent, sanoma.group].map((type) => [type.vendorless, type.ops])).toEqual([
      [true, {}],
      [true, {}],
      [true, {}],
    ]);
    const resolved = resolveConfig({ workflows: [], connectors: [] });
    expect(resolved.types.size).toBe(0);
    // The vendor's only operations are a change's, built in.
    expect([...resolved.ops.keys()].filter((id) => id.startsWith("sanoma."))).toEqual([
      "sanoma.change.open",
      "sanoma.change.review",
      "sanoma.change.merge",
      "sanoma.change.close",
      "sanoma.connection.disconnect",
      "sanoma.connection.bind",
      "sanoma.connection.create",
      "sanoma.apps.list",
    ]);
    // No drift or apply: the change workflow, and call for the listing of apps, in every config.
    expect([...resolved.workflows.keys()]).toEqual(["change", "call"]);
  });
});

describe("principalOf", () => {
  it("is a declared person or agent with every group that lists them, an agent in agents too", () => {
    expect(principalOf("ada", people)).toEqual({ id: "ada", groups: ["finance"] });
    expect(principalOf("bo", people)).toEqual({ id: "bo", groups: ["finance", "sales"] });
    expect(principalOf("refund-bot", people)).toEqual({
      id: "refund-bot",
      groups: ["agents", "sales"],
      onBehalfOf: "bo",
    });
  });

  it("knows the runtime's own agents undeclared, and nobody else", () => {
    expect(principalOf("scenarios", people)).toEqual({ id: "scenarios", groups: ["agents"] });
    expect(principalOf("cy", people)).toBeUndefined();
    expect(principalOf("finance", people)).toBeUndefined();
  });
});

describe("approverOf", () => {
  it("is a group by its name, agents among them, else a person or agent by id", () => {
    expect(approverOf("finance", people)).toEqual({ group: "finance" });
    expect(approverOf("agents", people)).toEqual({ group: "agents" });
    expect(approverOf("ada", people)).toBe("ada");
    expect(approverOf("refund-bot", people)).toBe("refund-bot");
    expect(approverOf("cy", people)).toBeUndefined();
    // Visitors decide nothing.
    expect(approverOf("visitors", people)).toBeUndefined();
  });
});

describe("personOf", () => {
  it("matches a sign-in by email, then GitHub login, each ignoring case, then id; never an agent", () => {
    expect(personOf({ email: "ADA@acme.test", github: "bo" }, people)).toBe("ada");
    expect(personOf({ github: "ada-ortiz" }, people)).toBe("ada");
    expect(personOf({ id: "bo" }, people)).toBe("bo");
    expect(personOf({ id: "Bo" }, people)).toBeUndefined();
    expect(personOf({ id: "refund-bot" }, people)).toBeUndefined();
    expect(declaresPeople(people)).toBe(true);
    expect(declaresPeople([refundBot])).toBe(true);
    expect(declaresPeople([])).toBe(false);
  });
});

const PEOPLE = `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada", name: "Ada Ortiz", github: "Ada-Ortiz" });
export const bo = sanoma.person({ id: "bo" });
export const refundBot = sanoma.agent({ id: "refund-bot", onBehalfOf: bo });
export const finance = sanoma.group({ name: "finance", members: [ada, refundBot] });
`;

describe("people in a data file", () => {
  let root = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "sanoma-people-"));
    mkdirSync(join(root, "resources"));
    writeFileSync(join(root, "resources", "people.ts"), PEOPLE);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("are read as any data file's resources, and described with them", () => {
    const { people: declared, problems } = readPeople(root);
    expect(problems).toEqual([]);
    expect(declared.map(({ id, vendor, type, name }) => [id, `${vendor}.${type}`, name])).toEqual([
      ["resources/people.ts#ada", "sanoma.person", "ada"],
      ["resources/people.ts#bo", "sanoma.person", "bo"],
      ["resources/people.ts#refundBot", "sanoma.agent", "refund-bot"],
      ["resources/people.ts#finance", "sanoma.group", "finance"],
    ]);
    expect(principalOf("refund-bot", declared)).toEqual({
      id: "refund-bot",
      groups: ["agents", "finance"],
      onBehalfOf: "bo",
    });
    const description = describeConfig({ workflows: [], connectors: [], root });
    expect(description.problems).toEqual([]);
    expect(description.resources.map((r) => r.id)).toEqual(declared.map((r) => r.id));
    expect(description.resourceTypes.map((t) => t.id)).toEqual(["sanoma.agent", "sanoma.group", "sanoma.person"]);
  });

  it("are loaded from the files that import their constructors alone, by any name, beside a vendor's resources", () => {
    const mixed = mkdtempSync(join(tmpdir(), "sanoma-people-mixed-"));
    mkdirSync(join(mixed, "resources"));
    writeFileSync(
      join(mixed, "resources", "team.ts"),
      `import { sanoma as s } from "sanoma/resources";\nexport const ada = s.person({ id: "ada" });\n`,
    );
    // Neither a vendor's resources nor a broken file without the people's constructors is loaded.
    writeFileSync(
      join(mixed, "resources", "repos.ts"),
      `import { acme } from "@acme/sanoma-connector/resources";\nexport const repo = acme.repo({ name: "site" });\n`,
    );
    writeFileSync(join(mixed, "resources", "infra.ts"), `export const broken = nope({});\n`);
    // A wakeup beside its host's connector, which the people's load does not serve: left unread.
    writeFileSync(
      join(mixed, "resources", "hosting.ts"),
      `import { acme } from "@acme/sanoma-connector/resources";\nimport { sanoma } from "sanoma/resources";\nexport const host = acme.app({ name: "x" });\nexport const wakeup = sanoma.wakeup({ host });\n`,
    );
    try {
      const { people: read, problems } = readPeople(mixed);
      expect(problems).toEqual([]);
      expect(read.map((r) => r.name)).toEqual(["ada"]);
      // Loaded once while no file changes: the same answer.
      expect(readPeople(mixed)).toBe(readPeople(mixed));
    } finally {
      rmSync(mixed, { recursive: true, force: true });
    }
  });

  it("are none without a root", () => {
    expect(readPeople(undefined)).toEqual({ people: [], problems: [] });
  });

  it("report a broken people file, an id both a person and an agent, and a group named agents, as problems", () => {
    const broken = mkdtempSync(join(tmpdir(), "sanoma-people-broken-"));
    mkdirSync(join(broken, "resources"));
    writeFileSync(
      join(broken, "resources", "people.ts"),
      `import { sanoma } from "sanoma/resources";\nexport const ada = sanoma.person({ id: "ada" });\nexport const twin = sanoma.agent({ id: "ada" });\nexport const bots = sanoma.group({ name: "agents", members: [ada] });\n`,
    );
    // A value the type refuses stops its file, where it is thrown.
    writeFileSync(
      join(broken, "resources", "odd.ts"),
      `import { sanoma } from "sanoma/resources";\nexport const odd = sanoma.person({ id: "two words" });\n`,
    );
    try {
      const read = readPeople(broken);
      expect(read.problems.map(problemLine)).toEqual([
        expect.stringMatching(/^resources\/odd\.ts:2:27: sanoma\.person: .*one word/),
        expect.stringMatching(
          /^resources\/people\.ts#twin: resources\/people\.ts#twin has the id "ada", which resources\/people\.ts#ada has/,
        ),
        expect.stringMatching(/^resources\/people\.ts#bots: .*the group every agent is in/),
      ]);
      // Nobody is admitted while they stand, but the runtime's own agents, which no file declares.
      expect(() => admit({ id: "ada" }, read)).toThrow("cannot be admitted while the people's files have problems");
      expect(admit({ id: "scenarios" }, read)).toEqual({ id: "scenarios", groups: ["agents"] });
      expect(() => admit({ id: "scenarios" }, read, true)).toThrow("cannot be admitted");
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});

describe("visitors and anonymous", () => {
  const read = { people, problems: [] };
  const visitor = visitorPrincipal("auth0", "u1");

  it("are admitted by their id alone, with the groups stamped, whatever the files say, but never at a sign-in", () => {
    expect(admit({ id: visitor.id, groups: ["finance"] }, read)).toEqual({ id: visitor.id, groups: ["visitors"] });
    expect(admit({ id: "anonymous", groups: ["finance"] }, read)).toEqual({ id: "anonymous", groups: [] });
    expect(admit({ id: visitor.id }, { people, problems: [{ file: "resources/people.ts", message: "x" }] })).toEqual(
      visitor,
    );
    expect(() => admit({ id: visitor.id }, read, true)).toThrow("is not declared");
    expect(() => admit({ id: "anonymous" }, { people: [], problems: [] }, true)).toThrow("is not declared");
    // An id of another form is nobody's, and no visitor is made with one.
    expect(() => admit({ id: "visitor:auth0" }, read)).toThrow("is not declared");
    expect(() => visitorPrincipal("auth 0", "u1")).toThrow("is not a visitor's id");
    expect(() => visitorPrincipal("auth0", "two words")).toThrow("is not a visitor's id");
  });

  it("take names no data file may give a group, a person or an agent", () => {
    const root = mkdtempSync(join(tmpdir(), "sanoma-people-visitors-"));
    mkdirSync(join(root, "resources"));
    writeFileSync(
      join(root, "resources", "people.ts"),
      `import { sanoma } from "sanoma/resources";
export const anon = sanoma.person({ id: "anonymous" });
export const bot = sanoma.agent({ id: "visitor:auth0:bot" });
export const ada = sanoma.person({ id: "ada" });
export const visitors = sanoma.group({ name: "visitors", members: [ada] });
export const anyone = sanoma.group({ name: "anonymous", members: [ada] });
`,
    );
    try {
      expect(readPeople(root).problems.map((p) => p.message)).toEqual([
        expect.stringContaining(`"anonymous", a visitor's`),
        expect.stringContaining(`"visitor:auth0:bot", a visitor's`),
        expect.stringContaining("the group every visitor is in"),
        expect.stringContaining("who a public page runs as"),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the client, with people declared", () => {
  const databaseUrl = testDatabaseUrl("people");
  const root = mkdtempSync(join(tmpdir(), "sanoma-people-client-"));
  mkdirSync(join(root, "resources"));
  writeFileSync(join(root, "resources", "people.ts"), PEOPLE);
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  /** Waits for someone in finance to approve. */
  const held = defineWorkflow({
    name: "held",
    trigger: "manual",
    input: z.object({}),
    uses: ["approval"],
    run: async (ctx) => {
      await ctx.approval("Go ahead", { approver: { group: "finance" } });
      return "done";
    },
  });
  const config: SanomaConfig = { workflows: [held], connectors: [], root };
  const app = useTestApp(config, { databaseUrl });

  it("refuses to start, call, decide or set a credential as anyone not declared, and takes the id alone", async () => {
    expect(await failure(app.client.start(held, {}, { startedBy: "cy" }))).toMatchObject({
      code: "not_admitted",
      message: "cy is not declared in resources/people.ts",
    });
    expect(await failure(app.client.call("data.none.list", {}, { actor: { id: "cy" } }))).toMatchObject({
      code: "not_admitted",
    });
    for (const write of [
      app.client.setCredential("SHOP_KEY", "key", { by: "cy" }),
      app.client.setSecret("SHOP_KEY", "key", { by: "cy" }),
      app.client.clearCredential("SHOP_KEY", { by: "cy" }),
    ]) {
      expect(await failure(write)).toMatchObject({ code: "not_admitted" });
    }
    // Claiming finance does not put bo's run's approver in it: ada decides as declared.
    const runId = await app.client.start(held, {}, { startedBy: { id: "bo", groups: ["admin"] } });
    expect((await app.client.run(runId))?.startedBy).toEqual({ id: "bo" });
    await waitFor(async () => (await app.client.approvals(runId)).some((a) => a.status === "pending"));
    expect(await failure(app.client.decide(runId, { decision: "approve", by: { id: "cy" } }))).toMatchObject({
      code: "not_admitted",
    });
    expect(
      await failure(app.client.decide(runId, { decision: "approve", by: { id: "bo", groups: ["finance"] } })),
    ).toMatchObject({ code: "not_approver" });
    // A visitor neither decides it, nor sets a credential, nor starts a run no policy permits.
    const visitor = visitorPrincipal("auth0", "u1");
    expect(await failure(app.client.decide(runId, { decision: "approve", by: visitor }))).toMatchObject({
      code: "not_approver",
      data: { reason: "a visitor decides no approval" },
    });
    expect(await failure(app.client.setCredential("SHOP_KEY", "key", { by: visitor.id }))).toMatchObject({
      code: "not_admitted",
    });
    expect(await failure(app.client.start(held, {}, { startedBy: visitor }))).toMatchObject({
      code: "policy_denied",
    });
    expect(await app.client.decide(runId, { decision: "approve", by: { id: "ada" } })).toMatchObject({
      status: "approved",
      decidedBy: "ada",
    });
    expect(await app.client.result(runId)).toBe("done");
  });

  it("starts an agent's run as declared, which its summary keeps whole", async () => {
    const runId = await app.client.start(held, {}, { startedBy: "refund-bot" });
    expect((await app.client.run(runId))?.startedBy).toEqual({
      id: "refund-bot",
      groups: ["agents", "finance"],
      onBehalfOf: "bo",
    });
  });
});
