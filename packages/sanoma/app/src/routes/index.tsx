import { createFileRoute } from "@tanstack/react-router";
import { pageTitle } from "../components/common.tsx";
import { Home } from "../components/home.tsx";
import { recentRunsQuery, setupProgressQuery, waitingRunsQuery } from "../queries.ts";

// The app opens on Home: setting the company up, what waits on you, and what ran lately.
export const Route = createFileRoute("/")({
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.query({ ...waitingRunsQuery(), staleTime: "static" }),
      queryClient.query({ ...recentRunsQuery(), staleTime: "static" }),
      // The setup card's facts: a failed read leaves the card out, never the page.
      queryClient.query({ ...setupProgressQuery(), staleTime: "static" }).catch(() => {}),
    ]);
  },
  staticData: { crumb: "Home" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
  component: Home,
});
