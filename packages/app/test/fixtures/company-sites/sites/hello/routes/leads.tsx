import { createFileRoute } from "@tanstack/react-router";
import { api } from "sanoma/site";
import { Greet } from "../components/greet.tsx";

/** The leads, read in the loader as whoever is asking. */
export const Route = createFileRoute("/sites/hello/leads")({
  loader: () => api.data.leads.list(),
  component: Leads,
});

function Leads() {
  return (
    <div>
      <p>{Route.useLoaderData().length} leads</p>
      <Greet who="the leads" />
    </div>
  );
}
