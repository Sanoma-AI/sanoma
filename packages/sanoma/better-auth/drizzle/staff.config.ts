import { defineConfig } from "drizzle-kit";

// The staff login's migrations, from `src/db/staff.ts`; see `visitors.config.ts`.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/staff.ts",
  out: "./drizzle/staff",
  casing: "snake_case",
});
