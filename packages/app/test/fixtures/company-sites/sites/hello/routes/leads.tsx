import { createFileRoute } from "@tanstack/react-router";
import { api } from "sanoma/site";
import { Greet } from "../components/greet.tsx";

/** How many leads there are, read in the loader as whoever is asking. */
export const Route = createFileRoute("/sites/hello/leads")({
  loader: async () => {
    const leads: unknown[] = await api.data.leads.list();
    return leads.length;
  },
  component: Leads,
});

function Leads() {
  return (
    <div>
      <p>{Route.useLoaderData()} leads</p>
      <Greet who="the leads" />
    </div>
  );
}
