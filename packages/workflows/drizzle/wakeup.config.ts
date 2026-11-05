import { defineConfig } from "drizzle-kit";

// The wakeup service's tables, from `src/db/wakeup.ts`; see `company.config.ts`.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/wakeup.ts",
  out: "./drizzle/wakeup",
  casing: "snake_case",
});
