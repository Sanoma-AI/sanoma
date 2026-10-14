import { type FitViewOptions, Panel, type PanelProps, useReactFlow, useStore } from "@xyflow/react";
import { MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react";
import { Slider } from "#/components/ui/slider.tsx";
import { TipButton } from "./common.tsx";

/**
 * Adapted from React Flow UI's ZoomSlider, horizontal only: zoom out, a slider, zoom in, the zoom
 * as a percentage (a click goes to 100%), and fit.
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
  const percent = `${(100 * zoom).toFixed(0)}%`;

  return (
    <Panel className="flex gap-1 rounded-md border bg-card p-1 text-card-foreground" {...props}>
      <TipButton tip="Zoom out" onClick={() => zoomOut({ duration })}>
        <MinusIcon />
      </TipButton>
      <div className="flex w-[100px] items-center">
        <Slider
          value={[zoom]}
          min={minZoom}
          max={maxZoom}
          step={0.01}
          onValueChange={(value) => zoomTo(Array.isArray(value) ? value[0]! : value)}
          getAriaLabel={() => "Zoom"}
        />
      </div>
      <TipButton tip="Zoom in" onClick={() => zoomIn({ duration })}>
        <PlusIcon />
      </TipButton>
      {/* Named by what it shows, then what it does. A minimum width, not a fixed one: Compact's
          smaller unit would leave "150%" too little room. */}
      <TipButton
        tip="Zoom to 100%"
        label={`${percent}, zoom to 100%`}
        size="default"
        className="min-w-14 tabular-nums"
        onClick={() => zoomTo(1, { duration })}
      >
        {percent}
      </TipButton>
      <TipButton tip="Fit the graph" onClick={() => fitView({ ...fitViewOptions, duration })}>
        <MaximizeIcon />
      </TipButton>
    </Panel>
  );
}
