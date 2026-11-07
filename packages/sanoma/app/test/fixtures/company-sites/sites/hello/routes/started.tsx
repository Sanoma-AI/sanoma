import { createFileRoute } from "@tanstack/react-router";
import { api, errorBodyOf } from "sanoma/site";

/** Starts hello as whoever is asking while the page renders: its loader calls `api`. */
export const Route = createFileRoute("/sites/hello/started")({
  loader: async () => {
    try {
      const { runId } = (await api.hello.start({ who: "the site" })) as { runId: string };
      return `Started ${runId}`;
    } catch (err) {
      return `Refused: ${errorBodyOf(err)?.code}`;
    }
  },
  component: Started,
});

function Started() {
  return <p>{Route.useLoaderData()}</p>;
}
