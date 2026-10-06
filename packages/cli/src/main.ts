#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  type Driver,
  lintWorkflow,
  type RunSummary,
  SanomaClient,
  startWorker,
  type WorkflowDefinition,
} from "@sanoma/workflows";

interface ProjectConfig {
  workflows: WorkflowDefinition<any, any>[];
  drivers: Driver[];
  appName?: string;
}

// DBOS's Postgres driver warns about its own query pattern on every connection; it isn't actionable here.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (!(w.name === "DeprecationWarning" && w.message.includes("client.query()"))) console.warn(`${w.name}: ${w.message}`);
});

const HELP = `sanoma: business processes as code

Usage:
  sanoma worker                         run workflows; recovers interrupted runs on start
  sanoma run <workflow> [--input f.json] [--set key=value ...]
                                        start a run (values like +2m become a time from now)
  sanoma runs                           list recent runs and their approvals
  sanoma show <run-id>                  steps and approvals of one run
  sanoma approve <run-id> --as <name> [--note text]
  sanoma reject <run-id> --as <name> [--note text]
  sanoma lint <file.ts ...>             check workflow files are safe to replay

Options:
  --config <path>   project config (default: ./sanoma.config.ts)

Environment:
  SANOMA_DATABASE_URL   Postgres for the runtime (default: postgresql://postgres:dbos@localhost:5433/sanoma)
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", default: "sanoma.config.ts" },
    input: { type: "string" },
    set: { type: "string", multiple: true },
    as: { type: "string" },
    note: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const databaseUrl = process.env.SANOMA_DATABASE_URL ?? "postgresql://postgres:dbos@localhost:5433/sanoma";
const [command, ...args] = positionals;

async function loadConfig(): Promise<ProjectConfig> {
  const path = resolve(values.config!);
  const mod = await import(pathToFileURL(path).href);
  return mod.default as ProjectConfig;
}

async function withClient<T>(fn: (client: SanomaClient, config: ProjectConfig) => Promise<T>) {
  const config = await loadConfig();
  const client = await SanomaClient.connect(databaseUrl, config.appName);
  try {
    return await fn(client, config);
  } finally {
    await client.close();
  }
}

function parseValue(raw: string): unknown {
  const rel = /^\+(\d+)(s|m|h|d)$/.exec(raw);
  if (rel) {
    const unit = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[rel[2] as "s" | "m" | "h" | "d"];
    return new Date(Date.now() + Number(rel[1]) * unit).toISOString();
  }
  return raw;
}

function time(ms?: number) {
  return ms ? new Date(ms).toLocaleString() : "";
}

function printRun(r: RunSummary) {
  console.log(`${r.runId}  ${r.workflow}  ${r.status}  ${time(r.createdAt)}`);
  for (const a of r.approvals) {
    const who = a.status === "pending" ? `waiting for ${a.approver}` : `${a.status} by ${a.decidedBy}`;
    console.log(`  ${a.id}  "${a.title}"  ${who}${a.refused.length ? `  (ignored: ${a.refused.map((x) => x.by).join(", ")})` : ""}`);
  }
  if (r.error) console.log(`  error: ${r.error}`);
}

async function main() {
  if (values.help || !command) return console.log(HELP);
  switch (command) {
    case "worker": {
      const config = await loadConfig();
      const worker = await startWorker({ ...config, databaseUrl });
      console.log(`worker running ${config.workflows.map((w) => w.name).join(", ")}; Ctrl-C to stop`);
      const stop = async () => {
        await worker.stop();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return new Promise(() => {});
    }
    case "run": {
      const [name] = args;
      if (!name) throw new Error("usage: sanoma run <workflow>");
      return withClient(async (client, config) => {
        const wf = config.workflows.find((w) => w.name === name);
        if (!wf) throw new Error(`No workflow "${name}". Known: ${config.workflows.map((w) => w.name).join(", ")}`);
        const input: Record<string, unknown> = values.input ? JSON.parse(readFileSync(values.input, "utf8")) : {};
        for (const pair of values.set ?? []) {
          const i = pair.indexOf("=");
          if (i < 1) throw new Error(`--set expects key=value, got "${pair}"`);
          input[pair.slice(0, i)] = parseValue(pair.slice(i + 1));
        }
        const runId = await client.start(wf, input);
        console.log(runId);
      });
    }
    case "runs":
      return withClient(async (client) => {
        const runs = await client.runs();
        if (!runs.length) console.log("no runs yet");
        runs.forEach(printRun);
      });
    case "show": {
      const [runId] = args;
      if (!runId) throw new Error("usage: sanoma show <run-id>");
      return withClient(async (client) => {
        const run = await client.run(runId);
        if (!run) throw new Error(`No run ${runId}`);
        printRun(run);
        for (const s of await client.steps(runId)) {
          const out = s.error ? `error: ${s.error}` : JSON.stringify(s.output);
          console.log(`  · ${s.name}  ${out ?? ""}`);
        }
      });
    }
    case "approve":
    case "reject": {
      const [runId] = args;
      if (!runId || !values.as) throw new Error(`usage: sanoma ${command} <run-id> --as <name>`);
      return withClient(async (client) => {
        const decision = command === "approve" ? "approve" : "reject";
        const target = await client.decide(runId, { decision, by: values.as!, note: values.note });
        console.log(`sent ${decision} for "${target.title}" as ${values.as}; the run accepts it only from ${target.approver}`);
      });
    }
    case "lint": {
      let failed = 0;
      for (const file of args) {
        const problems = lintWorkflow(readFileSync(file, "utf8"), file);
        for (const p of problems) console.log(`${file}:${p.line}:${p.column}  ${p.message}`);
        failed += problems.length;
      }
      if (failed) process.exitCode = 1;
      else console.log(`${args.length} workflow file(s) ok`);
      return;
    }
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
