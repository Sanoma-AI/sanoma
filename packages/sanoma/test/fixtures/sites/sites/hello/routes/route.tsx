import { createFileRoute, Outlet } from "@tanstack/react-router";
import css from "../style.css?url";

export const Route = createFileRoute("/sites/hello")({
  head: () => ({ links: [{ rel: "stylesheet", href: css }] }),
  component: Layout,
});

function Layout() {
  return (
    <section>
      <h2>The hello site</h2>
      <Outlet />
    </section>
  );
}
