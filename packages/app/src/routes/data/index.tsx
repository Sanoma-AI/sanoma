import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "#/components/ui/item.tsx";
import { LinkItem, Nothing, PageHeader, plural } from "../../components/common.tsx";
import { configQuery } from "../../queries.ts";

export const Route = createFileRoute("/data/")({ component: DataPage });

/** Every collection of the config, one row each, linking to its grid. */
function DataPage() {
  const { data: collections } = useSuspenseQuery({ ...configQuery(), select: (config) => config.collections });
  return (
    <>
      <PageHeader />
      {collections.length === 0 ? (
        <Nothing title="This config has no collections">
          Declare them in <code>resources/data.ts</code>, each with <code>collection()</code> from{" "}
          <code>sanoma/data</code>.
        </Nothing>
      ) : (
        <ItemGroup>
          {collections.map(({ name, title, key, fields }) => (
            <LinkItem key={name} variant="outline">
              <Link to="/data/$name" params={{ name }}>
                <ItemContent>
                  <ItemTitle>
                    {title ?? name}
                    <code className="font-normal text-muted-foreground">data.{name}</code>
                  </ItemTitle>
                  <ItemDescription>
                    {plural(Object.keys(fields).length, "field")}, found by <code>{key}</code>
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <ChevronRightIcon className="size-4" />
                </ItemActions>
              </Link>
            </LinkItem>
          ))}
        </ItemGroup>
      )}
    </>
  );
}
