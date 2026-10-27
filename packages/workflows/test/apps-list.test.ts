import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { APP_TOPIC, availableApps, GITHUB_API } from "../src/apps-list.ts";
import { appTier, type Claims, claims, connectorTier } from "../src/claims.ts";
import { describeConfig } from "../src/describe.ts";
import { resolveConfig } from "../src/index.ts";
import { APPS_LIST } from "../src/shared.ts";

// The listing of apps (`sanoma.apps.list`): GitHub's search for the topic, mocked, joined with
// Sanoma's claims; and the claims file itself.

const repo = (full_name: string, more: object = {}) => ({
  full_name,
  html_url: `https://github.com/${full_name}`,
  description: null,
  license: null,
  ...more,
});

/** GitHub's search answer: Sanoma's portal, a claimed CRM, a community app, and two it describes otherwise. */
const FOUND = [
  repo("someone/inventory", { license: { spdx_id: "NOASSERTION" } }),
  repo("acme/crm", { description: "Contacts and deals", license: { spdx_id: "Apache-2.0" } }),
  repo("Sanoma-AI/tenant-portal", { description: "Requests from tenants", license: { spdx_id: "MIT" } }),
  { ...repo("evil/app"), html_url: "https://evil.example/app" },
  { full_name: "no-url/app" },
];

/** Claims naming the CRM (with the case GitHub ignores), in a solution with a demo running and one that is gone. */
const CLAIMS: Claims = {
  connectors: { "sanoma-connector-acme": { tier: "vendor-verified", reviewed: true } },
  apps: {
    "Acme/CRM": { tier: "vendor-verified", reviewed: true, blocked: ["0123abcd"], solutions: ["contractors", "gone"] },
  },
  solutions: {
    contractors: {
      title: "General contractors",
      kind: "contractors",
      apps: ["Acme/CRM"],
      demo: { repo: "Sanoma-AI/demo-contractors", url: "https://contractors.demo.example/" },
    },
  },
};

let searched: URL | undefined;
let headers: Headers | undefined;
const github = setupServer(
  http.get(`${GITHUB_API}/search/repositories`, ({ request }) => {
    searched = new URL(request.url);
    headers = request.headers;
    return HttpResponse.json({ total_count: FOUND.length, items: FOUND });
  }),
);
beforeAll(() => github.listen({ onUnhandledFrame: "error" }));
afterEach(() => github.resetHandlers());
afterAll(() => github.close());

describe("sanoma.apps.list", () => {
  it("lists GitHub's repositories with the topic, joined with the claims, Sanoma's first", async () => {
    expect(await availableApps(CLAIMS)).toEqual({
      apps: [
        {
          repo: "Sanoma-AI/tenant-portal",
          url: "https://github.com/Sanoma-AI/tenant-portal",
          description: "Requests from tenants",
          license: "MIT",
          tier: "official",
          reviewed: false,
          solutions: [],
        },
        {
          repo: "acme/crm",
          url: "https://github.com/acme/crm",
          description: "Contacts and deals",
          license: "Apache-2.0",
          tier: "vendor-verified",
          reviewed: true,
          blocked: ["0123abcd"],
          solutions: [{ id: "contractors", title: "General contractors", demo: "https://contractors.demo.example/" }],
        },
        {
          repo: "someone/inventory",
          url: "https://github.com/someone/inventory",
          tier: "community",
          reviewed: false,
          solutions: [],
        },
      ],
    });
    expect(searched?.searchParams.get("q")).toBe(`topic:${APP_TOPIC} archived:false`);
    expect(headers?.get("accept")).toBe("application/vnd.github+json");
    expect(headers?.get("authorization")).toBeNull();
  });

  it("says why when GitHub cannot be searched, and lists nothing", async () => {
    github.use(http.get(`${GITHUB_API}/search/repositories`, () => new HttpResponse(null, { status: 403 })));
    expect(await availableApps(CLAIMS)).toEqual({
      apps: [],
      error: "Could not search GitHub: api.github.com answered 403 to /search/repositories",
    });
    github.use(http.get(`${GITHUB_API}/search/repositories`, () => HttpResponse.error()));
    expect(await availableApps(CLAIMS)).toMatchObject({
      apps: [],
      error: expect.stringMatching(/^Could not search GitHub: /),
    });
  });

  it("is a built-in read in every config, which a page may call directly", () => {
    const resolved = resolveConfig({ connectors: [] });
    expect(resolved.ops.get(APPS_LIST)?.effect).toBe("read");
    expect(resolved.drivers.has(APPS_LIST)).toBe(true);
    const entry = describeConfig({ connectors: [] }).ops.find((op) => op.id === APPS_LIST);
    expect(entry).toMatchObject({ vendor: "sanoma", effect: "read", direct: true });
  });
});

/** Names as GitHub matches them, ignoring case. */
const lower = (keys: readonly string[]) => keys.map((key) => key.toLowerCase());

describe("the claims", () => {
  it("read a tier from the claims, else from the name", () => {
    expect(connectorTier("sanoma-connector-acme", CLAIMS)).toBe("vendor-verified");
    expect(connectorTier("@sanoma-ai/connector-ghost", CLAIMS)).toBe("official");
    expect(connectorTier("sanoma-connector-widgets", CLAIMS)).toBe("community");
    expect(appTier("acme/crm", CLAIMS)).toBe("vendor-verified");
    expect(appTier("sanoma-ai/tenant-portal", CLAIMS)).toBe("official");
    expect(appTier("someone/inventory", CLAIMS)).toBe("community");
  });

  it("name each app and solution both ways, each repository as `<owner>/<repo>`", () => {
    const REPO = /^[\w.-]+\/[\w.-]+$/;
    const apps = lower(Object.keys(claims.apps));
    for (const key of apps) expect(key).toMatch(REPO);
    for (const [id, app] of Object.entries(claims.apps)) {
      for (const solution of app.solutions) {
        expect(lower(claims.solutions[solution]?.apps ?? []), `${solution} names ${id}`).toContain(id.toLowerCase());
      }
    }
    for (const [id, solution] of Object.entries(claims.solutions)) {
      expect(solution.demo.repo).toMatch(REPO);
      for (const app of solution.apps) {
        const claim = Object.entries(claims.apps).find(([key]) => key.toLowerCase() === app.toLowerCase())?.[1];
        expect(claim?.solutions, `${app} names ${id}`).toContain(id);
      }
    }
  });
});
