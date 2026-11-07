/**
 * A time as UTC text, `2026-10-09 08:30 UTC`, with seconds when asked. The same on the server
 * and in any browser, so a page hydrates the markup it was sent; the ledger and the graph show
 * times this way.
 */
export const utcText = (at: number, { seconds = false }: { seconds?: boolean } = {}): string =>
  `${new Date(at)
    .toISOString()
    .slice(0, seconds ? 19 : 16)
    .replace("T", " ")} UTC`;
