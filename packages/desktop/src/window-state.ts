/** A window's place on the screen, as Electron gives it (`getNormalBounds`) and takes it. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A company window's size the first time, or when its saved place is on no display now. */
export const DEFAULT_SIZE = { width: 1280, height: 840 };

/** How much of a window must be on a display for it to open there: enough to grab and move it. */
const MIN_VISIBLE = 64;

export const isRect = (value: unknown): value is Rect => {
  const r = value as Rect;
  return (
    typeof r === "object" &&
    r !== null &&
    [r.x, r.y, r.width, r.height].every(Number.isInteger) &&
    r.width > 0 &&
    r.height > 0
  );
};

/** How far two spans `[a, a + al)` and `[b, b + bl)` overlap. */
const overlap = (a: number, al: number, b: number, bl: number) =>
  Math.max(0, Math.min(a + al, b + bl) - Math.max(a, b));

/**
 * Where a company's window opens: at its saved bounds while at least `MIN_VISIBLE` pixels of them
 * each way are on one of the displays' `workAreas` now (a display unplugged since moves it), no
 * larger than that display; else at the default size, which Electron centres.
 */
export function windowBounds(saved: Rect | undefined, workAreas: readonly Rect[]): Partial<Rect> & typeof DEFAULT_SIZE {
  if (!saved) return DEFAULT_SIZE;
  const area = workAreas.find(
    (a) =>
      overlap(saved.x, saved.width, a.x, a.width) >= MIN_VISIBLE &&
      overlap(saved.y, saved.height, a.y, a.height) >= MIN_VISIBLE,
  );
  if (!area) return DEFAULT_SIZE;
  return { ...saved, width: Math.min(saved.width, area.width), height: Math.min(saved.height, area.height) };
}
