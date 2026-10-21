import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/sites/hello/")({ component: Hello });

function Hello() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <p>Hello from the hello site</p>
      <button type="button" onClick={() => setCount(count + 1)}>
        Clicked {count}
      </button>
      <Link to="/workflows">Workflows</Link>
    </div>
  );
}
