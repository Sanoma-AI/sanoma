import { createFileRoute } from "@tanstack/react-router";
import { RunForm } from "sanoma/site";

export const Route = createFileRoute("/sites/invoicing/invoicing/")({ component: Send });

function Send() {
  return <RunForm workflow="invoicing.invoice-send" />;
}
