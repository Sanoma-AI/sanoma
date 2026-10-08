/** Tells the operator something went wrong or was skipped, without failing anything. */
export const warn = (message: string) => console.warn(`sanoma: ${message}`);

/** A value as JSON, or as a string when it isn't JSON, cut to `max` characters, for a message. */
export function shown(value: unknown, max = Number.POSITIVE_INFINITY): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
