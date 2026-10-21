import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/sites/hello")({ component: Layout });

function Layout() {
  return (
    <section>
      <h2>The hello site</h2>
      <Outlet />
    </section>
  );
}
