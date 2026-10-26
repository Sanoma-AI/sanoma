import type { ModelContext, SanomaClient } from "@sanoma-ai/workflows";

/**
 * A connector's login or model half's `secrets`: each name's value from this process's
 * environment, which wins, else its stored credential (`SanomaClient.secrets`), which is read only
 * for the names the environment leaves unset, so a key set there needs no database.
 */
export function secretValues(client: SanomaClient): ModelContext["secrets"] {
  return async (names) => {
    const found = new Map<string, string>();
    for (const name of names) {
      const value = process.env[name];
      if (value) found.set(name, value);
    }
    const rest = names.filter((name) => !found.has(name));
    if (rest.length) for (const [name, { value }] of await client.secrets(rest)) found.set(name, value);
    return found;
  };
}
