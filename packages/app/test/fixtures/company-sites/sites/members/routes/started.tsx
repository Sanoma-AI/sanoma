import { createFileRoute } from "@tanstack/react-router";
import { api, errorBodyOf } from "sanoma/site";

/** Starts hello as whoever is asking while the page renders, saying why when it is refused. */
export const Route = createFileRoute("/sites/members/started")({
  loader: async () => {
    try {
      const { runId } = (await api.hello.start({ who: "a member" })) as { runId: string };
      return `Started ${runId}`;
    } catch (err) {
      return `Refused: ${errorBodyOf(err)?.error}`;
    }
  },
  component: Started,
});

function Started() {
  return <p>{Route.useLoaderData()}</p>;
}
