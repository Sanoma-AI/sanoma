import { createFileRoute } from "@tanstack/react-router";
import { RunForm } from "sanoma/site";
import { Region } from "sanoma/ui";

export const Route = createFileRoute("/sites/hello/run")({ component: Run });

function Run() {
  return (
    <Region title="Greet someone">
      <RunForm workflow="hello" />
    </Region>
  );
}
