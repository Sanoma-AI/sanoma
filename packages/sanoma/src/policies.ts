import { readPeople } from "@sanoma-ai/workflows/describe";
import { problemLine } from "@sanoma-ai/workflows/shared";
import type { Loaded } from "./config.ts";

/**
 * Makes the config's policy from `<root>/policies/**\/*.cedar` when it names none (`cedarPolicy`,
 * over the schema of the resolved config and the people the data files declare, `readPeople`),
 * setting it on the config and on what was resolved from it, and says what is wrong, one
 * printable line each (`file:line:col: <policy id>: <message>`): a file that does not parse, two
 * policies with one id, what
 * `validatePolicies` finds, and Cedar files beside a `policy` in `sanoma.config.ts`. With a
 * problem the policy is left as it was. No Cedar files: nothing to do, and a config without a
 * policy allows every call.
 */
export async function usePolicies({ config, root, resolved }: Loaded): Promise<string[]> {
  const { cedarPolicy, loadPolicies, readPolicyFiles, validatePolicies } = await import("@sanoma-ai/workflows");
  const files = readPolicyFiles(root);
  if (!files.length) return [];
  if (config.policy !== undefined) {
    return [
      `${files[0]!.file}: sanoma.config.ts names a \`policy\` too; a repo decides with its policies/*.cedar or its policy, not both`,
    ];
  }
  const { people } = readPeople(root);
  const { policies, problems } = loadPolicies(files);
  problems.push(...validatePolicies(resolved, policies, people));
  if (problems.length) {
    return problems.map(({ policy, ...p }) =>
      problemLine({ ...p, message: policy ? `${policy}: ${p.message}` : p.message }),
    );
  }
  config.policy = resolved.policy = cedarPolicy(resolved, policies, people);
  return [];
}
