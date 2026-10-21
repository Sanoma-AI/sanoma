import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SidebarContent, SidebarGroup } from "#/components/ui/sidebar.tsx";
import type { PermissionsResponse } from "../../api.ts";
import { permissionsQuery } from "../../queries.ts";
import { Fact, Facts } from "../common.tsx";
import { PanelFooterLink, PanelHeader } from "./panel.tsx";

// The Permissions section's panel: the policy, and what its grid holds.

/** The policy's kind and version, how many groups, workflows and operations the grid has, and the grid at its foot. */
export function PermissionsPanel() {
  const { data } = useSuspenseQuery(permissionsQuery());
  return (
    <>
      <PanelHeader section="permissions" title="Permissions" />
      <SidebarContent>
        <SidebarGroup className="text-sm">
          <Facts>
            <PolicyFacts policy={data.policy} />
            <Fact label="Groups">{data.groups.filter((group) => group !== null).length}</Fact>
            <Fact label="Workflows">{data.workflows.length}</Fact>
            <Fact label="Operations">{data.ops.length}</Fact>
          </Facts>
        </SidebarGroup>
      </SidebarContent>
      <PanelFooterLink link={<Link to="/permissions" />}>The whole grid</PanelFooterLink>
    </>
  );
}

/** The policy, Cedar or none, and its version when it has one: for `Facts`. */
export function PolicyFacts({ policy }: { policy: PermissionsResponse["policy"] }) {
  return (
    <>
      <Fact label="Policy">
        {policy.problems
          ? "Cedar, policies/*.cedar, which do not hold: all refused"
          : policy.defined
            ? "Cedar, policies/*.cedar"
            : "None"}
      </Fact>
      {policy.version !== undefined && (
        <Fact label="Version">
          <code>{policy.version}</code>
        </Fact>
      )}
    </>
  );
}
