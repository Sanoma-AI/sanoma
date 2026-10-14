import { type Exchange, type ReplayOptions } from "@sanoma/testing/replay";

// How Ghost's recorded replies are replayed (and recorded): the driver's tests and the features share it.

export const SITE = "https://blog.example.test";
export const ADMIN = "/ghost/api/admin";
/** A made-up key: the recorded replies need none, but it signs the tokens the tests check. */
export const TEST_KEY = `${"a1".repeat(12)}:${"b2".repeat(32)}`;

// What a fixture keeps of Ghost's replies: no authors, emails, tiers or settings.
const POST_FIELDS = [
  "id",
  "uuid",
  "title",
  "slug",
  "html",
  "status",
  "url",
  "created_at",
  "updated_at",
  "published_at",
];
const ERROR_FIELDS = ["message", "context", "type", "code", "id"];
const pick = (o: Record<string, unknown>, fields: string[]) =>
  Object.fromEntries(fields.filter((f) => f in o).map((f) => [f, o[f]]));

/** Replaces each distinct string it is given with `make(1)`, `make(2)`, ... in order of appearance. */
const renumber = (make: (n: number) => string) => {
  const seen = new Map<string, string>();
  return (real: string) => {
    if (!seen.has(real)) seen.set(real, make(seen.size + 1));
    return seen.get(real)!;
  };
};

/** Keeps the fields above, puts every URL on SITE, and numbers the ids and uuids in order of appearance. */
function scrub(exchanges: Exchange[]): Exchange[] {
  const trimmed = exchanges.map((e) => {
    const body = e.body as { posts?: Record<string, unknown>[]; errors?: Record<string, unknown>[] } | null;
    if (body?.posts) return { ...e, body: { posts: body.posts.map((p) => pick(p, POST_FIELDS)) } };
    if (body?.errors) return { ...e, body: { errors: body.errors.map((x) => pick(x, ERROR_FIELDS)) } };
    return e;
  });
  return JSON.parse(
    JSON.stringify(trimmed)
      .replace(/https?:\/\/[^/"\s]+/g, SITE)
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        renumber((n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`),
      )
      .replace(
        /\b[0-9a-f]{24}\b/g,
        renumber((n) => String(n).padStart(24, "0")),
      ),
  );
}

export const replayOptions: ReplayOptions = {
  fixtures: new URL("./fixtures/", import.meta.url),
  needs: ["GHOST_ADMIN_URL", "GHOST_ADMIN_API_KEY"],
  env: { GHOST_ADMIN_URL: SITE, GHOST_ADMIN_API_KEY: TEST_KEY },
  scrub,
};
