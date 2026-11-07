import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Link, siteUrl } from "sanoma/site";

export const Route = createFileRoute("/sites/hello/")({
  head: ({ match }) => ({ links: [{ rel: "canonical", href: siteUrl(match.pathname) }] }),
  component: Hello,
});

function Hello() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <p>Hello from the hello site</p>
      <button type="button" onClick={() => setCount(count + 1)}>
        Clicked {count}
      </button>
      <Link to="/workflows">Workflows</Link>
      <Link to="/sites/hello/run">Greet someone</Link>
    </div>
  );
}
