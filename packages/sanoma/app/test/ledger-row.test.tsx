// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { LedgerRecord } from "sanoma/workflows";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LedgerRow } from "../src/components/ledger.tsx";
import { configQuery } from "../src/queries.ts";

// A run's ledger row as its page draws it: no server, the config in the query cache.

// The server functions, which only Start's build keeps out of a browser module: the row calls none.
vi.mock("../src/functions.ts", () => ({}));
// A public site's languages, from the build's virtual module: no site here.
vi.mock("../src/lib/locales.ts", () => ({}));

afterEach(cleanup);

const finished: LedgerRecord = {
  v: 1,
  app: "acme",
  id: "run:run.finished:1",
  runId: "run",
  seq: 1,
  at: 0,
  actor: { id: "ada" },
  workflow: "box",
  type: "run.finished",
  output: { url: "<url>", expiresAt: "2026-11-25T13:00:00Z" },
};

describe("a finished run's ledger row", () => {
  it("shows a workflow's opaque output field as redacted, as an operation's", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(configQuery().queryKey, { ops: [], vendors: {} } as never);
    render(
      <QueryClientProvider client={queryClient}>
        <LedgerRow record={finished} titles={new Map()} anchor={false} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Output" }));
    const shown = (await screen.findByText(/expiresAt/)).closest("pre")!;
    expect(shown.textContent).toContain('"url": redacted');
    expect(shown.textContent).not.toContain("<url>");
    expect(shown.textContent).toContain('"expiresAt": "2026-11-25T13:00:00Z"');
  });
});
