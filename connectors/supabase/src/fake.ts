import { tfFake, type TfFakeOptions, type TfFakeState } from "@sanoma-ai/bridge/fake";
import { supabaseTf } from "./connector.ts";

/** The replies the fake serves, written by hand to the provider's schema: there is no Supabase recording yet. */
const fixtures = new URL("../testdata/", import.meta.url);

export type FakeSupabaseState = TfFakeState;
export type FakeSupabaseOptions = TfFakeOptions;

/**
 * A Supabase that answers through the real driver over a bridge of the replies in `testdata/`, a
 * project (`sanomatestprojectref`), and the answer for one that does not exist
 * (`sanomamissingproject`). Those replies are written by hand to the provider's schema, not
 * recorded: no access token was at hand. Nothing reaches Supabase, and no token is read.
 *
 * `put` makes a project, `override` changes what the next read returns, as if someone edited
 * the project in Supabase's dashboard, and `remove` deletes it, so the next read says it is gone.
 */
export const fakeSupabase = (options: FakeSupabaseOptions = {}) => tfFake(supabaseTf, { fixtures, ...options });
