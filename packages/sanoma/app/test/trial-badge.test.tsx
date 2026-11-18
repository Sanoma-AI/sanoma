// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudTrial, CompanyState } from "../src/api.ts";
import { TrialBadge } from "../src/components/shell/trial-badge.tsx";
import { companyStateQuery } from "../src/queries.ts";

// The bar's trial badge over a stubbed `getCloudTrial`: what it says of a trial with days left, on
// its last day and once it ended, and that it shows nothing, asking nothing, for a company not on
// Sanoma Cloud, and nothing when the trial cannot be read. The server's side, `cloudTrial`, is
// `go-live-cloud.test.ts`'s.

const getCloudTrial = vi.fn<() => Promise<CloudTrial | null>>();

// The server functions, which only Start's build keeps out of a browser module: the badge calls `getCloudTrial` alone.
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
            : name === "getCloudTrial"
              ? () => getCloudTrial()
              : () => {
                  throw new Error(`The badge called ${String(name)}`);
                },
      },
    ),
);

afterEach(() => {
  cleanup();
  getCloudTrial.mockReset();
});

/** Draws the badge for a company whose state says it is live on Sanoma Cloud or not. */
function draw(onCloud: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  });
  queryClient.setQueryData(companyStateQuery().queryKey, { onCloud } as CompanyState);
  return render(
    <QueryClientProvider client={queryClient}>
      <TrialBadge />
      <p>The bar</p>
    </QueryClientProvider>,
  );
}

const ENDS = "2026-11-25T12:00:00.000Z";

describe("the trial badge", () => {
  it("says the days left in a Cloud company's free trial, and when it ends", async () => {
    getCloudTrial.mockResolvedValue({ endsAt: ENDS, daysLeft: 5 });
    draw(true);
    const badge = await screen.findByText("Free trial · 5 days left");
    expect(badge.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(badge.getAttribute("aria-describedby")!)?.textContent).toMatch(
      /^Your free trial ends on .*2026/,
    );
  });

  it("says its last day, and that it ended", async () => {
    getCloudTrial.mockResolvedValue({ endsAt: ENDS, daysLeft: 1 });
    draw(true);
    expect(await screen.findByText("Free trial · last day")).toBeTruthy();
    cleanup();
    getCloudTrial.mockResolvedValue({ endsAt: ENDS, daysLeft: 0 });
    draw(true);
    const badge = await screen.findByText("Free trial ended");
    expect(document.getElementById(badge.getAttribute("aria-describedby")!)?.textContent).toMatch(
      /^Your free trial ended on /,
    );
  });

  it("shows nothing, and asks nothing, for a company not on Sanoma Cloud", async () => {
    getCloudTrial.mockResolvedValue({ endsAt: ENDS, daysLeft: 5 });
    draw(false);
    expect(await screen.findByText("The bar")).toBeTruthy();
    expect(screen.queryByText(/Free trial/)).toBeNull();
    expect(getCloudTrial).not.toHaveBeenCalled();
  });

  it("shows nothing when the trial cannot be read, and the bar stays", async () => {
    // The server's answer while the Cloud cannot be reached, then the server function itself failing.
    getCloudTrial.mockResolvedValue(null);
    draw(true);
    await waitFor(() => expect(getCloudTrial).toHaveBeenCalled());
    expect(screen.getByText("The bar")).toBeTruthy();
    expect(screen.queryByText(/Free trial/)).toBeNull();
    cleanup();
    getCloudTrial.mockRejectedValue(new Error("fetch failed"));
    draw(true);
    await waitFor(() => expect(getCloudTrial).toHaveBeenCalledTimes(2));
    expect(screen.getByText("The bar")).toBeTruthy();
    expect(screen.queryByText(/Free trial/)).toBeNull();
  });
});
