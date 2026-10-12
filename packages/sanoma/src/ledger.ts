import { SanomaClient, type SanomaConfig } from "@sanoma/workflows";

/**
 * A run's ledger records, as JSON lines: one `JSON.stringify(record)` per line, in `seq` order,
 * the shape `jsonlLedger` keeps its files in. Read through a client, so from the config's store,
 * or the Postgres one on its database when it gives none. Empty for a run with no records.
 */
export async function exportLedger(config: SanomaConfig, runId: string): Promise<string> {
  const client = await SanomaClient.connect(config);
  try {
    const records = await client.ledger(runId);
    return records.map((record) => `${JSON.stringify(record)}\n`).join("");
  } finally {
    await client.close();
  }
}
