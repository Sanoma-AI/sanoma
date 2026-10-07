import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { ActorContext, useActor, useActorState } from "../actor.ts";
import { Notice } from "../components/common.tsx";
import css from "../style.css?url";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "color-scheme", content: "light dark" },
      { title: "Sanoma" },
    ],
    links: [{ rel: "stylesheet", href: css }],
  }),
  // Pages show what is happening now: never cache them.
  headers: () => ({ "cache-control": "no-store" }),
  component: Root,
  notFoundComponent: () => <Notice tone="bad">There is no page here.</Notice>,
  errorComponent: ({ error }) => (
    <Notice tone="bad">Something went wrong: {error instanceof Error ? error.message : String(error)}</Notice>
  ),
});

function Root() {
  const actor = useActorState();
  return (
    <Document>
      <ActorContext value={actor}>
        <div id="app">
          <Nav />
          <main>
            <Outlet />
          </main>
          {actor.actor === null && <WhoAreYou />}
        </div>
      </ActorContext>
    </Document>
  );
}

function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function Nav() {
  const { actor, setActor } = useActor();
  return (
    <nav className="top">
      <Link className="brand" to="/runs">
        Sanoma
      </Link>
      <Link to="/runs">Runs</Link>
      <Link to="/inbox">Inbox</Link>
      <Link to="/start">Start</Link>
      <Link to="/workflows">Workflows</Link>
      {actor && (
        <span className="who">
          You are <strong>{actor}</strong>{" "}
          <button type="button" className="link" onClick={() => setActor(null)}>
            change
          </button>
        </span>
      )}
    </nav>
  );
}

/** There is no login. The name is kept in this browser and sent with every change. */
function WhoAreYou() {
  const { setActor } = useActor();
  const [name, setName] = useState("");
  return (
    <div className="who-are-you" role="dialog" aria-modal="true" aria-labelledby="who-title">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) setActor(name.trim());
        }}
      >
        <h1 id="who-title">Who are you?</h1>
        <p className="muted">
          Runs you start and approvals you decide are recorded under this name. Use the name approvals ask for, such as{" "}
          <code>marketing-lead</code>. There is no login: this is a local tool.
        </p>
        <input
          type="text"
          aria-label="Your name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
        />
        <button type="submit" className="primary" disabled={!name.trim()}>
          Continue
        </button>
      </form>
    </div>
  );
}
