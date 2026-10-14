import type { ComponentProps } from "react";

import { cn } from "#/lib/utils.ts";

/**
 * A graph node's box: React Flow UI's BaseNode, edited to the app's node. Rounder, without its
 * hover ring or its own tab stop (React Flow's node around it takes focus, named), and ringed when
 * React Flow's node wrapper is selected, keeping its border so a tone stays visible.
 */
export function BaseNode({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card text-card-foreground [.react-flow\\_\\_node.selected_&]:ring-2 [.react-flow\\_\\_node.selected_&]:ring-ring",
        className,
      )}
      {...props}
    />
  );
}
