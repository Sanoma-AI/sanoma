// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, render, screen } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, CompanyState } from "../src/api.ts";
import { DensityProvider } from "../src/components/density.tsx";
import { Bar } from "../src/components/shell/bar.tsx";
import { ChatPromptContext } from "../src/components/shell/chat-prompt.ts";
import { TrialBadge } from "../src/components/shell/trial-badge.tsx";
import { companyStateQuery, configQuery, remoteQuery } from "../src/queries.ts";

// The bar's trial badge, in the bar, over a company's state as the server answers it: what it says
// of a trial with days left, on its last day and once it ended; nothing for a company not on
// Sanoma Cloud (or one the Cloud no longer runs, which the state gives no trial) or a date that is
// none; the same markup from the server and the hydrating browser. No server function is called:
// the trial is the company's state's, which `go-live-cloud.test.ts` reads from the reports.

// The server functions, which only Start's build keeps out of a browser module: the bar's state is given, so none is called.
const called = vi.fn<(name: string) => void>();
vi.mock(
  "../src/functions.ts",
  () =>
    new Proxy(
      {},
      {
        has: () => true,
        get: (_, name) =>
          name === "then"
            ? undefined
            : () => {
                called(String(name));
                return new Promise(() => {});
              },
      },
    ),
);

// A public site's languages, from the build's virtual module, which the bar's tiles read: no site here.
vi.mock("../src/lib/locales.ts", () => ({ siteOf: () => undefined }));
// The sites' icons, which only a company's build makes: no site here.
vi.mock("../src/components/site-icon.tsx", () => ({ SiteIcon: () => null }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A query client that knows the config, the remote and the company's state, its trial ending at `trialEndsAt`. */
function knowing(trialEndsAt: string | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } } });
  const config = { collections: [], policy: { defined: false }, sites: [], databaseHost: "" } as unknown as AppConfig;
  queryClient.setQueryData(configQuery().queryKey, config);
  queryClient.setQueryData(remoteQuery().queryKey, false);
  queryClient.setQueryData(companyStateQuery().queryKey, {
    state: "live",
    draftingCopy: false,
    trialEndsAt,
  } as CompanyState);
  return queryClient;
}

/** Draws the whole bar, at `NOW`, for a company whose trial ends at `trialEndsAt`. */
async function drawBar(trialEndsAt: string | null) {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <Bar /> }),
    history: createMemoryHistory(),
  });
  render(
    <QueryClientProvider client={knowing(trialEndsAt)}>
      <DensityProvider defaultCompact={false}>
        <ChatPromptContext.Provider value={{ open: () => {}, chooseAgent: () => {} }}>
          <RouterProvider router={router} />
        </ChatPromptContext.Provider>
      </DensityProvider>
    </QueryClientProvider>,
  );
  // The bar is there: the company's state, Live.
  expect(await screen.findByText("Live")).toBeTruthy();
}

/** The badge's tip, as its `aria-describedby` names it. */
const tipOf = (badge: HTMLElement) => document.getElementById(badge.getAttribute("aria-describedby")!)?.textContent;

const at = (ms: number) => new Date(ms).toISOString();

describe("the trial badge in the bar", () => {
  it("says the days left, counted in whole 24 hours, and when the trial ends", async () => {
    await drawBar(at(NOW + 4 * DAY + HOUR));
    const badge = await screen.findByText("Free trial · 5 days left");
    expect(tipOf(badge)).toMatch(/^Your free trial ends on .*2026/);
    // The trial is the company's state's: the bar asks nothing more for it (the inbox's count aside).
    expect(new Set(called.mock.calls.flat())).toEqual(new Set(["getRuns"]));
  });

  it("says its last day under 24 hours before it ends, and that it ended once it has", async () => {
    await drawBar(at(NOW + 23 * HOUR));
    expect(await screen.findByText("Free trial · last day")).toBeTruthy();
    cleanup();
    await drawBar(at(NOW - HOUR));
    expect(tipOf(await screen.findByText("Free trial ended"))).toMatch(/^Your free trial ended on /);
  });

  it("shows no trial for a company not on Sanoma Cloud, or one the Cloud no longer runs, nor for a date that is none", async () => {
    for (const trialEndsAt of [null, "", "not a date"]) {
      await drawBar(trialEndsAt);
      expect(screen.queryByText(/Free trial/), String(trialEndsAt)).toBeNull();
      cleanup();
    }
  });
});

describe("the trial badge's markup", () => {
  it("is the same from the server and the hydrating browser, then says the trial", async () => {
    const queryClient = knowing(at(Date.now() + 3 * DAY - HOUR));
    const tree = (
      <QueryClientProvider client={queryClient}>
        <TrialBadge />
      </QueryClientProvider>
    );
    const html = renderToString(tree);
    expect(html).toBe("");
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const mismatch = vi.fn<(error: unknown) => void>();
    await act(async () => {
      hydrateRoot(container, tree, { onRecoverableError: mismatch });
    });
    expect(mismatch).not.toHaveBeenCalled();
    expect(screen.getByText("Free trial · 3 days left")).toBeTruthy();
  });
});
