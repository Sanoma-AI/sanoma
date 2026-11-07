import { createFileRoute } from "@tanstack/react-router";
import { Link, Outlet } from "sanoma/site";

export const Route = createFileRoute("/sites/members")({ component: Layout });

function Layout() {
  return (
    <section>
      <h2>The members site</h2>
      <Link to="/sites/members/started">Say hello</Link>
      <Outlet />
    </section>
  );
}
