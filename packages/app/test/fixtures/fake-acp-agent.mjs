// A fake ACP agent for acp.test.ts, on the SDK's agent side, over stdio: what a person's own coding
// agent does, scripted, with no vendor account. Started as `node fake-acp-agent.mjs <config> ...args`
// by the bin acp.test.ts plants in an agent's install. `<config>` (JSON, read at each start) says:
//   signIn: "terminal" | "url" | "once" | "none" — how it asks to be signed in until `$HOME/.signed-in-<agent>` exists
//   mode: "work" | "hello" | "die" | "hang" — what a prompt does
//   code: the code its terminal sign-in takes on stdin; log: where it appends what it saw (JSON lines)
//   method: its terminal sign-in's id (default "fake-login"); loginFails: what its sign-in prints as it fails at once
// With `login` among its arguments it is its own terminal sign-in instead.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const [configPath, ...args] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const log = (entry) => appendFileSync(config.log, `${JSON.stringify(entry)}\n`);
/** Where its vendor's sign-in would keep the person's token: in their HOME, by the agent (its install's name). */
const signedIn = join(process.env.HOME, `.signed-in-${basename(dirname(configPath))}`);

if (args.includes("login")) {
  // The vendor's sign-in, as a device flow prints it without a terminal: a link, a code, a prompt.
  log({ login: args });
  if (config.loginFails) {
    process.stdout.write(`${config.loginFails}\n`);
    process.exit(1);
  }
  process.stdout.write("To authenticate, visit https://example.test/login/device and enter code FAKE-0001\n");
  process.stdout.write("Paste code here if prompted > ");
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const ok = line.trim() === config.code;
    if (ok) writeFileSync(signedIn, "yes\n");
    process.stdout.write(ok ? "\nSigned in.\n" : "\nThat code is wrong.\n");
    process.exit(ok ? 0 : 1);
  }
  process.exit(2);
}

log({ start: args, home: process.env.HOME, env: Object.keys(process.env).toSorted(), path: process.env.PATH });

const authMethods =
  config.signIn === "terminal"
    ? [{ id: config.method ?? "fake-login", name: "Fake login", type: "terminal", args: ["login"] }]
    : config.signIn === "url"
      ? [{ id: "fake-device", name: "Fake device code" }]
      : [];
const needsSignIn = () => config.signIn !== "none" && !existsSync(signedIn);
const signInRequired = () => new acp.RequestError(-32000, "Authentication required", { authMethods });

/** Permission for `toolCall`, offering `kinds`; the outcome, logged. */
async function ask(client, sessionId, toolCall, kinds) {
  const options = kinds.map((kind) => ({ optionId: `opt-${kind}`, name: kind, kind }));
  const { outcome } = await client.request("session/request_permission", { sessionId, toolCall, options });
  const chosen =
    outcome.outcome === "selected" ? options.find((o) => o.optionId === outcome.optionId)?.kind : "cancelled";
  log({ asked: toolCall.title, chosen });
  return chosen;
}

/** Each prompt under way's way to stop, called by `session/cancel`. */
const cancels = new Set();

const update = (client, sessionId, change) => client.notify("session/update", { sessionId, update: change });

/** "Add a laptop step to offboarding", as a coding agent does it over ACP. */
async function work(client, sessionId, cwd) {
  const file = join(cwd, "workflows/offboarding.ts");
  await update(client, sessionId, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "Reading the workflow." },
  });
  await update(client, sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "read",
    title: "Read workflows/offboarding.ts",
    kind: "read",
    status: "pending",
    locations: [{ path: file }],
  });
  const { content } = await client.request("fs/read_text_file", { sessionId, path: file });
  await update(client, sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "read",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: content.split("\n")[0] } }],
  });

  // A write under node_modules, asked for and written directly: both refused.
  const evil = {
    toolCallId: "evil",
    title: "Write node_modules/evil.js",
    kind: "edit",
    locations: [{ path: join(cwd, "node_modules/evil.js") }],
  };
  await update(client, sessionId, { sessionUpdate: "tool_call", ...evil, status: "pending" });
  const evilChosen = await ask(client, sessionId, evil, ["allow_once", "allow_always", "reject_once"]);
  await update(client, sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "evil",
    status: evilChosen === "allow_once" ? "completed" : "failed",
  });
  try {
    await client.request("fs/write_text_file", {
      sessionId,
      path: join(cwd, "node_modules/evil.js"),
      content: "throw 1;\n",
    });
    log({ wroteOutside: true });
  } catch (err) {
    log({ wroteOutside: false, error: err.message });
  }

  // Another person's home, beside its own, read through the client: refused, as outside the draft.
  try {
    const other = join(dirname(process.env.HOME), "lead", ".credentials.json");
    const { content: read } = await client.request("fs/read_text_file", { sessionId, path: other });
    log({ readOther: read });
  } catch (err) {
    log({ readOther: false, error: err.message });
  }

  // A command it asks for: refused. One it runs through the client's terminal: its own.
  const shell = { toolCallId: "shell", title: "cat /etc/hosts", kind: "execute" };
  await update(client, sessionId, { sessionUpdate: "tool_call", ...shell, status: "pending" });
  const shellChosen = await ask(client, sessionId, shell, ["allow_once", "allow_always", "reject_once"]);
  await update(client, sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "shell",
    status: shellChosen === "allow_once" ? "completed" : "failed",
  });
  const { terminalId } = await client.request("terminal/create", {
    sessionId,
    // What it leaves running holds the output's pipes: its exit is still seen.
    command: 'echo "home=$HOME token=${GH_TOKEN:-none}"; pwd; sleep 300 &',
  });
  const exit = await client.request("terminal/wait_for_exit", { sessionId, terminalId });
  const { output } = await client.request("terminal/output", { sessionId, terminalId });
  await client.request("terminal/release", { sessionId, terminalId });
  log({ terminal: output, exit });

  // The edit, asked for with allow_always first: allowed once, then written through the client.
  const edit = {
    toolCallId: "edit",
    title: "Edit workflows/offboarding.ts",
    kind: "edit",
    locations: [{ path: file }],
  };
  await update(client, sessionId, { sessionUpdate: "tool_call", ...edit, status: "pending", rawInput: { path: file } });
  const editChosen = await ask(client, sessionId, edit, ["allow_always", "allow_once", "reject_once"]);
  // An edit offered only for always: never chosen.
  await ask(
    client,
    sessionId,
    { toolCallId: "always", title: "Edit always", kind: "edit", locations: [{ path: file }] },
    ["allow_always", "reject_always"],
  );
  if (editChosen === "allow_once") {
    const changed = content.replace(
      "`Removed ${person}'s accounts`",
      "`Removed ${person}'s accounts`, `Collected ${person}'s laptop`",
    );
    await client.request("fs/write_text_file", { sessionId, path: file, content: changed });
  }
  await update(client, sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "edit",
    status: "completed",
    content: [{ type: "diff", path: file, oldText: content, newText: "…" }],
  });
  await update(client, sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Drafted: offboarding now collects the laptop." },
  });
  return { stopReason: "end_turn" };
}

const app = acp
  .agent({ name: "fake" })
  .onRequest("initialize", ({ params }) => {
    log({ initialize: params.clientCapabilities });
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods };
  })
  .onRequest("authenticate", async ({ params, client }) => {
    log({ authenticate: params.methodId });
    if (config.signIn !== "url") return {};
    const { action } = await client.request("elicitation/create", {
      mode: "url",
      requestId: 1,
      elicitationId: "fake",
      url: "https://example.test/device",
      message: "Sign in and enter this code: FAKE-0002",
    });
    log({ elicitation: action });
    // The person finishes on the vendor's page: acp.test.ts writes the file the vendor would.
    while (!existsSync(`${configPath}.finished`)) await new Promise((done) => setTimeout(done, 50));
    writeFileSync(signedIn, "yes\n");
    return {};
  })
  .onRequest("session/new", ({ params }) => {
    if (needsSignIn()) throw signInRequired();
    log({ session: params.cwd });
    return { sessionId: `fake-${Date.now()}` };
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    const text = params.prompt.map((block) => block.text ?? "").join("");
    log({ prompt: text });
    if (config.mode === "die") {
      // Mid-step: the step it started never ends.
      await update(client, params.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "cut",
        title: "Read workflows/offboarding.ts",
        kind: "read",
        status: "in_progress",
      });
      process.stderr.write("the fake agent fell over\n");
      process.exit(3);
    }
    if (config.mode === "hang") {
      await new Promise((done) => cancels.add(done));
      return { stopReason: "cancelled" };
    }
    if (config.mode === "hello") {
      await update(client, params.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello." },
      });
      return { stopReason: "end_turn" };
    }
    return work(client, params.sessionId, process.cwd());
  })
  .onNotification("session/cancel", ({ params }) => {
    log({ cancel: params.sessionId });
    for (const cancel of cancels) cancel();
  });

app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
