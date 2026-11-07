import { createFileRoute } from "@tanstack/react-router";
import { Link, Outlet } from "sanoma/site";

export const Route = createFileRoute("/sites/hello")({ component: Layout });

function Layout() {
  return (
    <section>
      <h2>The hello site</h2>
      <Link to="/sites/hello">Home</Link>
      <Outlet />
    </section>
  );
}
