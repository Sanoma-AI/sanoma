import { createFileRoute } from "@tanstack/react-router";
import { api, errorBodyOf } from "sanoma/site";

/** Starts hello as whoever is on the page while it renders: its loader calls `api`. */
export const Route = createFileRoute("/sites/account/started")({
  loader: async () => {
    try {
      return `Started ${(await api.hello.start({ who: "the account site" })).runId}`;
    } catch (err) {
      const refused = errorBodyOf(err)?.code;
      if (!refused) throw err;
      return `Refused: ${refused}`;
    }
  },
  component: Started,
});

function Started() {
  return <p>{Route.useLoaderData()}</p>;
}
