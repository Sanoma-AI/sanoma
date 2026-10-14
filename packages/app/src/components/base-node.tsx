import type { ComponentProps } from "react";

import { cn } from "#/lib/utils.ts";

/**
 * A graph node's box: React Flow UI's BaseNode, edited to the app's node. Rounder, without its
 * hover ring or its own tab stop (React Flow's node around it takes focus, named), and ringed when
 * React Flow's wrapper has the `selected` class, keeping its border so a tone stays visible.
 */
export function BaseNode({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card text-card-foreground in-[.selected]:ring-2 in-[.selected]:ring-ring",
        className,
      )}
      {...props}
    />
  );
}
