import { blueskyDriver } from "@sanoma/connector-bluesky/driver";
import { ghostDriver } from "@sanoma/connector-ghost/driver";
import { githubDriver } from "@sanoma/connector-github/driver";
import { resendDriver } from "@sanoma/connector-resend/driver";
import { stripeDriver } from "@sanoma/connector-stripe/driver";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { testDatabaseUrl, withFake } from "@sanoma/testing";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  allowAll,
  defineConnector,
  defineDriver,
  defineWorkflow,
  type Ctx,
  type Driver,
  errorCode,
  memoryLedger,
  resolveConfig,
  SanomaClient,
  type SanomaConfig,
  startWorker,
} from "../src/index.ts";
import { credentialsOf } from "../src/env.ts";
import { defineFake } from "../src/fake.ts";
import { describeConfig } from "../src/describe.ts";

// Made-up variables and values: nothing here is a credential.
const URL_VAR = "SANOMA_TEST_ACME_URL";
const KEY_VAR = "SANOMA_TEST_ACME_KEY";
const REGION_VAR = "SANOMA_TEST_ACME_REGION";
const KEY = "key_madeupvalue";

const acme = defineConnector("acme", {
  thing: { get: { effect: "read", input: z.object({ id: z.string() }), output: z.object({ id: z.string() }) } },
});
const env = z.object({
  [URL_VAR]: z.url().describe("the account's API URL"),
  [KEY_VAR]: z
    .string()
    .regex(/^key_[a-z]+$/, "an API key, key_<letters>")
    .describe("an API key"),
  [REGION_VAR]: z.enum(["us", "eu"]).describe("the region; default us").optional(),
});
const impl = { thing: { get: async ({ id }: { id: string }) => ({ id }) } };
const acmeDriver = defineDriver(acme, impl, { env });
const plain = defineDriver(acme, impl);
const acmeFake = defineFake(acme, { initial: () => ({}), ops: () => impl });
/** acme, set up with `driver`. */
const acmeOn = (driver: Driver) => withFake(acme, acmeFake, driver);
const getThing = defineWorkflow({
  name: "get-thing",
  trigger: "manual",
  input: z.object({ id: z.string() }),
  uses: [acme.thing.get],
  run: async (ctx, { id }) => ctx.acme.thing.get({ id }),
});
const databaseUrl = testDatabaseUrl("credentials");
const config: SanomaConfig = {
  workflows: [getThing],
  connectors: [acmeOn(acmeDriver)],
  policy: allowAll,
  ledger: memoryLedger(),
  databaseUrl,
};
/** Sets and clears the stored credentials, as the app does. */
let client: SanomaClient;

beforeAll(async () => {
  client = await SanomaClient.connect(config);
});

afterAll(async () => {
  await client?.close();
});

// The table outlives a run of the tests: each starts with nothing stored.
beforeEach(async () => {
  for (const name of [URL_VAR, KEY_VAR, REGION_VAR]) await client.clearCredential(name, { by: "tester" });
});
/** acme's statuses as the worker checks them, against `process.env`. */
const checked = (cfg = config) =>
  credentialsOf(resolveConfig(cfg).driversByVendor, (name) => process.env[name]).get("acme");
const statuses = () => checked()?.map(({ name, status }) => [name, status]);

/**
 * Runs `start`, which is to fail, and counts the credentials listeners (the connections that hear
 * notifications) it opened, and those it left open.
 */
async function listeners(start: () => Promise<unknown>) {
  const connect = vi.spyOn(Client.prototype, "connect");
  const end = vi.spyOn(Client.prototype, "end");
  try {
    const message = await start().then(
      () => "started",
      (err: Error) => err.message,
    );
    const opened = (connect.mock.contexts as Client[]).filter((db) => db.listenerCount("notification") > 0);
    return { message, opened: opened.length, left: opened.filter((db) => !end.mock.contexts.includes(db)).length };
  } finally {
    connect.mockRestore();
    end.mockRestore();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a driver's env", () => {
  it("is kept on the driver, which is frozen", () => {
    expect(acmeDriver.env).toBe(env);
    expect(Object.isFrozen(acmeDriver)).toBe(true);
    expect(Object.isFrozen(acmeDriver.ops)).toBe(true);
    expect(plain).not.toHaveProperty("env");
  });

  it("is checked against process.env: set, missing, empty and invalid, never the value", () => {
    vi.stubEnv(URL_VAR, "https://acme.example.test");
    vi.stubEnv(KEY_VAR, KEY);
    vi.stubEnv(REGION_VAR, undefined);
    expect(checked()).toEqual([
      { name: URL_VAR, description: "the account's API URL", optional: false, status: "set" },
      { name: KEY_VAR, description: "an API key", optional: false, status: "set" },
      { name: REGION_VAR, description: "the region; default us", optional: true, status: "missing" },
    ]);

    vi.stubEnv(URL_VAR, undefined);
    vi.stubEnv(KEY_VAR, "");
    expect(statuses()).toEqual([
      [URL_VAR, "missing"],
      [KEY_VAR, "missing"],
      [REGION_VAR, "missing"],
    ]);

    vi.stubEnv(URL_VAR, "not a url");
    vi.stubEnv(KEY_VAR, "key_NOT-LOWER");
    const [url, key] = checked()!;
    expect(url).toMatchObject({ status: "invalid", problem: "Invalid URL" });
    expect(key).toMatchObject({ status: "invalid", problem: "an API key, key_<letters>" });
    expect(JSON.stringify([url, key])).not.toMatch(/not a url|NOT-LOWER/);
  });

  it("is invalid, without the value, when its check throws", async () => {
    const VALUE = "madeup-not-a-url";
    vi.stubEnv(URL_VAR, VALUE);
    const throwing = defineDriver(acme, impl, {
      env: z.object({ [URL_VAR]: z.string().refine((v) => new URL(v).protocol === "https:") }),
    });
    const throwingConfig = { ...config, connectors: [acmeOn(throwing)] };
    const credentials = checked(throwingConfig);
    expect(credentials).toEqual([{ name: URL_VAR, optional: false, status: "invalid", problem: "its check threw" }]);
    const warning = await warnedAtStart(throwingConfig);
    expect(warning).toContain(`${URL_VAR} is invalid: its check threw`);
    expect(JSON.stringify([credentials, warning])).not.toContain(VALUE);
  });
});

/** Starts a worker on `cfg`, stops it, and gives what it warned about acme at start, if anything. */
async function warnedAtStart(cfg: SanomaConfig): Promise<string | undefined> {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const worker = await startWorker(cfg);
  await worker.stop();
  return warn.mock.calls.flat().find((m) => String(m).includes("acme is not configured")) as string | undefined;
}

describe("startWorker", () => {
  it("starts, warning per vendor of the variables missing or invalid, and listens for the missing ones", async () => {
    vi.stubEnv(URL_VAR, undefined);
    vi.stubEnv(KEY_VAR, "key_NOT-LOWER");
    vi.stubEnv(REGION_VAR, undefined);
    const launch = vi.spyOn(DBOS, "launch");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { message, opened, left } = await listeners(async () => {
      const worker = await startWorker(config);
      await worker.stop();
    });
    expect(message).toBe("started");
    expect(warn).toHaveBeenCalledWith(
      `sanoma: acme is not configured: ${URL_VAR} (the account's API URL), ${KEY_VAR} is invalid: an API key, key_<letters>; ` +
        "set in the environment",
    );
    expect(warn.mock.calls.flat().join("\n")).not.toContain("NOT-LOWER");
    expect(launch).toHaveBeenCalledTimes(1);
    // It listened for the stored values of the two it lacks while it ran, and stopped with it.
    expect({ opened, left }).toEqual({ opened: 1, left: 0 });
  });

  it("refuses a workflow it cannot outline before listening for credentials", async () => {
    vi.stubEnv(URL_VAR, undefined);
    type Getting = Ctx<readonly [typeof acme.thing.get]>;
    const get = (ctx: Getting, id: string) => ctx.acme.thing.get({ id });
    const helper = defineWorkflow({
      name: "credentials-helper",
      trigger: "manual",
      input: z.object({ id: z.string() }),
      uses: [acme.thing.get],
      run: async (ctx, { id }) => get(ctx, id),
    });
    const { message, opened, left } = await listeners(() => startWorker({ ...config, workflows: [helper] }));
    expect(message).toMatch(/^Workflow "credentials-helper" cannot be outlined/);
    expect({ opened, left }).toEqual({ opened: 0, left: 0 });
  });

  it("warns of an invalid variable even when it is optional", async () => {
    vi.stubEnv(URL_VAR, "https://acme.example.test");
    vi.stubEnv(KEY_VAR, KEY);
    vi.stubEnv(REGION_VAR, "mars");
    expect(await warnedAtStart(config)).toBe(
      `sanoma: acme is not configured: ${REGION_VAR} is invalid: Invalid option: expected one of "us"|"eu"; ` +
        "set in the environment",
    );
  });

  it("points at the connector page when nothing invalid is in the environment", async () => {
    vi.stubEnv(URL_VAR, undefined);
    vi.stubEnv(KEY_VAR, undefined);
    vi.stubEnv(REGION_VAR, undefined);
    expect(await warnedAtStart(config)).toBe(
      `sanoma: acme is not configured: ${URL_VAR} (the account's API URL), ${KEY_VAR} (an API key); set it on the connector page`,
    );
  });
});

describe("a call to a vendor the worker started without", () => {
  it("fails at the call, saying what the worker warned at start, until they are set", async () => {
    vi.stubEnv(URL_VAR, undefined);
    vi.stubEnv(KEY_VAR, "key_NOT-LOWER");
    vi.stubEnv(REGION_VAR, undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const worker = await startWorker(config);
    try {
      const runId = await client.start(getThing, { id: "1" }, { startedBy: { id: "alice" } });
      const err = (await client.result(runId).catch((e: unknown) => e)) as Error;
      const message = `acme is not configured: ${URL_VAR} (the account's API URL), ${KEY_VAR} is invalid: an API key, key_<letters>; set in the environment`;
      expect(err.message).toBe(message);
      expect(errorCode(err)).toBe("driver_failed");
      // The call's own failure, final, in the ledger as any driver's would be.
      const ledger = await client.ledger(runId);
      expect(ledger.map((r) => r.type)).toEqual(["run.started", "op.called", "run.failed"]);
      expect(ledger[1]).toMatchObject({
        op: "acme.thing.get",
        decision: { kind: "allow" },
        error: { code: "driver_failed", name: "DriverError", message, retryable: false },
        attempt: 1,
      });
      expect(JSON.stringify(ledger)).not.toContain("NOT-LOWER");

      // Set from the app (the worker loads it) and in the environment: the next run calls the vendor.
      await client.setCredential(URL_VAR, "https://acme.example.test", { by: "alice" });
      await vi.waitFor(() => expect(process.env[URL_VAR]).toBe("https://acme.example.test"));
      vi.stubEnv(KEY_VAR, KEY);
      const ok = await client.start(getThing, { id: "2" }, { startedBy: { id: "alice" } });
      expect(await client.result(ok)).toEqual({ id: "2" });
    } finally {
      await worker.stop();
    }
  });
});

describe("describeConfig", () => {
  it("carries no credentials, and no value: SanomaClient.credentials has their statuses", () => {
    vi.stubEnv(KEY_VAR, KEY);
    const { vendors } = describeConfig(config);
    expect(vendors.acme).not.toHaveProperty("credentials");
    expect(JSON.stringify(vendors)).not.toContain(KEY);
  });
});

/** What the call throws, as its code, message and data in one string, to look for a value in. */
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (err: { message: string; data?: unknown }) => ({
      code: errorCode(err),
      message: err.message,
      text: `${err.message} ${JSON.stringify(err.data)}`,
    }),
  );

/** acme's statuses as `credentials()` gives them. */
const stored = async (from = client) => (await from.credentials()).get("acme");

describe("stored credentials", () => {
  it("are set, replaced and cleared, with who set them and when, never the value", async () => {
    vi.stubEnv(URL_VAR, undefined);
    vi.stubEnv(KEY_VAR, undefined);
    vi.stubEnv(REGION_VAR, undefined);
    expect((await stored())?.[1]).toEqual({
      name: KEY_VAR,
      description: "an API key",
      optional: false,
      status: "missing",
    });

    const before = Date.now() - 60_000;
    await client.setCredential(KEY_VAR, KEY, { by: "alice" });
    const [, key] = (await stored())!;
    expect(key).toMatchObject({ name: KEY_VAR, status: "set", source: "stored", setBy: "alice" });
    expect(Date.parse(key!.setAt!)).toBeGreaterThan(before);

    await client.setCredential(KEY_VAR, "key_replaced", { by: "bob" });
    expect((await stored())?.[1]).toMatchObject({ status: "set", source: "stored", setBy: "bob" });
    expect(JSON.stringify([...(await client.credentials())])).not.toMatch(/key_madeupvalue|key_replaced/);

    await client.clearCredential(KEY_VAR, { by: "bob" });
    expect((await stored())?.[1]).toEqual({
      name: KEY_VAR,
      description: "an API key",
      optional: false,
      status: "missing",
    });
  });

  it("are refused for a name no driver declares, and without someone setting them", async () => {
    for (const p of [
      client.setCredential("SANOMA_TEST_UNDECLARED", KEY, { by: "alice" }),
      client.clearCredential("SANOMA_TEST_UNDECLARED", { by: "alice" }),
    ]) {
      const { code, message, text } = await refusal(p);
      expect(code).toBe("invalid_input");
      expect(message).toBe(
        `No driver declares SANOMA_TEST_UNDECLARED; the declared variables are ${URL_VAR}, ${KEY_VAR}, ${REGION_VAR}`,
      );
      expect(text).not.toContain(KEY);
    }
    // The value in the name's place, as a script that swaps them sends it: not repeated.
    const swapped = await refusal(client.setCredential(KEY, KEY_VAR, { by: "alice" }));
    expect(swapped.message).toBe(
      `That is not a variable name; the declared variables are ${URL_VAR}, ${KEY_VAR}, ${REGION_VAR}`,
    );
    expect(swapped.text).not.toContain(KEY);
    expect((await refusal(client.setCredential(KEY_VAR, KEY, { by: "" }))).code).toBe("invalid_input");
    expect((await stored())?.[1]?.status).toBe("missing");
  });

  it("refuses a value its schema refuses, or an empty one, with the reason and without the value", async () => {
    const VALUE = "key_NOT-LOWER";
    const invalid = await refusal(client.setCredential(KEY_VAR, VALUE, { by: "alice" }));
    expect(invalid).toMatchObject({
      code: "invalid_input",
      message: `${KEY_VAR} cannot be set: an API key, key_<letters>`,
    });
    expect(invalid.text).toContain(
      '"issues":[{"path":["value"],"message":"an API key, key_<letters>","code":"custom"}]',
    );
    expect(invalid.text).not.toContain(VALUE);

    const empty = await refusal(client.setCredential(KEY_VAR, "", { by: "alice" }));
    expect(empty.message).toBe(`${KEY_VAR} cannot be set: it is empty; clear it to unset it`);
    expect((await stored())?.[1]?.status).toBe("missing");
  });

  it("are overridden by the environment, which credentials() says is the source", async () => {
    vi.stubEnv(KEY_VAR, "key_fromenv");
    await client.setCredential(KEY_VAR, KEY, { by: "alice" });
    const [, key] = (await stored())!;
    expect(key).toEqual({
      name: KEY_VAR,
      description: "an API key",
      optional: false,
      status: "set",
      source: "environment",
    });
    vi.stubEnv(KEY_VAR, "key_NOT-LOWER");
    expect((await stored())?.[1]).toMatchObject({ status: "invalid", source: "environment" });
    // The stored value, as a worker in this process loads it, is the stored one.
    vi.stubEnv(KEY_VAR, KEY);
    expect((await stored())?.[1]).toMatchObject({ status: "set", source: "stored", setBy: "alice" });
  });
});

describe("a worker's credentials", () => {
  it("are loaded from the table at start, reloaded on each change, and never replace the environment's", async () => {
    const FROM_ENV = "https://acme.example.test";
    vi.stubEnv(URL_VAR, FROM_ENV);
    vi.stubEnv(KEY_VAR, undefined);
    vi.stubEnv(REGION_VAR, undefined);
    await client.setCredential(KEY_VAR, KEY, { by: "alice" });
    await client.setCredential(URL_VAR, "https://stored.example.test", { by: "alice" });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const said = () => info.mock.calls.flat().filter((m) => String(m).startsWith("sanoma:"));
    // KEY_VAR is not in the environment: only its stored value lets the worker start.
    const worker = await startWorker(config, { logLevel: "info" });
    try {
      expect(process.env[KEY_VAR]).toBe(KEY);
      expect(process.env[URL_VAR]).toBe(FROM_ENV);
      expect(said()).toEqual(["sanoma: credentials loaded for acme (1 variable)"]);

      await client.setCredential(KEY_VAR, "key_rotated", { by: "bob" });
      await vi.waitFor(() => expect(process.env[KEY_VAR]).toBe("key_rotated"));
      await client.setCredential(REGION_VAR, "eu", { by: "bob" });
      await vi.waitFor(() => expect(process.env[REGION_VAR]).toBe("eu"));
      await client.clearCredential(KEY_VAR, { by: "bob" });
      await vi.waitFor(() => expect(process.env).not.toHaveProperty(KEY_VAR));
      // Its stored value was never loaded, so clearing it leaves the environment's. The worker
      // reloads one change at a time, so once it has the next, it has handled this one.
      await client.clearCredential(URL_VAR, { by: "bob" });
      await client.setCredential(REGION_VAR, "us", { by: "bob" });
      await vi.waitFor(() => expect(process.env[REGION_VAR]).toBe("us"));
      expect(process.env[URL_VAR]).toBe(FROM_ENV);
      expect(said()).toEqual([
        "sanoma: credentials loaded for acme (1 variable)",
        ...Array(4).fill("sanoma: credentials reloaded for acme (1 variable)"),
      ]);
    } finally {
      await worker.stop();
    }
    // Stopped, it takes back what it set, and leaves what the environment set.
    expect(process.env).not.toHaveProperty(REGION_VAR);
    expect(process.env[URL_VAR]).toBe(FROM_ENV);
  });
});

describe("the connectors' drivers", () => {
  const bridge = {} as never;
  it.each([
    ["ghost", ghostDriver(), ["GHOST_ADMIN_URL", "GHOST_ADMIN_API_KEY"], []],
    ["resend", resendDriver(), ["RESEND_API_KEY", "RESEND_FROM"], ["RESEND_FROM"]],
    [
      "bluesky",
      blueskyDriver(),
      ["BLUESKY_IDENTIFIER", "BLUESKY_APP_PASSWORD", "BLUESKY_SERVICE"],
      ["BLUESKY_SERVICE"],
    ],
    ["github", githubDriver({ bridge }), ["GITHUB_TOKEN", "GITHUB_OWNER"], ["GITHUB_OWNER"]],
    ["stripe", stripeDriver({ bridge }), ["STRIPE_API_KEY"], []],
  ])("%s declares exactly its variables, each described, and which are optional", (_, driver, names, optional) => {
    const shape = driver.env!.shape;
    expect(Object.keys(shape)).toEqual(names);
    for (const schema of Object.values(shape)) expect(schema.description).toBeTruthy();
    const optionals = Object.entries(shape).filter(([, schema]) => schema.safeParse(undefined).success);
    expect(optionals.map(([name]) => name)).toEqual(optional);
  });
});
