import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Bindings,
  diffLockfiles,
  LOCKFILE,
  readLockfile,
  serializeLockfile,
  writeLockfile,
} from "../src/describe.ts";

const repo = { type: "github.repository", id: "R_1" };
const product = { type: "stripe.product", id: "prod_1" };

describe("the lockfile", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sanoma-lockfile-"));
    mkdirSync(join(root, "resources"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("binds nothing when there is none", () => {
    expect(readLockfile(root)).toEqual({ bindings: {}, problems: [] });
  });

  it("is written with its keys sorted, two-space JSON and a trailing newline, and read back as written", () => {
    const bindings: Bindings = { "resources/b.ts#x": product, "resources/a.ts#y": repo };
    writeLockfile(root, bindings);
    const text = readFileSync(join(root, LOCKFILE), "utf8");
    expect(text).toBe(serializeLockfile(bindings));
    expect(text).toBe(
      `{\n  "resources/a.ts#y": {\n    "type": "github.repository",\n    "id": "R_1"\n  },\n` +
        `  "resources/b.ts#x": {\n    "type": "stripe.product",\n    "id": "prod_1"\n  }\n}\n`,
    );
    expect(readLockfile(root)).toEqual({ bindings, problems: [] });
    // A binding's fields in one order, whatever order they were given in.
    expect(serializeLockfile({ "resources/a.ts#y": { id: "R_1", type: "github.repository" } })).toBe(
      serializeLockfile({ "resources/a.ts#y": repo }),
    );
  });

  it("is replaced whole, through a file beside it that does not stay", () => {
    writeLockfile(root, { "resources/a.ts#y": repo });
    writeLockfile(root, {});
    expect(readFileSync(join(root, LOCKFILE), "utf8")).toBe("{}\n");
    expect(readdirSync(join(root, "resources"))).toEqual(["sanoma.lock.json"]);
  });

  it("is a problem, binding nothing, when it is not JSON or not bindings", () => {
    writeFileSync(join(root, LOCKFILE), "{ nope");
    expect(readLockfile(root)).toEqual({
      bindings: {},
      problems: [{ file: LOCKFILE, message: expect.stringMatching(/^not JSON: /) }],
    });
    writeFileSync(join(root, LOCKFILE), JSON.stringify({ "resources/a.ts#y": { ...repo, extra: 1 } }));
    const { bindings, problems } = readLockfile(root);
    expect(bindings).toEqual({});
    expect(problems).toEqual([{ file: LOCKFILE, message: expect.stringContaining("extra") }]);
    expect(problems[0]!.message).not.toContain("\n");
  });
});

describe("diffLockfiles", () => {
  it("says what was bound, rebound and unbound, by key", () => {
    expect(
      diffLockfiles(
        { "resources/a.ts#same": repo, "resources/a.ts#moved": repo, "resources/a.ts#dropped": product },
        {
          "resources/a.ts#same": repo,
          "resources/a.ts#moved": { ...repo, id: "R_2" },
          "resources/a.ts#added": product,
        },
      ),
    ).toEqual([
      { key: "resources/a.ts#added", type: "stripe.product", kind: "bind", to: "prod_1" },
      { key: "resources/a.ts#dropped", type: "stripe.product", kind: "unbind", from: "prod_1" },
      { key: "resources/a.ts#moved", type: "github.repository", kind: "rebind", from: "R_1", to: "R_2" },
    ]);
    expect(diffLockfiles({ "resources/a.ts#x": repo }, { "resources/a.ts#x": repo })).toEqual([]);
  });
});
