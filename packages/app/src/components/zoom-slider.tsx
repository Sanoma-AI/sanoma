import { type FitViewOptions, Panel, type PanelProps, useReactFlow, useStore } from "@xyflow/react";
import { MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react";
import { Slider as SliderPrimitive } from "radix-ui";
import { Button } from "#/components/ui/button.tsx";

/**
 * React Flow's zoom controls, from the shadcn registry's zoom slider, horizontal only: zoom out,
 * a slider, zoom in, the zoom as a percentage (a click goes to 100%), and fit.
 */
export function ZoomSlider({
  fitViewOptions,
  duration = 300,
  ...props
}: Omit<PanelProps, "children" | "className"> & {
  /** How the fit button fits the view. */
  fitViewOptions?: FitViewOptions;
  /** How long the buttons' zooms take, in ms. */
  duration?: number;
}) {
  // The zoom alone, so a pan does not render this again.
  const zoom = useStore((state) => state.transform[2]);
  const minZoom = useStore((state) => state.minZoom);
  const maxZoom = useStore((state) => state.maxZoom);
  const { zoomTo, zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <Panel className="flex gap-1 rounded-md border bg-card p-1 text-card-foreground" {...props}>
      <Button variant="ghost" size="icon" aria-label="Zoom out" onClick={() => zoomOut({ duration })}>
        <MinusIcon />
      </Button>
      {/* ui/slider.tsx's markup and classes, which give its thumb no name: this one is "Zoom". */}
      <SliderPrimitive.Root
        className="relative flex w-[100px] touch-none items-center select-none"
        value={[zoom]}
        min={minZoom}
        max={maxZoom}
        step={0.01}
        onValueChange={([value]) => value !== undefined && zoomTo(value)}
      >
        <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-muted">
          <SliderPrimitive.Range className="absolute h-full bg-primary select-none" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          aria-label="Zoom"
          className="relative block size-3 shrink-0 rounded-full border border-ring bg-white ring-ring/50 transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 disabled:pointer-events-none disabled:opacity-50"
        />
      </SliderPrimitive.Root>
      <Button variant="ghost" size="icon" aria-label="Zoom in" onClick={() => zoomIn({ duration })}>
        <PlusIcon />
      </Button>
      <Button
        variant="ghost"
        className="w-14 tabular-nums"
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
        <MaximizeIcon />
      </Button>
    </Panel>
  );
}
