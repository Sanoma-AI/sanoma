import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { configQuery, workflowNamed } from "#/queries.ts";

// A workflow's runs start from its New run pane now; this keeps old links and bookmarks working.
export const Route = createFileRoute("/start")({
  validateSearch: z.object({ workflow: z.string().optional().catch(undefined) }),
  beforeLoad: async ({ context: { queryClient }, search }) => {
    const config = await queryClient.query({ ...configQuery(), staleTime: "static" });
    const workflow = search.workflow === undefined ? undefined : workflowNamed(search.workflow)(config);
    if (workflow) throw redirect({ to: "/workflows/$name/new", params: { name: workflow.name } });
    throw redirect({ to: "/workflows" });
  },
});
