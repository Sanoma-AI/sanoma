// The packages folded into `sanoma` (sanoma#686), by name: what an import of one is now. Kept out of
// `scripts/one-package-rewrite.ts`'s reach (its SKIP), which reads this table and would rewrite it.

/**
 * Each folded package's name, and the specifier that replaced it: a subpath with a name of its own
 * before its package. `@sanoma-ai/dev` is not here: it was a bin, now `sanoma dev`.
 */
export const FOLDED: readonly (readonly [from: string, to: string])[] = [
  ["@sanoma-ai/app/site", "sanoma/site"],
  ["@sanoma-ai/app/ui.css", "sanoma/ui.css"],
  ["@sanoma-ai/app/ui", "sanoma/ui"],
  ["@sanoma-ai/workflows/resources", "sanoma/resources"],
  ["@sanoma-ai/workflows/data", "sanoma/data"],
  ["@sanoma-ai/workflows/kms-secrets", "sanoma/secrets"],
  ["@sanoma-ai/workflows", "sanoma/workflows"],
  ["@sanoma-ai/app", "sanoma/app"],
  ["@sanoma-ai/testing", "sanoma/testing"],
  ["@sanoma-ai/bridge", "sanoma/internal/bridge"],
  ["@sanoma-ai/connector-better-auth", "sanoma/better-auth"],
];

/** The `sanoma` specifier an import of a folded package is now (`@sanoma-ai/workflows/fake`: `sanoma/workflows/fake`); undefined for any other. */
export function foldedInto(specifier: string): string | undefined {
  for (const [from, to] of FOLDED) {
    if (specifier === from || specifier.startsWith(`${from}/`)) return to + specifier.slice(from.length);
  }
  return undefined;
}
