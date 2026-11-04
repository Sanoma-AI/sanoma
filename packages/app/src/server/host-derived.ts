// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import {
  defaultBranch,
  installedSanoma,
  originUrl,
  runtimeImage,
  SOURCE_KEY,
  sourceRepository,
} from "@sanoma-ai/workflows";
import { siteDomains } from "@sanoma-ai/workflows/describe";
import { WAKEUP_TOKEN } from "@sanoma-ai/workflows/wakeup-service";
import type { HostDerived } from "../api.ts";
import type { AppContext } from "../context.ts";

/**
 * What apply gives the first declared host that derives (`deriveHosts`), told as apply tells it:
 * the image of the installed sanoma unless one is declared, the repository it names or the app's
 * `origin`, the declared ref or that repository's default branch, the public sites' domains, and
 * of the keys it is given (`SANOMA_SIGNING_KEY`, with the built-in store `SANOMA_SECRETS_KEY`, the
 * source key, and the wakeup's token when a wakeup names it) whether each is stored, and since
 * when. Null when no declared host derives. Never a secret's value.
 */
export async function hostDerived({ client, resolved, description }: AppContext): Promise<HostDerived | null> {
  const root = resolved.root;
  if (root === undefined) return null;
  const host = description.resources.find((r) => resolved.types.get(`${r.vendor}.${r.type}`)?.host?.derives);
  if (!host) return null;
  const { inputs, bindsBootstrap } = resolved.types.get(`${host.vendor}.${host.type}`)!.host!;
  const declared = (path: string | undefined) => {
    const value = path === undefined ? undefined : host.desired[path];
    return typeof value === "string" && value ? value : undefined;
  };
  const type = resolved.types.get(`${host.vendor}.${host.type}`)!;
  const origin = await originUrl(root);
  // The repository it names, else the one apply would give it (`sourceRepository`), else `origin`.
  const named = host.refs[inputs.source];
  const repository = named
    ? description.resources.find((r) => r.id === named)
    : declared(inputs.source)
      ? undefined
      : sourceRepository(host, type, description.resources, origin);
  const url = repository?.identity
    ? `https://github.com/${repository.identity}.git`
    : (declared(inputs.source) ?? origin);
  const source = repository?.identity ?? url;
  const ref =
    declared(inputs.ref) ??
    (url
      ? await defaultBranch(url).then(
          ({ ref: branch }) => branch,
          () => undefined,
        )
      : undefined);
  const version = declared(inputs.image) ? undefined : await installedSanoma(root);
  const image = declared(inputs.image) ?? (version ? runtimeImage(version) : undefined);
  const woken = description.resources.some((r) => {
    const wakeup = resolved.types.get(`${r.vendor}.${r.type}`)?.wakeup;
    return wakeup !== undefined && r.refs[wakeup.inputs.host] === host.id;
  });
  const names = bindsBootstrap
    ? []
    : [
        "SANOMA_SIGNING_KEY",
        ...(resolved.secrets.store ? [] : ["SANOMA_SECRETS_KEY"]),
        SOURCE_KEY,
        ...(woken ? [WAKEUP_TOKEN] : []),
      ];
  const stored = await client.secrets(names);
  return {
    id: host.id,
    ...(image !== undefined && { image }),
    ...(source !== undefined && { source }),
    ...(ref !== undefined && { ref }),
    domains: siteDomains(root),
    keys: names.map((name) => {
      const row = stored.get(name);
      return { name, stored: row !== undefined, ...(row?.setAt && { setAt: row.setAt }) };
    }),
  };
}
