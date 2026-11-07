import { defineConfig } from "drizzle-kit";

// `pnpm --filter sanoma generate`: the migrations of the tables every company
// database gets, from `src/db/company.ts`. Column names are the properties in snake_case, as
// `databaseOn` in `src/db.ts` reads them.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/company.ts",
  out: "./drizzle/company",
  casing: "snake_case",
});
