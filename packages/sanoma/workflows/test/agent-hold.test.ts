import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resend } from "@sanoma-ai/connector-resend";
import { withFake } from "sanoma/testing";
import { useTestApp } from "sanoma/testing/harness";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { decideStart } from "../src/call.ts";
import { collection } from "../src/data.ts";
import { readOnly } from "../src/define.ts";
import { describeConfig } from "../src/describe.ts";
import { defineFake } from "../src/fake.ts";
import {
  cedarPolicy,
  defineConnector,
  defineResource,
  defineWorkflow,
  loadPolicies,
  memoryLedger,
  readPolicyFiles,
  resolveConfig,
  type SanomaConfig,
  type Source,
  validatePolicies,
} from "../src/index.ts";
import { VENDOR } from "../src/op.ts";
import { allowAll } from "../src/policy.ts";
import { readPeople } from "../src/resources.ts";
import { BUILT_IN_WORKFLOWS } from "../src/shared.ts";
import { fakeMail, mailDataFile } from "./fakes/mail.ts";
import announce from "./fixtures/announce.ts";
import { failure, freshDatabase, pending, rootWith, useApp, waitFor } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. The runtime's rule on agents: a declared agent's start of a
// built-in that is not read-only waits for admin, with or without policy files, until an admin
// approves it; refused while no admin group is declared; lifted by a company permit for agents.
// A person's start of a built-in is the company's policy's to decide, and the internal workflows
// start whatever it says.

/** The startable built-ins that only read: the one constant to change when a built-in comes to read only. */
const READ_ONLY_BUILT_INS = ["drift", "plan"];

const PEOPLE = `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada" });
export const bo = sanoma.person({ id: "bo" });
export const cy = sanoma.person({ id: "cy" });
export const bot = sanoma.agent({ id: "bot" });
export const trusted = sanoma.agent({ id: "trusted" });
export const careful = sanoma.agent({ id: "careful" });
export const admin = sanoma.group({ name: "admin", members: [ada] });
`;
const bot = { id: "bot", onBehalfOf: "bo" };
const trusted = { id: "trusted", onBehalfOf: "bo" };
const careful = { id: "careful", onBehalfOf: "bo" };
const sending = "resources/mail.ts#sending";
const AGENTS_WAIT = "sanoma:agents-wait-for-admin";
/** Why an agent's start of the built-in `workflow` is refused while no person is in admin. */
const NO_ADMIN = (workflow: string) =>
  `An agent's start of ${workflow} waits for a person in the group "admin", and no data file puts one in it: ` +
  "add one in resources/people.ts, or permit agents to start it in policies/";

/** A company workflow that writes: the runtime's rule never covers it. */
const notes = defineConnector("notes", {
  note: { add: { effect: "write", input: z.object({ text: z.string() }), output: z.object({}) } },
});
const notesFake = defineFake(notes, { initial: () => ({}), ops: () => ({ note: { add: async () => ({}) } }) });
const note = defineWorkflow({
  name: "note",
  trigger: "manual",
  input: z.object({ text: z.string() }),
  uses: [notes.note.add],
  run: async (ctx, { text }) => ctx.notes.note.add({ text }),
});

/** A source that takes commits and records none: the lockfile is all apply writes. */
const committing = (root: string): Source => {
  let n = 0;
  return { root, commit: () => ({ revision: `rev${++n}` }), head: () => `rev${n}` };
};

/** A test app over the mail fake and `note`, with `files` in its root. */
function appWith(name: string, files: Record<string, string>) {
  const root = rootWith({ "resources/people.ts": PEOPLE, "resources/mail.ts": mailDataFile, ...files });
  const databaseUrl = freshDatabase(name);
  const config: SanomaConfig = {
    workflows: [note],
    connectors: [fakeMail().connector, withFake(notes, notesFake)],
    ledger: memoryLedger(),
    root,
  };
  return useTestApp(config, { databaseUrl, source: committing(root) });
}

describe("an agent's start of a built-in, with no policy files", () => {
  const app = appWith("agent_hold", {});

  it("holds an agent's apply for admin, which runs once an admin approves it", async () => {
    const runId = await app.client.apply({}, { startedBy: bot });
    await waitFor(pending(() => app.client, runId));
    expect(await app.client.approvals(runId)).toEqual([
      expect.objectContaining({
        title: "An agent's apply waits for admin",
        approver: { group: "admin" },
        status: "pending",
        reasons: [AGENTS_WAIT],
      }),
    ]);
    // Bo, for whom it acts, is not in admin.
    expect(await failure(app.client.decide(runId, { decision: "approve", by: { id: "bo" } }))).toMatchObject({
      code: "not_approver",
    });
    await app.client.decide(runId, { decision: "approve", by: { id: "ada" } });
    expect((await app.client.applyReport(runId)).results).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: sending, status: "done" })]),
    );
  });

  it("holds none of a read-only built-in, a person's start, the runtime's agents' or an agent's start of a company workflow", async () => {
    const drift = await app.client.drift({ startedBy: bot });
    expect((await app.client.driftReport(drift)).resources.length).toBeGreaterThan(0);
    const planned = await app.client.start("plan", {}, { startedBy: bot });
    await app.client.result(planned);
    expect(await app.client.approvals(planned)).toEqual([]);
    for (const startedBy of ["bo", "host-check", "schedule"]) {
      const runId = await app.client.apply({}, { startedBy });
      await app.client.applyReport(runId);
      expect(await app.client.approvals(runId), startedBy).toEqual([]);
    }
    const noted = await app.client.start(note, { text: "hi" }, { startedBy: bot });
    await app.client.result(noted);
    expect(await app.client.approvals(noted)).toEqual([]);
  });
});

describe("an agent's start of a built-in, under the company's policies", () => {
  const app = appWith("agent_hold_policies", {
    "policies/agents.cedar": `@id("trusted-applies")
permit (principal in Sanoma::Group::"agents", action == Sanoma::Action::"workflow:apply", resource)
when { principal == Sanoma::Principal::"trusted" || principal == Sanoma::Principal::"careful" };

@id("careful-applies-wait-for-bo")
@hold("bo")
forbid (principal == Sanoma::Principal::"careful", action == Sanoma::Action::"workflow:apply", resource);

@id("bot-applies-wait-for-bo")
@hold("bo")
@title("The bot's apply waits for bo")
forbid (principal == Sanoma::Principal::"bot", action == Sanoma::Action::"workflow:apply", resource);

@id("bo-no-drift")
@reason("Bo does not check drift")
forbid (principal == Sanoma::Principal::"bo", action == Sanoma::Action::"workflow:drift", resource);

@id("cy-applies-wait-for-ada")
@hold("ada")
@title("Cy's apply waits for ada")
forbid (principal == Sanoma::Principal::"cy", action == Sanoma::Action::"workflow:apply", resource);
`,
  });

  it("lets a company permit for agents lift the hold", async () => {
    const runId = await app.client.apply({}, { startedBy: trusted });
    await app.client.applyReport(runId);
    expect(await app.client.approvals(runId)).toEqual([]);
  });

  it("lifts it for an agent the company permits once the company's own hold on it is approved", async () => {
    const runId = await app.client.apply({}, { startedBy: careful });
    await waitFor(pending(() => app.client, runId));
    await app.client.decide(runId, { decision: "approve", by: { id: "bo" } });
    expect((await app.client.applyReport(runId)).results).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: sending, status: "done" })]),
    );
    expect(await app.client.approvals(runId)).toEqual([
      expect.objectContaining({ approver: "bo", reasons: ["careful-applies-wait-for-bo"], status: "approved" }),
    ]);
  });

  it("holds an agent's apply for the company's own hold first, then for admin", async () => {
    const runId = await app.client.apply({}, { startedBy: bot });
    await waitFor(pending(() => app.client, runId));
    expect((await app.client.approvals(runId)).at(-1)).toMatchObject({
      approver: "bo",
      reasons: ["bot-applies-wait-for-bo"],
    });
    await app.client.decide(runId, { decision: "approve", by: { id: "bo" } });
    await waitFor(pending(() => app.client, runId, 2));
    expect((await app.client.approvals(runId)).at(-1)).toMatchObject({
      approver: { group: "admin" },
      reasons: [AGENTS_WAIT],
    });
    await app.client.decide(runId, { decision: "approve", by: { id: "ada" } });
    await app.client.applyReport(runId);
  });

  it("decides a person's start of a built-in by the company's forbid and @hold on its workflow action", async () => {
    expect(await failure(app.client.drift({ startedBy: "bo" }))).toMatchObject({
      code: "policy_denied",
      message: "workflow:drift was denied by policy: Bo does not check drift",
    });
    const runId = await app.client.apply({}, { startedBy: "cy" });
    await waitFor(pending(() => app.client, runId));
    expect(await app.client.approvals(runId)).toEqual([
      expect.objectContaining({ approver: "ada", reasons: ["cy-applies-wait-for-ada"] }),
    ]);
    await app.client.decide(runId, { decision: "approve", by: { id: "ada" } });
    await app.client.applyReport(runId);
  });
});

/** A people file with ada, the agent bot, and `admin`'s declaration. */
const peopleWith = (admin: string) => `import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada" });
export const bot = sanoma.agent({ id: "bot" });
${admin}
`;

describe("an agent's start of a built-in, with no person in admin", () => {
  const apply = resolveConfig({ workflows: [], connectors: [fakeMail().connector] }).workflows.get("apply")!;

  it("refuses it with one message whether admin is undeclared, empty or only agents", () => {
    for (const admin of [
      "",
      'export const admin = sanoma.group({ name: "admin", members: [] });',
      'export const admin = sanoma.group({ name: "admin", members: [bot] });',
    ]) {
      const root = rootWith({ "resources/people.ts": peopleWith(admin) });
      expect(decideStart({ policy: allowAll, root }, apply, {}, { id: "bot", groups: ["agents"] }), admin).toEqual({
        kind: "deny",
        reason: NO_ADMIN("apply"),
        reasons: [AGENTS_WAIT],
      });
    }
  });
});

describe("the internal workflows, under a policy that forbids every start", () => {
  const root = rootWith({
    "resources/people.ts": PEOPLE,
    "policies/none.cedar": `forbid (principal, action in Sanoma::Action::"start", resource);\n`,
  });
  const app = useApp("internal_starts", (v) => ({
    root,
    login: {
      sender: v.connectors.find((c) => c[VENDOR].id === "resend")!.emails!.send!,
      from: "Acme <login@acme.example>",
    },
  }));

  it("refuses a start from outside, and starts a sign-in code, a chat turn and a webhook's follow", async () => {
    expect(
      await failure(
        app.client.start(announce, { title: "T", body: "B", launchAt: new Date().toISOString() }, { startedBy: "ada" }),
      ),
    ).toMatchObject({
      code: "policy_denied",
    });
    const codes = async () => (await app.client.runs({ workflow: "login-code" })).length;
    const before = await codes();
    await app.client.sendLoginCode("ada@example.com", "123456");
    expect(await codes()).toBe(before + 1);
    const chat = randomUUID();
    await app.client.chats.open({ id: chat, person: "ada", engine: "loop", title: "Chat" });
    await app.client.chats.upsert(chat, [{ id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] }]);
    const turn = await app.client.startTurn({ chat, message: "m1" }, { startedBy: "ada" });
    expect((await app.client.run(turn))?.startedBy).toMatchObject({ id: "ada" });
    const repo = { owner: "acme", name: "company" };
    const head = randomUUID().replaceAll("-", "").padEnd(40, "0");
    const follow = await app.client.follow({ kind: "pushed", repo, branch: "main", head });
    expect((await app.client.run(follow))?.startedBy).toMatchObject({ id: "host-check" });
  });
});

describe("the startable built-ins", () => {
  const bare = resolveConfig({ workflows: [], connectors: [fakeMail().connector] });
  const fullConfig: SanomaConfig = {
    workflows: [],
    connectors: [fakeMail().connector, resend],
    collections: [collection({ name: "leads", key: "id", fields: { id: "text" } })],
    login: { sender: resend.emails.send, from: "Acme <login@acme.example>" },
    secrets: { stores: { builtin: { namespace: "live" } } },
  };
  const full = resolveConfig(fullConfig);
  // Resource types none of which is writable: apply then calls only reads, and still writes the lockfile.
  const hook = defineResource({
    vendor: "hooks",
    type: "hook",
    title: "Hook",
    identity: "name",
    schema: z.object({ name: z.string() }),
    fields: { immutable: [], vendorOwned: [], writeOnly: [] },
    find: ({ name }) => name,
  });
  const hooks = defineConnector("hooks", { hook }, { title: "Hooks", package: "@acme/hooks" });
  const hooksFake = defineFake(hooks, {
    initial: () => ({}),
    ops: () => ({
      hook: { import: async ({ id }) => ({ id, gone: true }), read: async ({ id }) => ({ id, gone: true }) },
    }),
  });
  const readsOnly = resolveConfig({ workflows: [], connectors: [withFake(hooks, hooksFake)] });
  const startable = (resolved: typeof bare) =>
    [...resolved.workflows.values()].filter((wf) => BUILT_IN_WORKFLOWS.has(wf.name) && !wf.internal);

  it("are read-only exactly as pinned, in a bare config, a full one and one whose resources only read", () => {
    for (const resolved of [bare, full, readsOnly]) {
      expect(
        startable(resolved)
          .filter(readOnly)
          .map((wf) => wf.name)
          .toSorted(),
      ).toEqual(READ_ONLY_BUILT_INS);
    }
  });

  it("are described with readOnly where it holds, and the internal ones as internal", () => {
    const { workflows } = describeConfig(fullConfig);
    expect(workflows.find((wf) => wf.name === "drift")).toMatchObject({ builtin: true, readOnly: true });
    expect(workflows.find((wf) => wf.name === "apply")).not.toHaveProperty("readOnly");
    expect(workflows.filter((wf) => wf.internal).map((wf) => wf.name)).toEqual(
      ["call", "change", "chat", "follow", "login-code", "reshape", "save-draft"].toSorted(),
    );
  });

  it("refuses a company workflow that says it is internal", () => {
    const own = defineWorkflow({
      name: "own",
      trigger: "manual",
      input: z.object({}),
      uses: [],
      internal: true,
      run: async () => 1,
    });
    expect(() => resolveConfig({ workflows: [own], connectors: [] })).toThrow(
      `Workflow "own" is internal, as only the runtime's own are; leave it out`,
    );
  });

  it("are each allowed to a person, a representative input fitting Cedar's schema, under the template's policies", () => {
    const template = fileURLToPath(new URL("../../template/", import.meta.url));
    const { people } = readPeople(template);
    const { policies, problems } = loadPolicies(readPolicyFiles(template));
    expect(problems).toEqual([]);
    expect(validatePolicies(full, policies, people)).toEqual([]);
    const policy = cedarPolicy(full, policies, people);
    const inputs: Record<string, unknown> = {
      apply: { only: [sending], answers: {} },
      plan: { only: [sending] },
      drift: {},
      adopt: { runId: "r1", id: sending, paths: ["name"] },
      patch: { at: { file: "resources/mail.ts", export: "sending" }, fields: { name: "example.org", n: 1, on: true } },
      "go-live": { owner: "acme", name: "company", region: "eu", port: 3000 },
      "go-live-host": {},
      "go-live-cloud": { address: "acme" },
      "connect-existing": { repository: "acme/company" },
      import: { collection: "leads", mapping: [{ field: "id" }, null], rows: [["1", "x"]] },
      "migrate-store": { to: "builtin", names: ["KEY"] },
    };
    const names = startable(full).map((wf) => wf.name);
    expect(names.toSorted()).toEqual(Object.keys(inputs).toSorted());
    for (const wf of startable(full)) {
      const parsed = wf.input.parse(inputs[wf.name]);
      expect(policy.start({ id: "founder" }, wf.name, parsed), wf.name).toMatchObject({ kind: "allow" });
    }
  });
});
