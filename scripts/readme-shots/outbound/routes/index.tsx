// The board still's page (`board.png`): the outbound leads by stage, read from the collection.
import { createFileRoute } from "@tanstack/react-router";
import { api, type Saved, useRouter } from "sanoma/site";
import { Badge, Button, Card, CardDescription, CardFooter, CardHeader, CardTitle, PageHeader, Region } from "sanoma/ui";

export const Route = createFileRoute("/sites/outbound/")({
  loader: () => api.data.outbound.list({ order: "company" }),
  component: Board,
});

type Lead = Awaited<ReturnType<typeof api.data.outbound.list>>[number] extends Saved<infer R> ? R : never;
type Stage = Lead["stage"];

const STAGES: Stage[] = ["researched", "contacted", "replied", "meeting", "won"];
/** Where a lead's button moves it. */
const NEXT: Partial<Record<Stage, Stage>> = {
  researched: "contacted",
  contacted: "replied",
  replied: "meeting",
  meeting: "won",
};

function Board() {
  const leads = Route.useLoaderData();
  const router = useRouter();

  async function move(lead: Lead, stage: Stage) {
    await api.data.outbound.save({ record: { ...lead, stage } });
    await router.invalidate();
  }

  return (
    <>
      <PageHeader title="Outbound" />
      <div className="grid gap-6 md:grid-cols-5">
        {STAGES.map((stage) => (
          <Region key={stage} title={stage}>
            {leads
              .filter((lead) => lead.record.stage === stage)
              .map(({ record: lead }) => {
                const next = NEXT[stage];
                return (
                  <Card key={lead.company} size="sm">
                    <CardHeader>
                      <CardTitle>{lead.company}</CardTitle>
                      <CardDescription>
                        {lead.contact} · <Badge variant="outline">{lead.owner}</Badge>
                      </CardDescription>
                      {lead.seats && <CardDescription>{lead.seats} seats</CardDescription>}
                    </CardHeader>
                    {next && (
                      <CardFooter>
                        <Button size="sm" variant="outline" onClick={() => move(lead, next)}>
                          Move to {next}
                        </Button>
                      </CardFooter>
                    )}
                  </Card>
                );
              })}
          </Region>
        ))}
      </div>
    </>
  );
}
