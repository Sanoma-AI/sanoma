// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { defaultBranch, deriveHosts, hostFacts, isSecret, type Secrets, valueAt } from "@sanoma-ai/workflows";
import type { HostDerived } from "../api.ts";
import type { AppContext } from "../context.ts";

/**
 * What apply gives the first declared host that derives, told as apply tells it: the files read
 * again and filled by `deriveHosts` over `hostFacts` (nothing minted), so the page never says
 * other than apply. Its image, the repository it runs (a declared one's `owner/name`, else its
 * clone URL), the declared ref or that repository's default branch, the public sites' domains,
 * and of the keys it is given (`SANOMA_…`) whether each is stored, and since when. Null when no
 * declared host derives. Never a secret's value: the facts read the store only to say what is in it.
 */
export async function hostDerived({ client, resolved, description }: AppContext): Promise<HostDerived | null> {
  const { root, types } = resolved;
  if (root === undefined) return null;
  const resources = structuredClone(description.resources);
  const read: Secrets = {
    get: async (name) => (await client.secrets([name])).get(name)?.value,
    ensure: () => Promise.reject(new Error("Hosting mints nothing")),
    delete: () => Promise.reject(new Error("Hosting deletes nothing")),
  };
  const facts = await hostFacts({
    root,
    resources,
    types,
    drivers: resolved.driversByVendor,
    secrets: read,
    builtInStore: !resolved.secrets.store,
    signingKeyBound: resolved.secrets.bindings?.SANOMA_SIGNING_KEY !== undefined,
    ...(resolved.login && { sender: resolved.login.sender.vendor }),
    mint: false,
  });
  if (!facts) return null;
  deriveHosts(resources, types, {}, facts);
  const host = resources.find((r) => types.get(`${r.vendor}.${r.type}`)?.host?.derives)!;
  const { inputs } = types.get(`${host.vendor}.${host.type}`)!.host!;
  const text = (path: string | undefined) => {
    const value = path === undefined ? undefined : valueAt(host.desired, path);
    return typeof value === "string" && value ? value : undefined;
  };
  const repository = resources.find((r) => r.id === host.refs[inputs.source]);
  const source = repository?.identity ?? text(inputs.source);
  const url = repository?.identity ? `https://github.com/${repository.identity}.git` : text(inputs.source);
  const names = Object.entries((inputs.secrets && valueAt(host.desired, inputs.secrets)) ?? {})
    .filter(([name, value]) => name.startsWith("SANOMA_") && isSecret(value) && name !== "SANOMA_DATABASE_URL")
    .map(([, value]) => (value as { $secret: string }).$secret);
  const [ref, stored] = await Promise.all([
    text(inputs.ref) ??
      (url
        ? defaultBranch(url).then(
            (resolvedRef) => resolvedRef.ref,
            () => undefined,
          )
        : undefined),
    client.secrets(names),
  ]);
  const domains = inputs.domains ? valueAt(host.desired, inputs.domains) : undefined;
  return {
    id: host.id,
    ...(text(inputs.image) !== undefined && { image: text(inputs.image) }),
    ...(source !== undefined && { source }),
    ...(ref !== undefined && { ref }),
    domains: (domains ?? facts.domains) as Record<string, string>,
    keys: names.map((name) => {
      const row = stored.get(name);
      return { name, stored: row !== undefined, ...(row?.setAt && { setAt: row.setAt }) };
    }),
  };
}
