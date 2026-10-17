import { tfFake, type TfFakeOptions, type TfFakeState } from "@sanoma-ai/bridge/fake";
import type { Driver } from "@sanoma-ai/workflows";
import { supabaseOps, supabaseTf } from "./connector.ts";
import { apiError, type ManagementApi, withManagement } from "./management.ts";

/** The replies the fake serves, written by hand to the provider's schema: there is no Supabase recording yet. */
const fixtures = new URL("../testdata/", import.meta.url);

export type FakeSupabaseState = TfFakeState;
export type FakeSupabaseOptions = TfFakeOptions;

/** The Management API as the fake's projects answer it: every project healthy, its pooler in its region. */
function fakeApi(state: FakeSupabaseState): ManagementApi {
  const projects = () =>
    Object.values(state.objects).flatMap((o) =>
      "error" in o || o.typeName !== "supabase_project" || o.state.name == null ? [] : [o.state],
    );
  const project = (ref: string, path: string) => {
    const found = projects().find((p) => p.id === ref);
    if (!found) throw apiError(`/v1/projects/${ref}${path}`, 404, "Project not found", false);
    return found;
  };
  return {
    projects: async () =>
      projects().map((p) => ({ id: String(p.id), name: String(p.name), organization_id: String(p.organization_id) })),
    pooler: async (ref) => {
      const { region } = project(ref, "/config/database/pooler");
      const at = {
        db_host: `aws-0-${String(region)}.pooler.supabase.com`,
        db_user: `postgres.${ref}`,
        db_name: "postgres",
      };
      return [{ database_type: "PRIMARY", ...at }];
    },
    health: async (ref, services) => {
      project(ref, "/health");
      return services.map((name) => ({ name, healthy: true, status: "ACTIVE_HEALTHY" }));
    },
  };
}

/**
 * A Supabase that answers through the real driver over a bridge of the replies in `testdata/`, a
 * project (`sanomatestprojectref`), and the answer for one that does not exist
 * (`sanomamissingproject`). Those replies are written by hand to the provider's schema, not
 * recorded: no access token was at hand. Its bridge creates, changes and deletes projects in
 * memory (`stateBridge`); the Management API operations answer from the same projects, each
 * healthy, its session pooler `aws-0-<region>.pooler.supabase.com`. Nothing reaches Supabase,
 * and no token is read.
 *
 * `put` makes a project, `override` changes what the next read returns, as if someone edited
 * the project in Supabase's dashboard, and `remove` deletes it, so the next read says it is gone.
 */
export function fakeSupabase(options: FakeSupabaseOptions = {}) {
  // The fake's state, kept in place across `reset`: its bridge's projects.
  let state!: FakeSupabaseState;
  const fake = tfFake(
    {
      ...supabaseTf,
      connector: supabaseOps,
      driver: (...args): Driver => withManagement(supabaseTf.driver(...args), () => fakeApi(state)),
    },
    { fixtures, ...options },
  );
  state = fake.state;
  return fake;
}
