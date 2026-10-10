import type { CredentialStatus, OpEntry } from "@sanoma/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { ItemGroup } from "#/components/ui/item.tsx";
import type { ScenarioEntry } from "../../api.ts";
import {
  Expandable,
  Json,
  None,
  Notice,
  OpItem,
  PageHeader,
  pageTitle,
  Section,
  SectionTitle,
  ToneBadge,
  VendorLogo,
} from "../../components/common.tsx";
import { ScenarioErrors } from "../../components/scenario.tsx";
import { type ScenarioRoles, scenarioRoles } from "../../graph/scenario-graph.ts";
import { configQuery, connectorNamed, scenariosNaming, scenariosQuery } from "../../queries.ts";

export const Route = createFileRoute("/connectors/$vendor")({
  // The page reads the config and the scenarios from the query client; the loader returns only
  // its name: the connector's title.
  loader: async ({ context: { queryClient }, params }) => {
    const config = await queryClient.query({ ...configQuery(), staleTime: "static" });
    const connector = connectorNamed(params.vendor)(config);
    if (!connector) throw notFound();
    await queryClient.query({ ...scenariosQuery(), staleTime: "static" });
    return { crumb: connector.vendor.title };
  },
  // A connector that does not exist has no loader data: its id stands in.
  head: ({ loaderData, params }) => pageTitle(loaderData?.crumb ?? params.vendor),
  component: ConnectorPage,
  notFoundComponent: () => <Notice variant="destructive">No connector {Route.useParams().vendor}.</Notice>,
});

/** One connector: where it lives, its resource types, every operation with its contract and mock, and who uses it. */
function ConnectorPage() {
  const { vendor: id } = Route.useParams();
  const {
    data: { vendor, ops, workflows, resourceTypes },
  } = useSuspenseQuery({ ...configQuery(), select: (config) => connectorNamed(id)(config)! });
  const { data: scenarios } = useSuspenseQuery(scenariosQuery());
  return (
    <div className="flex flex-col gap-6">
      {/* Decorative: the title beside it names the heading. */}
      <PageHeader icon={<VendorLogo vendor={id} alt="" className="size-7" />}>
        <code className="text-muted-foreground">{id}</code>
        {(vendor.package || vendor.homepage) && (
          <div className="flex flex-wrap">
            {vendor.package && (
              <ExternalLink href={`https://www.npmjs.com/package/${vendor.package}`}>{vendor.package}</ExternalLink>
            )}
            {vendor.homepage && <ExternalLink href={vendor.homepage}>Source</ExternalLink>}
          </div>
        )}
      </PageHeader>
      {resourceTypes.length > 0 && (
        <p>
          <span className="text-muted-foreground">Resources: </span>
          {resourceTypes.map((r) => r.title).join(", ")}
        </p>
      )}
      <ScenarioErrors errors={scenarios.errors} />
      {vendor.credentials && <Credentials credentials={vendor.credentials} />}
      <section className="flex flex-col gap-3">
        <SectionTitle>Operations</SectionTitle>
        {ops.length === 0 ? (
          <None />
        ) : (
          <>
            {/* Every operation of a vendor in `fakes` has a mock, so either all have one or none. */}
            {ops.every((op) => !op.mock) && <None>No fake in this config.</None>}
            <ItemGroup>
              {ops.map((op) => (
                <OpItem key={op.id} id={op.id} op={op}>
                  <OpDetails op={op} scenarios={scenariosNaming(op.id)(scenarios)} />
                </OpItem>
              ))}
            </ItemGroup>
          </>
        )}
      </section>
      <section className="flex flex-col gap-3">
        <SectionTitle>Used by</SectionTitle>
        {workflows.length === 0 ? (
          <None />
        ) : (
          <ul className="flex flex-col gap-1">
            {workflows.map((wf) => (
              <li key={wf.name}>
                <Link to="/workflows/$name" params={{ name: wf.name }} className="hover:underline">
                  {wf.title ?? wf.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** The environment variables the vendor's drivers read: each one's manual and status, never its value. */
function Credentials({ credentials }: { credentials: CredentialStatus[] }) {
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>Credentials</SectionTitle>
      <ul className="flex flex-col gap-1.5">
        {credentials.map(({ name, description, optional, status, problem }) => (
          <li key={name} className="flex flex-wrap items-center gap-1.5">
            <code>{name}</code>
            <ToneBadge tone={status === "set" ? "ok" : status === "missing" && optional ? "off" : "bad"}>
              {status === "invalid" ? `invalid: ${problem}` : status}
            </ToneBadge>
            {optional && <Badge variant="outline">optional</Badge>}
            {description && <span className="text-muted-foreground">{description}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Under an operation: its contract, the steps that name it, what its fake does, and the scenarios about it. */
function OpDetails({ op, scenarios }: { op: OpEntry; scenarios: ScenarioEntry[] }) {
  const { mock, phrases } = op;
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
      {mock && (
        <Section title="Mock">
          <div>
            <p className="text-muted-foreground">Called with</p>
            <Json value={mock.input} />
            {"error" in mock ? (
              <p className="mt-2">
                Fails with <code>{mock.error}</code>
              </p>
            ) : (
              <>
                <p className="mt-2 text-muted-foreground">Returns</p>
                <Json value={mock.output} />
              </>
            )}
          </div>
        </Section>
      )}
      <Section title="Scenarios">
        {scenarios.length === 0 ? (
          <None />
        ) : (
          <ul className="flex flex-col gap-1">
            {scenarios.map((s) => {
              const roles = scenarioRoles(s.steps, (id) => id === op.id);
              return (
                <li key={s.name} className="flex flex-wrap items-center gap-1.5">
                  <Link
                    to="/workflows/$name"
                    params={{ name: s.workflow }}
                    search={{ scenario: s.name }}
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
};

/** A link off the app, in a new tab, which its icon says. */
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button asChild variant="link" size="sm">
      <a href={href} target="_blank" rel="noreferrer">
        {children}
        <ExternalLinkIcon data-icon="inline-end" />
      </a>
    </Button>
  );
}
