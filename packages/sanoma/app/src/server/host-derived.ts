// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import { deriveHosts, hostFacts, isSecret, type Secrets, valueAt } from "sanoma/workflows";
import type { HostDerived } from "../api.ts";
import type { AppContext } from "../context.ts";

/**
 * What apply gives the first declared host that derives, told as apply tells it: the files read
 * again and filled by `deriveHosts` over `hostFacts` (nothing minted), so the page never says
 * other than apply. Its image, the repository it runs (a declared one's `owner/name`, else its
 * clone URL), the declared ref or that repository's default branch, the public sites' domains,
 * and of the keys it is given (`SANOMA_…`, and the bindings the config gives it, `host: true`)
 * whether each is stored, and since when. Null when no
 * declared host derives. Never a secret's value: the facts read the store only to say what is in it.
 * What the root's files and git say comes from the snapshot (`AppSnapshot.host`).
 */
export async function hostDerived({ client, resolved, snapshot }: AppContext): Promise<HostDerived | null> {
  const { types } = resolved;
  const at = snapshot.host;
  if (!at) return null;
  const resources = structuredClone(snapshot.description.resources);
  const read: Secrets = {
    get: async (name) => (await client.secrets([name])).get(name)?.value,
    ensure: () => Promise.reject(new Error("Hosting mints nothing")),
    delete: () => Promise.reject(new Error("Hosting deletes nothing")),
  };
  const facts = await hostFacts({
    rootFacts: async () => at,
    resources,
    types,
    drivers: resolved.driversByVendor,
    secrets: read,
    builtInStore: !resolved.secrets.store,
    bindings: resolved.secrets.bindings,
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
  const names = [
    ...new Set([
      ...Object.entries((inputs.secrets && valueAt(host.desired, inputs.secrets)) ?? {})
        .filter(([name, value]) => name.startsWith("SANOMA_") && isSecret(value) && name !== "SANOMA_DATABASE_URL")
        .map(([, value]) => (value as { $secret: string }).$secret),
      // Those the config gives it (`host: true`), with a value or not (then apply's problem).
      ...Object.values(facts.hostEnvironment ?? {}),
    ]),
  ];
  const ref = text(inputs.ref) ?? (url ? at.branches[url] : undefined);
  const stored = await client.secrets(names);
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
