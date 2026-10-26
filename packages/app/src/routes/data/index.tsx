import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Card } from "#/components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { ButtonLink, CrumbHeader, Nothing } from "../../components/common.tsx";
import { LinkRow } from "../../components/runs-table.tsx";
import { useSites } from "#/lib/sites.ts";
import { configQuery } from "../../queries.ts";

export const Route = createFileRoute("/data/")({ component: DataPage });

/**
 * Every collection of the config, with how many there are, as a table in one card: a row opens its
 * grid. With sites, the header leads to the Sites page, which the bar has no tile for.
 */
function DataPage() {
  const { data: collections } = useSuspenseQuery({ ...configQuery(), select: (config) => config.collections });
  const sites = useSites().length > 0;
  return (
    <>
      <CrumbHeader
        count={collections.length}
        action={
          sites && (
            <ButtonLink variant="outline" size="sm">
              <Link to="/sites">Sites</Link>
            </ButtonLink>
          )
        }
      />
      <Card className="gap-0 py-0">
        {collections.length === 0 ? (
          <Nothing className="border-0" title="This config has no collections">
            Declare them in <code>resources/data.ts</code>, each with <code>collection()</code> from{" "}
            <code>sanoma/data</code>.
          </Nothing>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Collection</TableHead>
                <TableHead>Fields</TableHead>
                <TableHead>Found by</TableHead>
                <TableHead>Declared in</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {collections.map(({ name, title, key, fields, declared }) => (
                <LinkRow key={name} link={{ to: "/data/$name", params: { name } }}>
                  <TableCell className="font-medium">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to="/data/$name" params={{ name }} onClick={(e) => e.stopPropagation()}>
                        {title ?? name}
                      </Link>
                      <code className="text-xs font-normal text-muted-foreground">data.{name}</code>
                    </div>
                  </TableCell>
                  <TableCell className="tabular-nums">{Object.keys(fields).length}</TableCell>
                  <TableCell>
                    <code>{key}</code>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {declared ? <code className="text-xs">{declared.id}</code> : "-"}
                  </TableCell>
                </LinkRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </>
  );
}
