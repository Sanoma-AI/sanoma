import type { ReactNode } from "react";

/**
 * The one layout of a workflow's page's panes: `children` (notices, badges), the graph card, then
 * `primary` and `secondary` side by side, 3 : 2, or one above the other while the pane itself is
 * narrower than `@3xl`. By the pane's own width (a container query), not the
 * screen's: beside the sidebar and the rail a pane is about 480 px wide on a 1024 px screen. Its
 * gaps keep the spacing scale in components/AGENTS.md#layout-conventions.
 */
export function Workbench({
  children,
  graph,
  primary,
  secondary,
}: {
  children?: ReactNode;
  graph: ReactNode;
  primary: ReactNode;
  secondary: ReactNode;
}) {
  return (
    <div className="@container/pane flex flex-col gap-(--gap-region)">
      {children}
      {graph}
      <div className="grid gap-(--gap-region) @3xl/pane:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {primary}
        {secondary}
      </div>
    </div>
  );
}
