import { supabaseTf } from "./connector.ts";

/**
 * The constructors a data file declares Supabase projects with, without the ref Supabase sets:
 * `export const store = supabase.project({ name: "acme-ops", organization_id: "acme", region: "us-east-1" })`.
 */
export const supabase = supabaseTf.resources;
