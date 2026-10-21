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
  const count = (kind: "workflow" | "op") => data.rows.filter((row) => row.kind === kind).length;
  return (
    <>
      <PanelHeader section="permissions" title="Permissions" />
      <SidebarContent>
        <SidebarGroup className="text-sm">
          <Facts>
            <PolicyFacts policy={data.policy} />
            <Fact label="Groups">{data.groups.filter((group) => group !== null).length}</Fact>
            <Fact label="Workflows">{count("workflow")}</Fact>
            <Fact label="Operations">{count("op")}</Fact>
          </Facts>
        </SidebarGroup>
      </SidebarContent>
      <PanelFooterLink link={<Link to="/permissions" />}>The whole grid</PanelFooterLink>
    </>
  );
}

/** The policy's kind, Cedar or a function (or none), and its version when it has one: for `Facts`. */
export function PolicyFacts({ policy }: { policy: PermissionsResponse["policy"] }) {
  const kind = !policy.defined
    ? "None"
    : policy.kind === "cedar"
      ? "Cedar, policies/*.cedar"
      : "A function, definePolicy";
  return (
    <>
      <Fact label="Policy">{kind}</Fact>
      {policy.version !== undefined && (
        <Fact label="Version">
          <code>{policy.version}</code>
        </Fact>
      )}
    </>
  );
}
