import { problemLine } from "@sanoma-ai/workflows/shared";
import type { PolicyPeople } from "@sanoma-ai/workflows/describe";
import type { LoadedConfig } from "./config.ts";

/**
 * Makes the config's policy from `<root>/policies/**\/*.cedar` when it names none (`cedarPolicy`,
 * over the schema of the resolved config and `people`), and says what is wrong, one printable
 * line each (`file:line:col: <policy id>: <message>`): a file that does not parse, two policies
 * with one id, what `validatePolicies` finds, and Cedar files beside a `policy` in
 * `sanoma.config.ts`. With a problem the config's policy is left as it was. No Cedar files:
 * nothing to do, and a config without a policy allows every call.
 */
export async function usePolicies({ config, root }: LoadedConfig, people: PolicyPeople): Promise<string[]> {
  const { cedarPolicy, loadPolicies, readPolicyFiles, resolveConfig, validatePolicies } =
    await import("@sanoma-ai/workflows");
  const files = readPolicyFiles(root);
  if (!files.length) return [];
  if (config.policy !== undefined) {
    return [
      `${files[0]!.file}: sanoma.config.ts names a \`policy\` too; a repo decides with its policies/*.cedar or its policy, not both`,
    ];
  }
  // Resolved without a policy (allow all), for what the schema is made from: its operations, workflows and collections.
  const resolved = resolveConfig(config);
  const { policies, problems } = loadPolicies(files);
  problems.push(...validatePolicies(resolved, policies, people));
  if (problems.length) {
    // One line per place: a policy scoped to every action can fail the same way for each.
    const places = new Set<string>();
    return problems.flatMap(({ policy, ...p }) => {
      const place = p.line === undefined ? undefined : `${p.file}:${p.line}:${p.column}`;
      if (place !== undefined && places.has(place)) return [];
      if (place !== undefined) places.add(place);
      return [problemLine({ ...p, message: policy ? `${policy}: ${p.message}` : p.message })];
    });
  }
  config.policy = cedarPolicy(resolved, policies, people);
  return [];
}
