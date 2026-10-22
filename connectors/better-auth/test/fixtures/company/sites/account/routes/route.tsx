import { Region } from "@sanoma-ai/app/ui";
import { createFileRoute } from "@tanstack/react-router";
import { Outlet } from "sanoma/site";

export const Route = createFileRoute("/sites/account")({ component: Layout });

function Layout() {
  return (
    <Region title="Account">
      <Outlet />
    </Region>
  );
}
