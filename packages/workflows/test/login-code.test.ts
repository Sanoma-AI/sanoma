import { resend } from "@sanoma-ai/connector-resend";
import { describe, expect, it } from "vitest";
import {
  INVITE_SECONDS,
  LOGIN_AGENT,
  LOGIN_CODE_WORKFLOW,
  openInvite,
  resolveConfig,
  sealInvite,
  sealLoginCode,
} from "../src/index.ts";
import { admit, describeConfig } from "../src/describe.ts";
import { memoryLedger } from "../src/ledger.ts";
import { VENDOR } from "../src/op.ts";
import { isVisitor } from "../src/shared.ts";
import { ALICE, rootWith, useApp } from "./harness.ts";

// The built-in login-code workflow: a sign-in code mailed through the config's `login.sender` by
// the runtime's agent `login`, the code sealed in the run's input and the mail's body never in the
// ledger; the sealed invite request; sign-ins and invites as ledger records; `sanoma check`'s
// problem for a policy that holds the code.

/** The template's policy: every send waits for editor, unless editor asked, or the runtime's agent `login` does. */
const HOLD_SENDS = (exempt: boolean) => `@id("editor-reviews")
@hold("editor")
forbid (principal, action in [Sanoma::Action::"effect:publish", Sanoma::Action::"effect:send"], resource)
unless { principal in Sanoma::Group::"editor"${exempt ? ` || principal == Sanoma::Principal::"${LOGIN_AGENT}"` : ""} };
`;

const PEOPLE = `import { sanoma } from "sanoma/resources";

export const alice = sanoma.person({ id: "alice", email: "alice@example.com" });
export const editor = sanoma.group({ name: "editor", members: ["alice"] });
`;

describe("the login-code workflow", () => {
  const root = rootWith({ "policies/policy.cedar": HOLD_SENDS(true), "resources/people.ts": PEOPLE });
  const app = useApp("login-code", (v) => ({
    root,
    login: { sender: v.connectors.find((c) => c[VENDOR].id === "resend")!.emails!.send! },
  }));

  it("mails the code as the login agent, and the ledger never shows it", async () => {
    const runId = await app.client.start(
      LOGIN_CODE_WORKFLOW,
      { to: "alice@example.com", code: sealLoginCode("alice@example.com", "123456") },
      { startedBy: LOGIN_AGENT },
    );
    await app.client.result(runId);
    const [mail] = app.vendors.calls.filter((c) => c.op === "resend.emails.send");
    expect(mail!.input).toMatchObject({ to: "alice@example.com", subject: expect.stringContaining("sign-in code") });
    expect((mail!.input as { text: string }).text).toContain("123456");
    const ledger = JSON.stringify(await app.client.ledger(runId));
    expect(ledger).not.toContain("123456");
    expect(ledger).toContain('"text":"<text>"');
  });

  it("refuses a code it did not seal", async () => {
    const runId = await app.client.start(
      LOGIN_CODE_WORKFLOW,
      { to: "alice@example.com", code: "not-sealed" },
      { startedBy: LOGIN_AGENT },
    );
    await expect(app.client.result(runId)).rejects.toThrow(/not one this deployment sealed/);
    // Another's code, copied from their run's input, mails nobody else.
    const copied = await app.client.start(
      LOGIN_CODE_WORKFLOW,
      { to: "mallory@example.com", code: sealLoginCode("alice@example.com", "123456") },
      { startedBy: LOGIN_AGENT },
    );
    await expect(app.client.result(copied)).rejects.toThrow(/not one this deployment sealed for mallory@example.com/);
    expect(app.ops()).toEqual([]);
  });

  it("is refused to a visitor", async () => {
    await expect(
      app.client.start(LOGIN_CODE_WORKFLOW, { to: "x@example.com", code: "x" }, { startedBy: "anonymous" }),
    ).rejects.toThrow(/runtime's own workflows/);
  });

  it("records sign-ins and invites outside any run", async () => {
    await app.client.recordSignIn("alice", "code");
    await app.client.recordSignIn("alice", "invite");
    await app.client.recordInvite("alice", { by: "alice", expiresAt: new Date(Date.now() + INVITE_SECONDS * 1000) });
    const last = await app.client.lastSignIns(["alice", "nobody"]);
    expect(last).toEqual({ alice: { at: expect.any(Number), method: "invite" } });
    await expect(app.client.recordSignIn("mallory", "code")).rejects.toThrow(/not admitted|declared/i);
  });

  it("mints api tokens that resolve to token:<id> until revoked, keeping only their hash", async () => {
    const { id, token } = await app.client.tokens.mint({ subject: "visitor:better-auth:u1", groups: ["visitors"] });
    expect(token).toMatch(/^sca_[\w-]{43}$/);
    expect(await app.client.tokens.resolve(token)).toEqual({
      principal: { id: `token:${id}`, groups: ["visitors"] },
      subject: "visitor:better-auth:u1",
    });
    expect(await app.client.tokens.resolve(`${token}x`)).toBeUndefined();
    expect(await app.client.tokens.resolve("not-a-token")).toBeUndefined();
    await app.client.tokens.revoke({ id });
    expect(await app.client.tokens.resolve(token)).toBeUndefined();
  });
});

describe("the config's login", () => {
  const connectors = [resend];
  const config = (files: Record<string, string>, sender: unknown = resend.emails.send) => ({
    connectors,
    root: rootWith(files),
    ledger: memoryLedger(),
    login: { sender } as never,
  });

  it("registers login-code and describes the sender", () => {
    const description = describeConfig(config({ "resources/people.ts": ALICE }));
    expect(description.login).toEqual({ sender: "resend.emails.send" });
    expect(description.workflows.find((w) => w.name === LOGIN_CODE_WORKFLOW)?.builtin).toBe(true);
    expect(description.problems).toEqual([]);
  });

  it("has no login-code without a sender", () => {
    expect(resolveConfig({ connectors, ledger: memoryLedger() }).workflows.has(LOGIN_CODE_WORKFLOW)).toBe(false);
  });

  it("refuses a sender that does not send, or is of no connector", () => {
    expect(() => resolveConfig(config({}, resend.broadcast.create))).toThrow(/does not send/);
    expect(() => resolveConfig(config({}, resend.broadcast.send))).toThrow(/does not take an email/);
    expect(() => resolveConfig({ ...config({}), connectors: [] })).toThrow(/of no connector/);
    expect(() => resolveConfig(config({}, "resend.emails.send"))).toThrow(/is not an operation/);
  });

  it("refuses a company workflow named login-code", async () => {
    const { defineWorkflow } = await import("../src/index.ts");
    const { z } = await import("zod");
    const wf = defineWorkflow({
      name: LOGIN_CODE_WORKFLOW,
      trigger: "manual",
      input: z.object({}),
      uses: [],
      run: async () => {},
    });
    expect(() => resolveConfig({ connectors, ledger: memoryLedger(), workflows: [wf] })).toThrow(/built-in/);
  });

  it("says when the policy holds the code", () => {
    const held = describeConfig(config({ "policies/policy.cedar": HOLD_SENDS(false), "resources/people.ts": PEOPLE }));
    expect(held.problems).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/holds resend\.emails\.send .*editor-reviews/) }),
    ]);
    const exempt = describeConfig(config({ "policies/policy.cedar": HOLD_SENDS(true), "resources/people.ts": PEOPLE }));
    expect(exempt.problems).toEqual([]);
  });
});

describe("a token's principal", () => {
  it("is a visitor's", () => {
    expect(isVisitor({ id: "token:abc" })).toBe(true);
    expect(isVisitor({ id: "token:" })).toBe(false);
  });

  it("keeps the groups its row gives, through admission, and never signs in", () => {
    const people = { people: [], problems: [] };
    expect(admit({ id: "token:t1", groups: ["members"] }, people)).toEqual({ id: "token:t1", groups: ["members"] });
    expect(admit({ id: "visitor:acme:u1", groups: ["members"] }, people)).toEqual({
      id: "visitor:acme:u1",
      groups: ["visitors"],
    });
    expect(() => admit({ id: "token:t1", groups: ["members"] }, people, true)).toThrow(/not declared/);
  });
});

describe("sealed invite requests", () => {
  it("open for the same key and purpose, until they expire", () => {
    const sealed = sealInvite({ email: "alice@example.com" });
    expect(openInvite(sealed)).toMatchObject({ email: "alice@example.com", nonce: expect.any(String) });
    expect(openInvite(sealed, Date.now() + 10 * 60_000)).toBeUndefined();
    expect(openInvite(sealLoginCode("alice@example.com", "123456"))).toBeUndefined();
    expect(openInvite(`${sealed.slice(0, -2)}AA`)).toBeUndefined();
    expect(openInvite("")).toBeUndefined();
  });
});
