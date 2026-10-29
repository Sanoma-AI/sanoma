// The board still's page (`board.png`) and the demo's start: the clients by where their invoice is.
import { createFileRoute } from "@tanstack/react-router";
import { api, type Saved, useNavigate, useRouter } from "sanoma/site";
import { Button, Card, CardDescription, CardFooter, CardHeader, CardTitle, PageHeader, Region } from "sanoma/ui";

export const Route = createFileRoute("/sites/clients/")({
  loader: () => api.data.clients.list({ order: "client" }),
  component: Board,
});

type Client = Awaited<ReturnType<typeof api.data.clients.list>>[number] extends Saved<infer R> ? R : never;

const COLUMNS: [Client["invoice"], string][] = [
  ["to send", "To send"],
  ["sent", "Sent"],
  ["paid", "Paid"],
];

function Board() {
  const clients = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();

  /** Starts the invoice workflow for the client and opens its run. */
  async function send(client: string) {
    const { runId } = await api.invoice.start({ client });
    await navigate({ to: "/runs/$id", params: { id: runId } });
  }

  async function paid(client: Client) {
    await api.data.clients.save({ record: { ...client, invoice: "paid" } });
    await router.invalidate();
  }

  return (
    <>
      <PageHeader title="Clients" />
      <div className="grid gap-6 md:grid-cols-3">
        {COLUMNS.map(([invoice, title]) => (
          <Region key={invoice} title={title}>
            {clients
              .filter(({ record }) => record.invoice === invoice)
              .map(({ record: client }) => (
                <Card key={client.client} size="sm">
                  <CardHeader>
                    <CardTitle>{client.client}</CardTitle>
                    <CardDescription>
                      {client.dog} · {client.walks} walks · ${client.walks * client.rate}
                    </CardDescription>
                  </CardHeader>
                  {invoice !== "paid" && (
                    <CardFooter>
                      {invoice === "to send" ? (
                        <Button size="sm" onClick={() => send(client.client)}>
                          Send invoice
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => paid(client)}>
                          Mark paid
                        </Button>
                      )}
                    </CardFooter>
                  )}
                </Card>
              ))}
          </Region>
        ))}
      </div>
    </>
  );
}
