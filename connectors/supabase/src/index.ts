import { withSetup } from "@sanoma-ai/workflows";
import { supabaseTf } from "./connector.ts";
import { supabaseDriver } from "./driver.ts";
import { fakeSupabase } from "./fake.ts";

/**
 * Supabase projects, read through the `supabase/supabase` OpenTofu provider:
 * `supabase.project.read` and `supabase.project.import`, both effect `read`. It carries its live
 * driver (`supabaseDriver`, on the default bridge) and its fake (`fakeSupabase`), of which each
 * sandbox run makes its own.
 */
export const supabase = withSetup(supabaseTf.connector, { driver: supabaseDriver, fake: fakeSupabase });
