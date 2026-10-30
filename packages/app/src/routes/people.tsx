import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ConfigDescription } from "@sanoma-ai/workflows/describe";
import { Card } from "#/components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { CrumbHeader, Nothing, pageTitle } from "../components/common.tsx";
import { configQuery, isPeople } from "../queries.ts";

export const Route = createFileRoute("/people")({
  staticData: { crumb: "People" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
  component: PeoplePage,
});

/** The people, agents and groups the data files declare. */
const selectPeople = (config: ConfigDescription) => config.resources.filter(isPeople);

/** Who may act, as the data files declare them, in a table in one card: each one's name, kind and declaration. */
function PeoplePage() {
  const { data: people } = useSuspenseQuery({ ...configQuery(), select: selectPeople });
  return (
    <>
      <CrumbHeader count={people.length} />
      <Card className="gap-0 py-0">
        {people.length === 0 ? (
          <Nothing className="border-0" title="Nobody is declared">
            Declare people in a data file under <code>resources/</code>, each with <code>sanoma.person()</code> from{" "}
            <code>sanoma/resources</code>.
          </Nothing>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Declared in</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {people.map(({ id, name, type }) => (
                <TableRow key={id}>
                  <TableCell className="font-medium">{name}</TableCell>
                  <TableCell>{type}</TableCell>
                  <TableCell>
                    <Link
                      to="/hosting"
                      search={{ resource: id }}
                      className="font-mono text-xs underline-offset-4 hover:underline"
                    >
                      {id}
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </>
  );
}
