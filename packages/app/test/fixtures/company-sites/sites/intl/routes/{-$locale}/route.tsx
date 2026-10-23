import { createFileRoute } from "@tanstack/react-router";
import { Outlet } from "sanoma/site";
import { Switcher } from "../../components/switcher.tsx";

export const Route = createFileRoute("/sites/intl/{-$locale}")({ component: Layout });

function Layout() {
  return (
    <>
      <Switcher />
      <Outlet />
    </>
  );
}
