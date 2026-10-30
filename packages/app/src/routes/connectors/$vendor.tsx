import type { OpEntry } from "@sanoma-ai/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { Badge } from "#/components/ui/badge.tsx";
import { ItemGroup } from "#/components/ui/item.tsx";
import type { ScenarioEntry } from "../../api.ts";
import {
  CrumbHeader,
  Expandable,
  ExternalLink,
  None,
  Notice,
  OpItem,
  pageTitle,
  Region,
  Section,
  UsedBy,
  VendorLogo,
} from "../../components/common.tsx";
import { Credentials } from "../../components/credentials.tsx";
import { Connections } from "../../components/connections.tsx";
import { ScenarioErrors } from "../../components/scenario.tsx";
import { type ScenarioRoles, scenarioRoles } from "../../graph/scenario-graph.ts";
import { configQuery, connectorNamed, credentialsQuery, scenariosNaming, scenariosQuery } from "../../queries.ts";

export const Route = createFileRoute("/connectors/$vendor")({
  // The page reads the config, the scenarios and the credentials from the query client; the
  // loader returns only its name: the connector's title.
  loader: async ({ context: { queryClient }, params }) => {
    const config = await queryClient.query({ ...configQuery(), staleTime: "static" });
    const connector = connectorNamed(params.vendor)(config);
    if (!connector) throw notFound();
    await Promise.all([
      queryClient.query({ ...scenariosQuery(), staleTime: "static" }),
      queryClient.query({ ...credentialsQuery(), staleTime: "static" }),
    ]);
    return { crumb: connector.vendor.title };
  },
  // A connector that does not exist has no loader data: its id stands in.
  head: ({ loaderData, params }) => pageTitle(loaderData?.crumb ?? params.vendor),
  component: ConnectorPage,
  notFoundComponent: () => <Notice variant="destructive">No connector {Route.useParams().vendor}.</Notice>,
});

/** One connector: where it lives, its resource types, every operation with its contract and scenarios, and who uses it. */
function ConnectorPage() {
  const { vendor: id } = Route.useParams();
  const {
    data: { vendor, ops, workflows, resourceTypes },
  } = useSuspenseQuery({ ...configQuery(), select: (config) => connectorNamed(id)(config)! });
  const { data: scenarios } = useSuspenseQuery(scenariosQuery());
  const resourceOps = new Set(resourceTypes.flatMap((r) => r.ops));
  const workflowOps = ops.filter((op) => !resourceOps.has(op.id));
  return (
    <>
      {/* Decorative: the title beside it names the heading. */}
      <CrumbHeader icon={<VendorLogo vendor={id} alt="" className="size-7" />}>
        <code className="text-muted-foreground">{id}</code>
        {(vendor.package || vendor.homepage) && (
          <div className="flex flex-wrap">
            {vendor.package && (
              <ExternalLink href={`https://www.npmjs.com/package/${vendor.package}`}>{vendor.package}</ExternalLink>
            )}
            {vendor.homepage && <ExternalLink href={vendor.homepage}>Source</ExternalLink>}
          </div>
        )}
      </CrumbHeader>
      {resourceTypes.length > 0 && (
        <p>
          <span className="text-muted-foreground">Resources: </span>
          {resourceTypes.map((r) => r.title).join(", ")}
        </p>
      )}
      <ScenarioErrors errors={scenarios.errors} />
      <Credentials vendor={id} />
      <Connections vendor={id} />
      <Region title="Operations">
        {ops.length === 0 ? (
          <None />
        ) : (
          <>
            {/* A resource type's `read` and `import` read real state: a vendor with only those needs no fake. */}
            {workflowOps.length > 0 && !vendor.fake && <None>Its connector attaches no fake.</None>}
            <ItemGroup>
              {ops.map((op) => (
                <OpItem key={op.id} id={op.id} op={op}>
                  <OpDetails op={op} scenarios={scenariosNaming(op.id)(scenarios)} />
                </OpItem>
              ))}
            </ItemGroup>
          </>
        )}
      </Region>
      <UsedBy workflows={workflows} />
    </>
  );
}

/** Under an operation: its contract, the steps that name it, and the scenarios about it. */
function OpDetails({ op, scenarios }: { op: OpEntry; scenarios: ScenarioEntry[] }) {
  const { phrases } = op;
  return (
    <div className="mt-2 flex flex-col gap-3">
      <Section title="Contract">
        <div className="flex flex-col">
          <Expandable label="Input" value={op.input} />
          <Expandable label="Output" value={op.output} />
        </div>
      </Section>
      {(phrases?.given || phrases?.expect) && (
        <Section title="Phrases">
          <ul className="flex flex-col gap-1">
            {phrases.given && (
              <li>
                <code>Given {phrases.given}</code>
              </li>
            )}
            {phrases.expect && (
              <li>
                <code>Then {phrases.expect}</code>
              </li>
            )}
          </ul>
        </Section>
      )}
      <Section title="Scenarios">
        {scenarios.length === 0 ? (
          <None />
        ) : (
          <ul className="flex flex-col gap-1">
            {scenarios.map((s) => {
              const roles = scenarioRoles(s.steps, (step) => step.op === op.id);
              return (
                <li key={s.name} className="flex flex-wrap items-center gap-1.5">
                  <Link
                    to="/workflows/$name"
                    params={{ name: s.workflow }}
                    search={{ new: true, scenario: s.name }}
                    className="hover:underline"
                  >
                    {s.name}
                  </Link>
                  {(Object.keys(ROLE_LABELS) as (keyof ScenarioRoles)[])
                    .filter((role) => roles[role])
                    .map((role) => (
                      <Badge key={role} variant="outline">
                        {ROLE_LABELS[role]}
                      </Badge>
                    ))}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}

/**
 * What a scenario does with the operation, in the order a scenario says it, as verbs: the
 * graph's badges say the same of a node as states ("seeded", "not called").
 */
const ROLE_LABELS: Record<keyof ScenarioRoles, string> = {
  seeded: "seeds",
  fails: "fails",
  expected: "expects",
  forbidden: "must not call",
  denied: "must deny",
  held: "must hold",
};
