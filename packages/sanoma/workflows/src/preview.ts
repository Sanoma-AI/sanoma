import { createHash } from "node:crypto";
import { secret, type Secret } from "./secret.ts";
import { DRAFT_ID } from "./shared.ts";

// A preview's own secrets (#600; context `design/changes.md#preview`): a different set, never a
// filtered copy of the live one. The live instance opens a preview and keeps the preview's values
// in its own store, under names of the preview's, for as long as the preview is open; the preview is
// started with them in the variables a host is started with, so its runtime reads them as the live
// one reads its own. Never the live secrets key, signing key, database role, source key, the
// GitHub App's keys, a vendor's token or the wakeup's: a preview that reads its key reaches its own
// schema, its own sessions and a read-only clone of the repository, and nothing else.

/** The variables a preview is started with, each holding the preview's own value. */
export type PreviewVariable = "SANOMA_DATABASE_URL" | "SANOMA_SIGNING_KEY" | "SANOMA_SECRETS_KEY" | "SANOMA_SOURCE_KEY";

/** What `previewSecretSet` names for one change's preview. */
export interface PreviewSecretSet {
  /**
   * The schema of the live database the preview's records are copied into and its runtime keeps
   * its runs, ledger and credentials in, `preview_<change>`, and the name of the database role
   * that reaches it alone, whose URL is `SANOMA_DATABASE_URL`'s value.
   */
  readonly schema: string;
  /**
   * By variable, where the live instance keeps the preview's value: `SANOMA_PREVIEW_<CHANGE>_<WHAT>`,
   * a name no live secret has. The signing and secrets keys are generated at the first use (`generate`);
   * the database URL is the role's, written once the role is made; the source key is the private
   * half of a read-only deploy key on the repository, minted when the preview opens.
   */
  readonly environment: Readonly<Record<PreviewVariable, Secret>>;
}

/** A draft's id that is its own key: lower case, digits and `-`, short enough for an identifier. */
const PLAIN = /^[a-z0-9-]{1,50}$/;

/**
 * The secrets, schema and role of `change`'s preview. `<change>` is the draft's id with `-` as `_`
 * when it is lower case and 50 characters at most (a chat's UUID is); else the first 52 hex of its
 * sha256, which no such id can be, so two drafts never share a preview's names. Names only: the
 * values are made by whatever opens the preview.
 */
export function previewSecretSet(change: string): PreviewSecretSet {
  if (!DRAFT_ID.test(change)) throw new Error(`Not a draft's id: ${JSON.stringify(change)}`);
  const key = PLAIN.test(change)
    ? change.replaceAll("-", "_")
    : createHash("sha256").update(change).digest("hex").slice(0, 52);
  const name = (what: string) => `SANOMA_PREVIEW_${key.toUpperCase()}_${what}`;
  return {
    schema: `preview_${key}`,
    environment: {
      SANOMA_DATABASE_URL: secret(name("DATABASE_URL")),
      SANOMA_SIGNING_KEY: secret(name("SIGNING_KEY"), { generate: true }),
      SANOMA_SECRETS_KEY: secret(name("SECRETS_KEY"), { generate: true }),
      SANOMA_SOURCE_KEY: secret(name("SOURCE_KEY")),
    },
  };
}
