// An import of a package folded into `sanoma` (sanoma#686) fails loudly in the loader, naming what it
// is now. This file names the old packages, so scripts/one-package-rewrite.ts leaves it alone (SKIP).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { foldedInto } from "../src/folded.ts";
import { loadModules } from "../src/load.ts";
import { peopleConnector } from "../src/person.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function company(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sanoma-folded-")));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

describe("foldedInto", () => {
  it("names the sanoma specifier of a folded package's entry, its own name before its package's", () => {
    expect(foldedInto("@sanoma-ai/workflows/resources")).toBe("sanoma/resources");
    expect(foldedInto("@sanoma-ai/workflows/kms-secrets")).toBe("sanoma/secrets");
    expect(foldedInto("@sanoma-ai/workflows/fake")).toBe("sanoma/workflows/fake");
    expect(foldedInto("@sanoma-ai/app/ui.css")).toBe("sanoma/ui.css");
    expect(foldedInto("@sanoma-ai/bridge/fake")).toBe("sanoma/internal/bridge/fake");
    expect(foldedInto("@sanoma-ai/connector-better-auth")).toBe("sanoma/better-auth");
    expect(foldedInto("@sanoma-ai/workflows-extra")).toBeUndefined();
    expect(foldedInto("@sanoma-ai/connector-github/resources")).toBeUndefined();
  });
});

describe("loadModules", () => {
  it("refuses an import of a folded package, naming its sanoma specifier, rather than leave its people out", () => {
    const root = company({
      "resources/people.ts": `import { sanoma } from "@sanoma-ai/workflows/resources";\nexport const ada = sanoma.person({ id: "ada" });\n`,
      "resources/data.ts": `import { collection } from "@sanoma-ai/workflows/data";\nexport const leads = collection({ name: "leads", key: "email", fields: { email: "text" } });\n`,
    });
    const loaded = loadModules(
      root,
      ["resources/people.ts", "resources/data.ts"].map((rel) => join(root, rel)),
      [peopleConnector],
    );
    const errorOf = (rel: string) => {
      const l = loaded.get(rel);
      return l && "error" in l ? String((l.error as Error).message) : JSON.stringify(l);
    };
    expect(errorOf("resources/people.ts")).toContain(
      '"@sanoma-ai/workflows/resources" is "sanoma/resources" now: sanoma\'s packages are the one `sanoma`',
    );
    expect(errorOf("resources/people.ts")).toContain("scripts/one-package-rewrite.ts");
    expect(errorOf("resources/data.ts")).toContain('"@sanoma-ai/workflows/data" is "sanoma/data" now');
  });
});
