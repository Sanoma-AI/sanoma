import { createFileRoute, Outlet } from "@tanstack/react-router";

// A public site gives its own title and icon: on its host the app's root gives none.
export const Route = createFileRoute("/sites/hello")({
  head: () => ({ meta: [{ title: "Hello" }], links: [{ rel: "icon", href: "data:," }] }),
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
