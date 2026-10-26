import { createFileRoute } from "@tanstack/react-router";
import { api } from "sanoma/site";

export const Route = createFileRoute("/sites/crm/pipeline/")({
  loader: () => api.data.crm.customers.list(),
  component: Pipeline,
});

function Pipeline() {
  const customers = Route.useLoaderData();
  return (
    <ul>
      {customers.map((c) => (
        <li key={c.key}>{c.record.name}</li>
      ))}
    </ul>
  );
}
