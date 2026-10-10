import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type CredentialStatus, credentialReady } from "@sanoma/workflows/shared";
import { ChevronRightIcon } from "lucide-react";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "#/components/ui/item.tsx";
import { Nothing, PageHeader, plural, VendorLogo } from "../../components/common.tsx";
import { configQuery, connectorsOf } from "../../queries.ts";

export const Route = createFileRoute("/connectors/")({
  // The root route loads the config.
  component: ConnectorsPage,
});

/** Every vendor the config's operations are from, one row each, linking to its page. */
function ConnectorsPage() {
  const { data: connectors } = useSuspenseQuery({ ...configQuery(), select: connectorsOf });
  return (
    <div className="flex flex-col gap-6">
      <PageHeader />
      {connectors.length === 0 ? (
        <Nothing title="This config has no connectors" />
      ) : (
        // Each Item is the link itself, which cannot also be a listitem: a <ul>, not an ItemGroup.
        <ul className="flex flex-col gap-2">
          {connectors.map(({ id, vendor, ops, workflows }) => (
            <li key={id}>
              <Item asChild variant="outline">
                <Link to="/connectors/$vendor" params={{ vendor: id }}>
                  <ItemMedia>
                    {/* Decorative: the title beside it names the link. */}
                    <VendorLogo vendor={id} alt="" className="size-6" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>
                      {vendor.title}
                      <code className="font-normal text-muted-foreground">{id}</code>
                    </ItemTitle>
                    <ItemDescription>
                      {plural(ops.length, "operation")} · used by {plural(workflows.length, "workflow")}
                      {vendor.credentials && ` · ${configured(vendor.credentials)}`}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <ChevronRightIcon className="size-4" />
                  </ItemActions>
                </Link>
              </Item>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Whether the drivers' environment variables are all ready, or how many are not. */
function configured(credentials: CredentialStatus[]) {
  const needs = credentials.filter((c) => !credentialReady(c)).length;
  return needs ? `needs ${plural(needs, "variable")}` : "configured";
}
