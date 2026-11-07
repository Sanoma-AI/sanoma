import { defineConfig } from "drizzle-kit";

// `pnpm --filter sanoma generate`: the visitor login's migrations, from
// `src/db/visitors.ts`. Column names are the properties in snake_case, as the runtime's
// `databaseOn` reads them.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/visitors.ts",
  out: "./drizzle/visitors",
  casing: "snake_case",
});
