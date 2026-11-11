import { createFileRoute } from "@tanstack/react-router";
import { Link, Outlet } from "sanoma/site";
import css from "../style.css?url";

export const Route = createFileRoute("/sites/invoicing/invoicing")({
  head: () => ({ links: [{ rel: "stylesheet", href: css }] }),
  component: Layout,
});

function Layout() {
  return (
    <main className="p-4">
      <h1 className="invoice-title text-xl">Invoicing</h1>
      <nav className="flex gap-2">
        <Link to="/sites/invoicing/invoicing">Send</Link>
        <Link to="/sites/invoicing/invoicing/tool">Tool</Link>
        <a href="/workflows">The app</a>
      </nav>
      <Outlet />
    </main>
  );
}
