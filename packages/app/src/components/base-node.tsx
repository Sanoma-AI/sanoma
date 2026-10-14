import type { ComponentProps } from "react";

import { cn } from "#/lib/utils.ts";

/**
 * A graph node's box: React Flow UI's BaseNode, edited to the app's node. Rounder, without its
 * hover ring, its own tab stop (React Flow's node around it takes focus, named) or its selected
 * look (`graph.tsx` rings a selected node, keeping its border so a tone stays visible).
 */
export function BaseNode({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-lg border bg-card text-card-foreground", className)} {...props} />;
}
