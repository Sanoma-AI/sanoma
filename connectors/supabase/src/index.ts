import { withSetup } from "@sanoma-ai/workflows";
import { supabaseOps } from "./connector.ts";
import { supabaseDriver } from "./driver.ts";
import { fakeSupabase } from "./fake.ts";

/**
 * Supabase projects: `supabase.project.read` and `.import`, effect `read`, and the change
 * operations apply calls (`plan`, `create`, `update`, `delete`), through the `supabase/supabase`
 * OpenTofu provider; and from the Management API `supabase.project.health` and
 * `supabase.pooler.get` (effect `read`) and `supabase.database.storeUrl` (effect `write`, to the
 * secrets store). It carries its live driver (`supabaseDriver`, on the default bridge) and its
 * fake (`fakeSupabase`), of which each sandbox run makes its own.
 */
export const supabase = withSetup(supabaseOps, { driver: supabaseDriver, fake: fakeSupabase });
