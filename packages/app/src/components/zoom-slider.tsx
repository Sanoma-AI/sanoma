"use client";

import { Maximize, Minus, Plus } from "lucide-react";

import { type FitViewOptions, Panel, useViewport, useStore, useReactFlow, type PanelProps } from "@xyflow/react";

import { Slider } from "#/components/ui/slider.tsx";
import { Button } from "#/components/ui/button.tsx";
import { cn } from "#/lib/utils.ts";

export function ZoomSlider({
  className,
  orientation = "horizontal",
  fitViewOptions,
  duration = 300,
  ...props
}: Omit<PanelProps, "children"> & {
  orientation?: "horizontal" | "vertical";
  /** How the fit button fits the view. */
  fitViewOptions?: FitViewOptions;
  /** How long the buttons' zooms take, in ms. */
  duration?: number;
}) {
  const { zoom } = useViewport();
  const { zoomTo, zoomIn, zoomOut, fitView } = useReactFlow();
  const minZoom = useStore((state) => state.minZoom);
  const maxZoom = useStore((state) => state.maxZoom);

  return (
    <Panel
      className={cn(
        "bg-primary-foreground text-foreground flex gap-1 rounded-md p-1",
        orientation === "horizontal" ? "flex-row" : "flex-col",
        className,
      )}
      {...props}
    >
      <div className={cn("flex gap-1", orientation === "horizontal" ? "flex-row" : "flex-col-reverse")}>
        <Button variant="ghost" size="icon" aria-label="Zoom out" onClick={() => zoomOut({ duration })}>
          <Minus className="h-4 w-4" />
        </Button>
        <Slider
          className={cn(orientation === "horizontal" ? "w-[100px]" : "h-[100px]")}
          orientation={orientation}
          value={[zoom]}
          min={minZoom}
          max={maxZoom}
          step={0.01}
          onValueChange={([value]) => value !== undefined && zoomTo(value)}
        />
        <Button variant="ghost" size="icon" aria-label="Zoom in" onClick={() => zoomIn({ duration })}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <Button
        className={cn("tabular-nums", orientation === "horizontal" ? "w-14" : "h-[40px] w-[40px]")}
        variant="ghost"
        aria-label="Zoom to 100%"
        onClick={() => zoomTo(1, { duration })}
      >
        {(100 * zoom).toFixed(0)}%
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Fit the graph"
        onClick={() => fitView({ ...fitViewOptions, duration })}
      >
        <Maximize className="h-4 w-4" />
      </Button>
    </Panel>
  );
}
