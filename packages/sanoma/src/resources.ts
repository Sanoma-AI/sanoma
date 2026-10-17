// What a data file under `resources/` imports from sanoma: `secret`, which names a stored secret
// for a write-only field (`secret("SUPABASE_DB_PASSWORD", { generate: true })`).
export { secret, type Secret } from "@sanoma-ai/workflows/resources";
