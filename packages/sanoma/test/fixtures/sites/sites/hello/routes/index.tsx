import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/sites/hello/")({ component: Hello });

function Hello() {
  return (
    <div>
      <p>Hello from the hello site</p>
      <Link to="/workflows">Workflows</Link>
    </div>
  );
}
