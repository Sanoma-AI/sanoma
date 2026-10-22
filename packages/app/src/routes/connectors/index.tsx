import type { ConfigDescription } from "@sanoma-ai/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type CredentialStatus, credentialReady } from "@sanoma-ai/workflows/shared";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { PlugIcon } from "@phosphor-icons/react/dist/csr/Plug";
import { Suspense } from "react";
import { z } from "zod";
import { Badge } from "#/components/ui/badge.tsx";
import { ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "#/components/ui/item.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "#/components/ui/sheet.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { type AvailableConnector, tierOf } from "../../api.ts";
import {
  ExternalLink,
  LinkItem,
  Logo,
  Nothing,
  Notice,
  PageHeader,
  plural,
  Region,
  VendorLogo,
} from "../../components/common.tsx";
import { availableConnectorsQuery, configQuery, connectorsOf, credentialsQuery } from "../../queries.ts";

export const Route = createFileRoute("/connectors/")({
  // `add` names the available connector whose steps to add it show.
  validateSearch: z.object({ add: z.string().optional() }),
  // The root route loads the config; the statuses are read here. npm is read by the page, so it never holds up the installed ones.
  loader: async ({ context: { queryClient } }) => {
    await queryClient.query({ ...credentialsQuery(), staleTime: "static" });
  },
  component: ConnectorsPage,
});

/** The installed connectors, one row each linking to its page; then the ones on npm, each with how to add it. */
function ConnectorsPage() {
  return (
    <>
      <PageHeader />
      <Region title="Installed">
        <Installed />
      </Region>
      <Region title="Available">
        <Suspense fallback={<Skeleton className="h-16 w-full" />}>
          <Available />
        </Suspense>
      </Region>
    </>
  );
}

/** Every vendor the config's operations are from. */
function Installed() {
  const { data: connectors } = useSuspenseQuery({ ...configQuery(), select: connectorsOf });
  const { data: credentials } = useSuspenseQuery(credentialsQuery());
  if (connectors.length === 0) return <Nothing title="This config has no connectors" />;
  return (
    <ItemGroup>
      {connectors.map(({ id, vendor, ops, workflows }) => (
        <LinkItem key={id} variant="outline">
          <Link to="/connectors/$vendor" params={{ vendor: id }}>
            <ItemMedia>
              {/* Decorative: the title beside it names the link. */}
              <VendorLogo vendor={id} alt="" className="size-6" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {vendor.title}
                <code className="font-normal text-muted-foreground">{id}</code>
                {vendor.package && <TierBadge pkg={vendor.package} />}
              </ItemTitle>
              <ItemDescription>
                {plural(ops.length, "operation")} · used by {plural(workflows.length, "workflow")}
                {credentials[id] && ` · ${configured(credentials[id])}`}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <CaretRightIcon aria-hidden="true" className="size-4" />
            </ItemActions>
          </Link>
        </LinkItem>
      ))}
    </ItemGroup>
  );
}

/** The connectors on npm the config does not install; the chosen one's steps to add it in a sheet. */
function Available() {
  const { data: installed } = useSuspenseQuery({ ...configQuery(), select: installedPackages });
  const { data } = useSuspenseQuery(availableConnectorsQuery());
  const connectors = data.connectors.filter((c) => !installed.has(c.package));
  const { add } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const chosen = connectors.find((c) => c.package === add);
  return (
    <>
      {data.error && <Notice>npm could not be reached, so only the installed connectors show. {data.error}</Notice>}
      {!data.error && connectors.length === 0 && <Nothing title="No other connectors found on npm" />}
      {connectors.length > 0 && (
        <ItemGroup>
          {connectors.map((c) => (
            <LinkItem key={c.package} variant="outline">
              <Link to="." search={{ add: c.package }} aria-current={c.package === add ? "page" : undefined}>
                <ItemMedia>
                  <ConnectorLogo connector={c} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {c.title}
                    <code className="font-normal text-muted-foreground">{c.package}</code>
                    <TierBadge pkg={c.package} />
                  </ItemTitle>
                  <ItemDescription>
                    {c.description ? `${c.description} · ` : ""}v{c.version}
                  </ItemDescription>
                </ItemContent>
              </Link>
            </LinkItem>
          ))}
        </ItemGroup>
      )}
      <Sheet open={chosen !== undefined} onOpenChange={(open) => !open && void navigate({ search: {} })}>
        <SheetContent>{chosen && <AddSteps connector={chosen} />}</SheetContent>
      </Sheet>
    </>
  );
}

/**
 * How to add a connector: install the package, import it in the config, set its credentials. The
 * README has the exact import, as npm does not say what the package exports.
 */
function AddSteps({ connector: c }: { connector: AvailableConnector }) {
  const readme = `https://www.npmjs.com/package/${c.package}`;
  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          <ConnectorLogo connector={c} />
          {c.title}
          <TierBadge pkg={c.package} />
        </SheetTitle>
        <SheetDescription>
          <code>{c.package}</code> v{c.version}
          {c.description && <> · {c.description}</>}
        </SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-4 px-4">
        <div className="flex flex-wrap gap-1">
          <ExternalLink href={readme}>README</ExternalLink>
          {c.homepage && <ExternalLink href={c.homepage}>Source</ExternalLink>}
        </div>
        <ol className="flex list-decimal flex-col gap-3 pl-5">
          <li>
            Install the package in the company's repository:
            <pre className="mt-1 overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
              <code>pnpm add {c.package}</code>
            </pre>
          </li>
          <li>
            Import it in <code>sanoma.config.ts</code> and add it to <code>connectors: [...]</code>. Its README shows
            the import.
          </li>
          <li>
            Restart <code>sanoma</code>, then set its credentials on its page under Installed.
          </li>
        </ol>
      </div>
    </>
  );
}

/** The npm packages the config's connectors are from. */
const installedPackages = (config: ConfigDescription) =>
  new Set(Object.values(config.vendors).flatMap((v) => (v.package ? [v.package] : [])));

/** An available connector's logo, decorative beside its title; a plug when it has none. */
function ConnectorLogo({ connector: { logo } }: { connector: AvailableConnector }) {
  return logo ? (
    <Logo {...logo} alt="" className="size-6" />
  ) : (
    <PlugIcon aria-hidden="true" className="size-6 text-muted-foreground" />
  );
}

/** Whose a connector package is: Sanoma's own, or the community's. */
function TierBadge({ pkg }: { pkg: string }) {
  const tier = tierOf(pkg);
  return (
    <Badge variant={tier === "official" ? "secondary" : "outline"}>
      {tier === "official" ? "Official" : "Community"}
    </Badge>
  );
}

/** Whether the drivers' environment variables are all ready, or how many are not. */
function configured(credentials: CredentialStatus[]) {
  const needs = credentials.filter((c) => !credentialReady(c)).length;
  return needs ? `needs ${plural(needs, "variable")}` : "configured";
}
