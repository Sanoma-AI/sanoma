import { createFileRoute } from "@tanstack/react-router";
import { json } from "../../server/core.ts";

// Any other /api path answers with a JSON 404 rather than the page.
const notFound = ({ request }: { request: Request }) =>
  json({ error: `No API route ${request.method} ${new URL(request.url).pathname}` }, 404);

export const Route = createFileRoute("/api/$")({
  server: { handlers: { GET: notFound, POST: notFound, PUT: notFound, PATCH: notFound, DELETE: notFound } },
});
