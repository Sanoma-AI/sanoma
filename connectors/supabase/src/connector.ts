import { tfConnector } from "@sanoma-ai/bridge/connector";
import { provider, supabase_project } from "./resources.gen.ts";

/**
 * Supabase's bolt, from simple-icons (https://simpleicons.org/?q=supabase, CC0), in Supabase's
 * green, which reads on light and dark backgrounds alike.
 */
const bolt = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#3FCF8E" d="M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z"/></svg>`;

/**
 * Supabase, through the `supabase/supabase` OpenTofu provider: the generated resource types, and
 * who Supabase is. Supabase names its projects (a project's ref), so a declaration has no
 * identity: its project is the one its binding names, by its ref. The provider answers a project
 * that does not exist with the state it was given, so one without a name is gone. The connector,
 * the data-file constructors, the driver and the fake all come from this one record.
 */
export const supabaseTf = tfConnector({
  vendor: "supabase",
  provider,
  types: {
    project: { tf: supabase_project, title: "Project", exists: (state) => state.name != null },
  },
  info: {
    title: "Supabase",
    logo: { svg: bolt },
    package: "@sanoma-ai/connector-supabase",
    homepage: "https://github.com/Sanoma-AI/sanoma/tree/main/connectors/supabase#readme",
  },
});
