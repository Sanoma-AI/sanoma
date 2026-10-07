import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { loadActor, type Route, saveActor, useRoute } from "./lib.ts";
import { InboxPage } from "./pages/inbox.tsx";
import { RunPage } from "./pages/run.tsx";
import { RunsPage } from "./pages/runs.tsx";
import { StartPage } from "./pages/start.tsx";
import { WorkflowsPage } from "./pages/workflows.tsx";

function App() {
  const [actor, setActor] = useState(loadActor);
  const route = useRoute();

  if (!actor) {
    return (
      <WhoAreYou
        onName={(name) => {
          saveActor(name);
          setActor(name);
        }}
      />
    );
  }
  return (
    <>
      <nav className="top">
        <a className="brand" href="#/runs">
          Sanoma
        </a>
        <NavLink route={route} page="runs" href="#/runs" label="Runs" />
        <NavLink route={route} page="inbox" href="#/inbox" label="Inbox" />
        <NavLink route={route} page="start" href="#/start" label="Start" />
        <NavLink route={route} page="workflows" href="#/workflows" label="Workflows" />
        <span className="who">
          You are <strong>{actor}</strong>{" "}
          <button
            type="button"
            className="link"
            onClick={() => {
              saveActor(undefined);
              setActor(undefined);
            }}
          >
            change
          </button>
        </span>
      </nav>
      <main>
        <Page route={route} actor={actor} />
      </main>
    </>
  );
}

function Page({ route, actor }: { route: Route; actor: string }) {
  switch (route.page) {
    case "runs":
      return <RunsPage />;
    case "run":
      return <RunPage key={route.id} id={route.id} />;
    case "inbox":
      return <InboxPage actor={actor} />;
    case "start":
      return <StartPage workflow={route.workflow} />;
    case "workflows":
      return <WorkflowsPage />;
  }
}

function NavLink({ route, page, href, label }: { route: Route; page: Route["page"]; href: string; label: string }) {
  const current = route.page === page || (page === "runs" && route.page === "run");
  return (
    <a href={href} aria-current={current ? "page" : undefined}>
      {label}
    </a>
  );
}

/** There is no login. The name is kept in this browser and sent with every request. */
function WhoAreYou({ onName }: { onName: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <main className="who-are-you">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onName(name.trim());
        }}
      >
        <h1>Who are you?</h1>
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
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("The page has no #root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
