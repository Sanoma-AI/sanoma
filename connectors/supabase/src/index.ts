import { withSetup } from "sanoma/workflows";
import { supabaseAccessToken, supabaseOAuth } from "./authentication.ts";
import { supabaseOps } from "./connector.ts";
import { supabaseDriver } from "./driver.ts";
import { fakeSupabase } from "./fake.ts";

/**
 * Supabase projects: `supabase.project.read` and `.import`, effect `read`, and the change
 * operations apply calls (`plan`, `create`, `update`, `delete`), through the `supabase/supabase`
 * OpenTofu provider; and from the Management API `supabase.organization.list`,
 * `supabase.project.health` and `supabase.pooler.get` (effect `read`) and
 * `supabase.database.storeUrl` (effect `write`, to the secrets store). Calls run as a named
 * connection, by OAuth consent (`oauth`) or a pasted personal access token (`accessToken`). It
 * carries its live driver (`supabaseDriver`, on the default bridge) and its fake
 * (`fakeSupabase`), of which each sandbox run makes its own.
 */
export const supabase = withSetup(supabaseOps, {
  authentication: { oauth: supabaseOAuth, accessToken: supabaseAccessToken },
  driver: supabaseDriver,
  fake: fakeSupabase,
});

export { supabaseAccessToken, supabaseOAuth } from "./authentication.ts";
