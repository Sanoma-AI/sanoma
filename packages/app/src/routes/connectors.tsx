import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card.tsx";
import { ItemGroup } from "#/components/ui/item.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import { None, Nothing, OpItem, PageHeader, pageTitle, Section, VendorLogo } from "../components/common.tsx";
import { type ConnectorEntry, configQuery, connectorsOf } from "../queries.ts";

export const Route = createFileRoute("/connectors")({
  // The root route loads the config.
  staticData: { crumb: "Connectors" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
  component: ConnectorsPage,
});

/** Every vendor the config's operations are from: where its connector lives, its resource types, its operations and who uses them. */
function ConnectorsPage() {
  const { data: connectors } = useSuspenseQuery({ ...configQuery(), select: connectorsOf });
  return (
    <div className="flex flex-col gap-6">
      <PageHeader />
      {connectors.length === 0 && <Nothing title="This config has no connectors" />}
      <div className="grid gap-4 lg:grid-cols-2">
        {connectors.map((connector) => (
          <ConnectorCard key={connector.id} connector={connector} />
        ))}
      </div>
    </div>
  );
}

function ConnectorCard({ connector: { id, vendor, ops, workflows, resourceTypes } }: { connector: ConnectorEntry }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="flex items-center gap-2">
          {/* Decorative: the title beside it names the heading, which would otherwise read "Resend Resend". */}
          <VendorLogo vendor={id} alt="" className="size-6" />
          {vendor.title}
        </CardTitle>
        <CardDescription>
          <code>{id}</code>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {(vendor.package || vendor.homepage) && (
          // The links' text lines up with the card's: a link button pads its text side by 2.5.
          <div className="-ml-2.5 flex flex-wrap">
            {vendor.package && (
              <ExternalLink href={`https://www.npmjs.com/package/${vendor.package}`}>{vendor.package}</ExternalLink>
            )}
            {vendor.homepage && <ExternalLink href={vendor.homepage}>Source</ExternalLink>}
          </div>
        )}
        {resourceTypes.length > 0 && (
          <p>
            <span className="text-muted-foreground">Resources: </span>
            {resourceTypes.map((r) => r.title).join(", ")}
          </p>
        )}
        <Section title="Operations">
          {ops.length === 0 ? (
            <None />
          ) : (
            <ItemGroup>
              {ops.map((op) => (
                <OpItem key={op.id} id={op.id} op={op} />
              ))}
            </ItemGroup>
          )}
        </Section>
        <Separator />
        <Section title="Used by">
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
        </Section>
      </CardContent>
    </Card>
  );
}

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
