import { createFileRoute } from "@tanstack/react-router";
import { Region, RunForm } from "sanoma/ui";

export const Route = createFileRoute("/sites/hello/run")({ component: Run });

function Run() {
  return (
    <Region title="Greet someone">
      <RunForm workflow="hello" />
    </Region>
  );
}
