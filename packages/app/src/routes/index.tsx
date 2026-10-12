import { createFileRoute, redirect } from "@tanstack/react-router";

// The app opens on its workflows; old links and bookmarks to / land there too.
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/workflows" });
  },
});
