// The company template's files with a company's own declared in them, text in and text out:
// `sanoma init` applies them to the files it copies, and a workflow can apply them to a
// repository's files (`github.repository.files`) before committing them back. Browser-safe.

/** Who starts the company: the first person `resources/people.ts` declares. */
export interface Creator {
  id: string;
  name?: string;
  github?: string;
  /** Their email: what the staff login sends a sign-in code to, and an invite is for, on a host. */
  email?: string;
}

/** The template's founder, `export const founder = sanoma.person(…)`, which `sanoma init` declares as the creator. */
const FOUNDER = /^export const founder = sanoma\.person\(.*\);$/m;

/** The people file with its founder declared as `creator`. */
export function declareFounder(text: string, creator: Creator): string {
  const fields = Object.entries(creator)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  if (!FOUNDER.test(text)) throw new Error("the template's resources/people.ts declares no `founder`");
  // A replacer, so a `$` in a name is kept as written.
  return text.replace(FOUNDER, () => `export const founder = sanoma.person({ ${fields.join(", ")} });`);
}

/** Where the template declares the company's database and host on Sanoma Cloud. */
export const INFRA = "resources/sanoma/infra.ts";

/** The template config's opening, after which `declareName` writes the company's name. */
const CONFIG_OPENING = /^export default defineConfig\(\{\n/m;

/** The config file with the company's `name` declared first. */
export function declareName(text: string, name: string): string {
  if (!CONFIG_OPENING.test(text))
    throw new Error("the template's sanoma.config.ts has no `export default defineConfig({`");
  return text.replace(CONFIG_OPENING, (opening) => `${opening}  name: ${JSON.stringify(name)},\n`);
}

/** The template's slug in `resources/sanoma/infra.ts`: the Cloud names and its address, literals the app's forms can edit. */
const TEMPLATE_SLUG = /"company(\.sanoma\.work)?"/g;

/** The infra file with the company's slug for the template's, in the names and the address. */
export function declareSlug(text: string, slug: string): string {
  if (text.search(TEMPLATE_SLUG) < 0) throw new Error(`the template's ${INFRA} names no "company"`);
  return text.replaceAll(TEMPLATE_SLUG, (_, address: string | undefined) => JSON.stringify(slug + (address ?? "")));
}
